/**
 * Print Enforcer Service
 *
 * Ensures ALL printing on the machine goes through SecurePrint.
 *
 * Capabilities:
 *   1. Print Spooler Monitor — subscribes to native Windows printer change notifications,
 *      holds every new job, resumes SecurePrint's own jobs, deletes everything else, and
 *      warns the user (blocked attempts are also reported to the server).
 *   2. (Not used for USB printers) Direct-IP port blocking helpers are kept but not enabled.
 *   3. Printer Lockdown — hides/disables printers not approved by SecurePrint.
 *
 * The enforcer runs in the Electron main process with a persistent PowerShell event watcher.
 * It requires administrator privileges for firewall rules.
 */

const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// Jobs SecurePrint itself has just sent to a printer. Key = exact document name (lowercase).
// Each approval is bound to one printer (when known), works for a few jobs only, and expires.
const approvedJobs = new Map();
const APPROVAL_LIFETIME_MS = 60000;
const APPROVAL_MAX_JOBS = 3; // SecurePrint tries a print up to 3 times
let blockedPrintNotificationHandler = null;
let blockedAttemptHandler = null;
let protectionAlertHandler = null;
let launchMode = 'inline'; // 'inline' = no script file on disk, 'file' = fallback
let consecutiveMonitorFailures = 0;
let channelVerified = false;
let channelFailures = 0;
let channelCheckTimer = null;
const CHANNEL_CHECK_MS = 5000;
const MONITOR_FAILURES_BEFORE_ALERT = 3;
const MAX_COMMAND_LINE_CHARS = 30000; // Windows refuses command lines above 32,767 characters
let monitorProcess = null;
let isMonitoring = false;
let monitorReady = false;
let printerSubscriptionsActive = false;
let monitorRestartTimer = null;
let monitorRestartDelay = 1000;
const recentlySeenJobs = new Map();

// Virtual printers never produce paper. SecurePrint tracks PAPER printing only, so these
// printers are not monitored and their jobs are never cancelled.
// They are matched by PORT and DRIVER (not by printer name), so renaming a printer
// does not let it skip blocking. To see a printer's values run:
//   Get-Printer | Select-Object Name, DriverName, PortName
const IGNORED_PRINTER_PORTS = ['PORTPROMPT:', 'SHRFAX:', 'nul:', 'FILE:'];
const IGNORED_PRINTER_DRIVERS = ['Microsoft Print To PDF*', 'Microsoft XPS Document Writer*', '*OneNote*'];

// ─── Whitelist Management ───
//
// SecurePrint calls whitelistJob() with a document name that is UNIQUE and unguessable
// (it contains a random token), right before it sends the job to the printer.
// A job is approved only if ALL of these are true:
//   - its document name EQUALS the approved name, or is a full path that ENDS with it
//     (no partial "contains" matching),
//   - it is on the printer SecurePrint printed to (when a printer was given),
//   - the approval has not expired and still has uses left.

function normalizeDocumentName(name) {
  return String(name || '').trim().toLowerCase().replace(/\//g, '\\');
}

function pruneApprovals(now = Date.now()) {
  for (const [key, approval] of approvedJobs) {
    if (approval.expiresAt <= now || approval.usesLeft <= 0) approvedJobs.delete(key);
  }
}

function whitelistJob(documentName, options = {}) {
  const key = normalizeDocumentName(documentName);
  if (!key) return;
  const maxJobs = Number.isInteger(options.maxJobs) && options.maxJobs > 0 ? options.maxJobs : APPROVAL_MAX_JOBS;
  const lifetimeMs = Number.isInteger(options.lifetimeMs) && options.lifetimeMs > 0 ? options.lifetimeMs : APPROVAL_LIFETIME_MS;
  approvedJobs.set(key, {
    printer: options.printer ? String(options.printer).trim().toLowerCase() : null,
    usesLeft: maxJobs,
    expiresAt: Date.now() + lifetimeMs
  });
  console.log('[PrintEnforcer] Approved job:', key, options.printer ? `(printer: ${options.printer})` : '(any printer)');
  const timer = setTimeout(() => pruneApprovals(), lifetimeMs + 50);
  if (timer.unref) timer.unref();
}

function removeWhitelistedJob(documentName) {
  approvedJobs.delete(normalizeDocumentName(documentName));
}

function findApproval(documentName, printerName) {
  const docKey = normalizeDocumentName(documentName);
  if (!docKey) return null;
  pruneApprovals();
  const printerKey = String(printerName || '').trim().toLowerCase();
  for (const [key, approval] of approvedJobs) {
    const nameMatches = docKey === key || docKey.endsWith('\\' + key);
    if (!nameMatches) continue;
    if (approval.printer && printerKey && approval.printer !== printerKey) continue;
    return key;
  }
  return null;
}

// Checks only (does not use up an approval).
function isJobWhitelisted(documentName, printerName) {
  return findApproval(documentName, printerName) !== null;
}

// Checks AND uses up one job from the approval.
function consumeApproval(documentName, printerName) {
  const key = findApproval(documentName, printerName);
  if (!key) return false;
  const approval = approvedJobs.get(key);
  approval.usesLeft -= 1;
  if (approval.usesLeft <= 0) approvedJobs.delete(key);
  return true;
}

function setBlockedPrintNotificationHandler(handler) {
  if (handler !== null && typeof handler !== 'function') {
    throw new TypeError('Blocked print notification handler must be a function or null.');
  }
  blockedPrintNotificationHandler = handler;
}

// Called for every blocked print attempt: handler({ printer, document, windowsUser, occurredAt }).
function setBlockedAttemptHandler(handler) {
  if (handler !== null && typeof handler !== 'function') {
    throw new TypeError('Blocked attempt handler must be a function or null.');
  }
  blockedAttemptHandler = handler;
}

// Called when print protection itself is not working: handler(message).
function setProtectionAlertHandler(handler) {
  if (handler !== null && typeof handler !== 'function') {
    throw new TypeError('Protection alert handler must be a function or null.');
  }
  protectionAlertHandler = handler;
}

function reportBlockedAttempt(info) {
  if (!blockedAttemptHandler) return;
  try {
    blockedAttemptHandler({ ...info, occurredAt: new Date().toISOString() });
  } catch (error) {
    console.error('[PrintEnforcer] Could not record blocked attempt:', error.message);
  }
}

function raiseProtectionAlert(message) {
  console.error('[PrintEnforcer] PROTECTION ALERT:', message);
  if (!protectionAlertHandler) return;
  try {
    protectionAlertHandler(message);
  } catch (error) {
    console.error('[PrintEnforcer] Could not deliver protection alert:', error.message);
  }
}

// ─── Print Spooler Monitor ───
//
// How blocking works (fast path):
//   1. A persistent PowerShell process holds a native Windows watcher (winspool.drv).
//   2. The moment a new job appears, the watcher PAUSES it inside that same process
//      (no new process is started), so the job cannot print while we decide.
//   3. Node checks the whitelist and sends back RESUME (authorized) or DELETE (unauthorized).
// Fallback: if pausing is not possible, the old behaviour (cancel through a new PowerShell) is used.

function startMonitoring() {
  if (isMonitoring) return;
  if (process.platform !== 'win32') {
    console.log('[PrintEnforcer] Spooler monitoring only supported on Windows.');
    return;
  }

  isMonitoring = true;
  console.log('[PrintEnforcer] Starting print spooler monitor...');
  launchMonitorProcess();
}

function stopMonitoring() {
  isMonitoring = false;
  monitorReady = false;
  printerSubscriptionsActive = false;
  consecutiveMonitorFailures = 0;
  channelFailures = 0;
  channelVerified = false;
  launchMode = 'inline';
  if (channelCheckTimer) {
    clearTimeout(channelCheckTimer);
    channelCheckTimer = null;
  }
  if (monitorRestartTimer) {
    clearTimeout(monitorRestartTimer);
    monitorRestartTimer = null;
  }
  if (monitorProcess) {
    monitorProcess.kill();
    monitorProcess = null;
  }
  console.log('[PrintEnforcer] Spooler monitor stopped.');
}

function cleanupMonitorScript(directory) {
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.error('[PrintEnforcer] Could not remove temporary monitor script:', error.message);
  }
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createMonitorScript() {
  const ignoredPorts = IGNORED_PRINTER_PORTS.map(psQuote).join(',');
  const ignoredDrivers = IGNORED_PRINTER_DRIVERS.map(psQuote).join(',');

  return `
$ErrorActionPreference = 'Stop'
$script:printerNames = @()
$script:spoolerRunning = $false
$script:printerInventory = ''
$script:nextHealthCheck = [DateTime]::UtcNow
$script:ignoredPorts = @(${ignoredPorts})
$script:ignoredDrivers = @(${ignoredDrivers})

function Test-IgnoredPrinter($printer) {
  foreach ($port in $script:ignoredPorts) {
    if ([string]$printer.PortName -eq $port) { return $true }
  }
  foreach ($driver in $script:ignoredDrivers) {
    if ([string]$printer.DriverName -like $driver) { return $true }
  }
  return $false
}

function Send-Message($type, $data) {
  $message = @{ type = $type }
  foreach ($key in $data.Keys) { $message[$key] = $data[$key] }
  [Console]::Out.WriteLine(($message | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Send-Jobs($lines, $source) {
  foreach ($line in $lines) {
    $p = ([string]$line).Split([char]9)
    Send-Message 'job' @{
      source = $source
      printer = $p[0]
      jobId = [int]$p[1]
      docName = $p[2]
      owner = $p[3]
      paused = ($p[4] -eq '1')
    }
  }
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class SecurePrintChangeWatcher {
    private sealed class PrinterWatch {
        public string Name;
        public IntPtr Printer;
        public IntPtr Change;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PRINTER_DEFAULTS {
        public IntPtr pDatatype;
        public IntPtr pDevMode;
        public uint DesiredAccess;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SYSTEMTIME {
        public ushort wYear;
        public ushort wMonth;
        public ushort wDayOfWeek;
        public ushort wDay;
        public ushort wHour;
        public ushort wMinute;
        public ushort wSecond;
        public ushort wMilliseconds;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct JOB_INFO_1 {
        public uint JobId;
        public string pPrinterName;
        public string pMachineName;
        public string pUserName;
        public string pDocument;
        public string pDatatype;
        public string pStatus;
        public uint Status;
        public uint Priority;
        public uint Position;
        public uint TotalPages;
        public uint PagesPrinted;
        public SYSTEMTIME Submitted;
    }

    private static readonly List<PrinterWatch> Watches = new List<PrinterWatch>();
    private static readonly HashSet<string> Seen = new HashSet<string>();
    private static readonly Queue<string> Results = new Queue<string>();
    // Jobs we paused, and jobs SecurePrint approved (resumed on purpose).
    private static readonly HashSet<string> HeldByUs = new HashSet<string>();
    private static readonly HashSet<string> Approved = new HashSet<string>();
    private static bool readerStarted = false;
    private static volatile bool commandsAvailable = false;

    private const uint PrinterChangeAddJob = 0x00000100;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;
    private const uint WaitFailed = 0xFFFFFFFF;
    private const uint PrinterAllAccess = 0x000F000C;
    private const uint JobControlPause = 1;
    private const uint JobControlResume = 2;
    private const uint JobControlDelete = 5;
    // Jobs that are already deleting, deleted, printed or complete are ignored.
    private const uint JobStatusIgnore = 0x00001184;
    private const uint JobStatusPaused = 0x00000001;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinterWithAccess(string name, out IntPtr printer, ref PRINTER_DEFAULTS defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClosePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern IntPtr FindFirstPrinterChangeNotification(IntPtr printer, uint filter, uint options, IntPtr notifyOptions);

    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextPrinterChangeNotification(IntPtr change, out uint changes, IntPtr options, out IntPtr notifyInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClosePrinterChangeNotification(IntPtr change);

    [DllImport("winspool.drv")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreePrinterNotifyInfo(IntPtr notifyInfo);

    [DllImport("winspool.drv", EntryPoint = "EnumJobsW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool EnumJobs(IntPtr printer, uint firstJob, uint noJobs, uint level, IntPtr jobs, uint bufferSize, out uint needed, out uint returned);

    [DllImport("winspool.drv", EntryPoint = "SetJobW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool SetJob(IntPtr printer, uint jobId, uint level, IntPtr jobInfo, uint command);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    // Opens a printer with job-control rights; falls back to normal rights if that is refused.
    private static IntPtr OpenPrinterForControl(string name) {
        IntPtr handle;
        PRINTER_DEFAULTS defaults = new PRINTER_DEFAULTS();
        defaults.pDatatype = IntPtr.Zero;
        defaults.pDevMode = IntPtr.Zero;
        defaults.DesiredAccess = PrinterAllAccess;
        if (OpenPrinterWithAccess(name, out handle, ref defaults)) return handle;
        if (OpenPrinter(name, out handle, IntPtr.Zero)) return handle;
        return IntPtr.Zero;
    }

    public static void Start(string[] names) {
        Stop();
        foreach (string name in names) {
            IntPtr printer = OpenPrinterForControl(name);
            if (printer == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed for " + name);
            IntPtr change = FindFirstPrinterChangeNotification(printer, PrinterChangeAddJob, 0, IntPtr.Zero);
            if (change == InvalidHandle) {
                int error = Marshal.GetLastWin32Error();
                ClosePrinter(printer);
                throw new Win32Exception(error, "Could not subscribe to print-job changes for " + name);
            }
            Watches.Add(new PrinterWatch { Name = name, Printer = printer, Change = change });
        }
    }

    public static int Wait(int milliseconds) {
        if (Watches.Count == 0) return -2;
        int groupCount = (Watches.Count + 63) / 64;
        int groupTimeout = Math.Max(1, milliseconds / groupCount);
        for (int group = 0; group < groupCount; group++) {
            int start = group * 64;
            int count = Math.Min(64, Watches.Count - start);
            IntPtr[] handles = new IntPtr[count];
            for (int i = 0; i < count; i++) handles[i] = Watches[start + i].Change;
            uint result = WaitForMultipleObjects((uint)handles.Length, handles, false, (uint)groupTimeout);
            if (result == WaitTimeout) continue;
            if (result == WaitFailed || result < WaitObject0 || result >= WaitObject0 + handles.Length) return -2;
            return start + (int)(result - WaitObject0);
        }
        return -1;
    }

    public static string Consume(int index) {
        if (index < 0 || index >= Watches.Count) return null;
        uint changes;
        IntPtr info;
        if (!FindNextPrinterChangeNotification(Watches[index].Change, out changes, IntPtr.Zero, out info))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Print change notification failed for " + Watches[index].Name);
        if (info != IntPtr.Zero) FreePrinterNotifyInfo(info);
        return Watches[index].Name;
    }

    private static List<JOB_INFO_1> ListJobs(IntPtr printer) {
        List<JOB_INFO_1> jobs = new List<JOB_INFO_1>();
        uint needed = 0;
        uint returned = 0;
        EnumJobs(printer, 0, 255, 1, IntPtr.Zero, 0, out needed, out returned);
        if (needed == 0) return jobs;
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try {
            uint needed2 = 0;
            if (!EnumJobs(printer, 0, 255, 1, buffer, needed, out needed2, out returned)) return jobs;
            int size = Marshal.SizeOf(typeof(JOB_INFO_1));
            for (int i = 0; i < (int)returned; i++) {
                IntPtr item = new IntPtr(buffer.ToInt64() + (long)i * size);
                jobs.Add((JOB_INFO_1)Marshal.PtrToStructure(item, typeof(JOB_INFO_1)));
            }
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
        return jobs;
    }

    private static string Clean(string value) {
        if (value == null) return "";
        return value.Replace((char)9, ' ').Replace((char)10, ' ').Replace((char)13, ' ');
    }

    // Finds jobs we have not seen yet. If the command channel is working, each new job is
    // PAUSED right here, immediately, so it cannot print while Node decides what to do with it.
    // Each line: printer TAB jobId TAB document TAB owner TAB paused(1/0)
    public static string[] Scan() {
        List<string> found = new List<string>();
        HashSet<string> current = new HashSet<string>();
        char tab = (char)9;
        foreach (PrinterWatch watch in Watches) {
            foreach (JOB_INFO_1 job in ListJobs(watch.Printer)) {
                string key = watch.Name + tab + job.JobId.ToString();
                current.Add(key);
                if ((job.Status & JobStatusIgnore) != 0) { Seen.Add(key); continue; }
                if (Seen.Contains(key)) {
                    // A job we are holding that someone resumed by hand in the Windows print
                    // queue is caught and held again, so it cannot print.
                    bool approved;
                    bool held;
                    lock (Approved) { approved = Approved.Contains(key); }
                    lock (HeldByUs) { held = HeldByUs.Contains(key); }
                    bool resumedByHand = held && !approved && (job.Status & JobStatusPaused) == 0;
                    if (!resumedByHand) continue;
                } else {
                    Seen.Add(key);
                }
                bool paused = false;
                if (commandsAvailable) {
                    paused = SetJob(watch.Printer, job.JobId, 0, IntPtr.Zero, JobControlPause);
                    if (paused) { lock (HeldByUs) { HeldByUs.Add(key); } }
                }
                found.Add(string.Join(tab.ToString(), new string[] {
                    Clean(watch.Name), job.JobId.ToString(), Clean(job.pDocument), Clean(job.pUserName), paused ? "1" : "0"
                }));
            }
        }
        Seen.RemoveWhere(delegate(string k) { return !current.Contains(k); });
        lock (HeldByUs) { HeldByUs.RemoveWhere(delegate(string k) { return !current.Contains(k); }); }
        lock (Approved) { Approved.RemoveWhere(delegate(string k) { return !current.Contains(k); }); }
        return found.ToArray();
    }

    public static void Stop() {
        foreach (PrinterWatch watch in Watches) {
            if (watch.Change != IntPtr.Zero) FindClosePrinterChangeNotification(watch.Change);
            if (watch.Printer != IntPtr.Zero) ClosePrinter(watch.Printer);
        }
        Watches.Clear();
        Seen.Clear();
        lock (HeldByUs) { HeldByUs.Clear(); }
        lock (Approved) { Approved.Clear(); }
    }

    // ---- Command channel: Node writes "RESUME|DELETE TAB printer TAB jobId" lines to stdin ----

    public static void StartCommandReader() {
        if (readerStarted) return;
        readerStarted = true;
        Thread reader = new Thread(new ThreadStart(ReadCommands));
        reader.IsBackground = true;
        reader.Start();
    }

    private static void ReadCommands() {
        // commandsAvailable becomes true only after Node's PING arrives, which proves the
        // command channel really works. Until then jobs are not paused (Node uses its backup).
        try {
            string line;
            while ((line = Console.In.ReadLine()) != null) {
                try { ApplyCommand(line); } catch (Exception) { }
            }
        } catch (Exception) {
        }
        commandsAvailable = false;
    }

    private static void ApplyCommand(string line) {
        if (string.IsNullOrEmpty(line)) return;
        string[] parts = line.Split((char)9);
        if (parts.Length < 3) return;
        string command = parts[0];
        string printerName = parts[1];
        if (command == "PING") {
            commandsAvailable = true;
            lock (Results) { Results.Enqueue("PING" + (char)9 + (char)9 + "0" + (char)9 + "1" + (char)9 + "0"); }
            return;
        }
        uint jobId;
        if (!uint.TryParse(parts[2], out jobId)) return;
        uint control = 0;
        if (command == "DELETE") control = JobControlDelete;
        else if (command == "RESUME") control = JobControlResume;
        if (control == 0) return;

        bool ok = false;
        int error = 0;
        string jobKey = printerName + (char)9 + jobId.ToString();
        // Mark the job approved BEFORE resuming it, so the sweep never re-holds an approved job.
        if (command == "RESUME") { lock (Approved) { Approved.Add(jobKey); } }
        try {
            IntPtr handle = OpenPrinterForControl(printerName);
            if (handle != IntPtr.Zero) {
                ok = SetJob(handle, jobId, 0, IntPtr.Zero, control);
                if (!ok) error = Marshal.GetLastWin32Error();
                ClosePrinter(handle);
            } else {
                error = Marshal.GetLastWin32Error();
            }
        } catch (Exception) {
            ok = false;
            error = -1;
        }
        if (command == "RESUME" && !ok) { lock (Approved) { Approved.Remove(jobKey); } }
        string result = string.Join(((char)9).ToString(), new string[] {
            command, Clean(printerName), jobId.ToString(), ok ? "1" : "0", error.ToString()
        });
        lock (Results) { Results.Enqueue(result); }
    }

    public static string[] DrainResults() {
        lock (Results) {
            string[] all = Results.ToArray();
            Results.Clear();
            return all;
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $nativeSource -ErrorAction Stop
  [SecurePrintChangeWatcher]::StartCommandReader()
  Send-Message 'ready' @{ message = 'Native Windows printer watcher initialized.' }

  while ($true) {
    foreach ($line in @([SecurePrintChangeWatcher]::DrainResults())) {
      $r = ([string]$line).Split([char]9)
      Send-Message 'result' @{
        command = $r[0]
        printer = $r[1]
        jobId = [int]$r[2]
        ok = ($r[3] -eq '1')
        error = $r[4]
      }
    }

    if ([DateTime]::UtcNow -ge $script:nextHealthCheck) {
      $running = (Get-Service -Name Spooler -ErrorAction Stop).Status -eq 'Running'
      $printers = @()
      if ($running) {
        $printers = @(Get-Printer -ErrorAction Stop | Where-Object { -not (Test-IgnoredPrinter $_) } | Select-Object -ExpandProperty Name | Sort-Object -Unique)
      }
      $inventory = ($printers -join [char]31)
      $script:nextHealthCheck = [DateTime]::UtcNow.AddSeconds(5)

      if ($running -ne $script:spoolerRunning -or $inventory -ne $script:printerInventory) {
        [SecurePrintChangeWatcher]::Stop()
        $script:spoolerRunning = $running
        $script:printerInventory = $inventory
        $script:printerNames = $printers
        if ($running -and $printers.Count -gt 0) {
          [SecurePrintChangeWatcher]::Start([string[]]$printers)
          Send-Message 'state' @{ message = "Native ADD_JOB event subscriptions active for $($printers.Count) printers: $($printers -join ', ')." }
        } elseif (-not $running) {
          Send-Message 'state' @{ message = 'Print Spooler is stopped; printer event subscriptions are closed.' }
        } else {
          Send-Message 'state' @{ message = 'No printers are currently available for event monitoring.' }
        }
      }
    }

    if (-not $script:spoolerRunning -or $script:printerNames.Count -eq 0) {
      Start-Sleep -Seconds 1
      continue
    }

    # Wake up instantly on a new-job event; otherwise sweep every 250 ms as a safety net.
    # Jobs already in the queue (for example at startup) are caught by the first sweep.
    $index = [SecurePrintChangeWatcher]::Wait(250)
    if ($index -ge 0) {
      [void][SecurePrintChangeWatcher]::Consume($index)
      for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $found = @([SecurePrintChangeWatcher]::Scan())
        if ($found.Count -gt 0) {
          Send-Jobs $found 'event'
          break
        }
        Start-Sleep -Milliseconds 20
      }
    } elseif ($index -eq -1) {
      $found = @([SecurePrintChangeWatcher]::Scan())
      if ($found.Count -gt 0) { Send-Jobs $found 'sweep' }
    } elseif ($index -eq -2) {
      Send-Message 'error' @{ message = 'Windows printer notification wait failed; rebuilding subscriptions.' }
      [SecurePrintChangeWatcher]::Stop()
      $script:printerInventory = ''
    }
  }
} catch {
  [SecurePrintChangeWatcher]::Stop()
  Send-Message 'error' @{ message = $_.Exception.Message }
  exit 1
}
`;
}

// Builds the PowerShell arguments for the monitor.
//  - 'inline' (preferred): the compressed script travels inside the command itself, so NO file
//    is written to disk where another program could change it before PowerShell runs it.
//  - 'file' (fallback): the script is written to a private temp folder and run with -File.
function buildMonitorLaunch(script) {
  const baseArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (launchMode === 'inline') {
    const packed = zlib.gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64');
    const bootstrap =
      `$b=[Convert]::FromBase64String('${packed}');` +
      '$m=New-Object IO.MemoryStream(,$b);' +
      '$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);' +
      '$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);' +
      '$s=$r.ReadToEnd();Invoke-Expression $s';
    const encoded = encodePowerShell(bootstrap);
    if (encoded.length < MAX_COMMAND_LINE_CHARS) {
      return { args: [...baseArgs, '-EncodedCommand', encoded], scriptDirectory: null };
    }
    console.error('[PrintEnforcer] Inline monitor command is too long; using a script file instead.');
  }
  const scriptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'secureprint-monitor-'));
  const scriptPath = path.join(scriptDirectory, 'monitor.ps1');
  fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
  return { args: [...baseArgs, '-File', scriptPath], scriptDirectory };
}

function launchMonitorProcess() {
  if (!isMonitoring || monitorProcess) return;

  console.log('[PrintEnforcer] Launching persistent Windows print-job event monitor...');
  let child;
  let scriptDirectory;
  try {
    const launch = buildMonitorLaunch(createMonitorScript());
    scriptDirectory = launch.scriptDirectory;
    child = spawn('powershell.exe', launch.args, { windowsHide: true });
  } catch (error) {
    cleanupMonitorScript(scriptDirectory);
    console.error(`[PrintEnforcer] Monitor launch error${error.code ? ` (${error.code})` : ''}:`, error.message);
    noteMonitorStartFailure();
    scheduleMonitorRestart();
    return;
  }

  monitorReady = false;
  printerSubscriptionsActive = false;
  monitorProcess = child;
  let stdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    for (const line of lines) handleMonitorMessage(line);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const message = chunk.trim();
    if (message) console.error('[PrintEnforcer] Monitor error:', message);
  });

  // Prevents a crash if the monitor exits while we are writing a command to it.
  child.stdin.on('error', (error) => {
    console.error('[PrintEnforcer] Monitor command channel error:', error.message);
  });

  child.on('error', (error) => {
    console.error(`[PrintEnforcer] Monitor process error${error.code ? ` (${error.code})` : ''}:`, error.message);
  });

  child.on('close', (code, signal) => {
    cleanupMonitorScript(scriptDirectory);
    if (stdoutBuffer.trim()) handleMonitorMessage(stdoutBuffer);
    if (monitorProcess !== child) {
      if (!monitorProcess) {
        monitorReady = false;
        printerSubscriptionsActive = false;
      }
      return;
    }
    const reachedReady = monitorReady;
    monitorProcess = null;
    monitorReady = false;
    printerSubscriptionsActive = false;
    if (!isMonitoring) return;
    console.error(`[PrintEnforcer] Monitor exited (code=${code}, signal=${signal || 'none'}).`);
    if (!reachedReady) noteMonitorStartFailure();
    scheduleMonitorRestart();
  });
}

// Sends a PING and waits for the answer. If the monitor stays silent, restart it in the other
// launch mode (at most twice in a row); until verified, jobs are not held and the slower
// cancel is used, so blocking still works.
function startChannelCheck() {
  channelVerified = false;
  if (channelCheckTimer) clearTimeout(channelCheckTimer);
  sendMonitorCommand('PING', '', 0);
  channelCheckTimer = setTimeout(() => {
    channelCheckTimer = null;
    if (channelVerified || !monitorProcess || !isMonitoring) return;
    channelFailures += 1;
    console.error(`[PrintEnforcer] Monitor command channel did not answer (${channelFailures}).`);
    if (channelFailures <= 2) {
      launchMode = launchMode === 'inline' ? 'file' : 'inline';
      console.error(`[PrintEnforcer] Restarting monitor in "${launchMode}" mode.`);
      monitorProcess.kill();
    } else {
      console.error('[PrintEnforcer] Jobs will be cancelled with the slower backup method.');
    }
  }, CHANNEL_CHECK_MS);
  if (channelCheckTimer.unref) channelCheckTimer.unref();
}

// The monitor never reached its ready state. Switch launch mode for the next try, and tell the
// user if protection keeps failing, so a broken monitor is never silent.
function noteMonitorStartFailure() {
  consecutiveMonitorFailures += 1;
  launchMode = launchMode === 'inline' ? 'file' : 'inline';
  console.error(`[PrintEnforcer] Monitor failed to start (${consecutiveMonitorFailures} in a row); next try uses "${launchMode}" mode.`);
  if (consecutiveMonitorFailures === MONITOR_FAILURES_BEFORE_ALERT) {
    raiseProtectionAlert('SecurePrint print protection could not start. Printing is NOT being monitored. Please contact your administrator.');
  }
}

function scheduleMonitorRestart() {
  if (!isMonitoring || monitorRestartTimer) return;
  const delay = monitorRestartDelay;
  monitorRestartDelay = Math.min(monitorRestartDelay * 2, 30000);
  console.error(`[PrintEnforcer] Restarting print-job monitor in ${delay}ms.`);
  monitorRestartTimer = setTimeout(() => {
    monitorRestartTimer = null;
    launchMonitorProcess();
  }, delay);
}

// Sends RESUME or DELETE for one job to the running monitor. Returns true if it was written.
function sendMonitorCommand(command, printer, jobId) {
  if (!monitorProcess || !monitorProcess.stdin || monitorProcess.stdin.destroyed) return false;
  try {
    monitorProcess.stdin.write(`${command}\t${printer}\t${jobId}\n`);
    return true;
  } catch (error) {
    console.error('[PrintEnforcer] Could not send command to monitor:', error.message);
    return false;
  }
}

function handleMonitorMessage(line) {
  if (!line || !line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error('[PrintEnforcer] Monitor returned an unreadable message:', line.trim());
    return;
  }

  if (message.type === 'ready') {
    monitorReady = true;
    monitorRestartDelay = 1000;
    consecutiveMonitorFailures = 0;
    console.log(`[PrintEnforcer] ${message.message || 'Windows print event monitor ready.'}`);
    // Proves the command channel works; only after this does the monitor start holding jobs.
    startChannelCheck();
  } else if (message.type === 'state') {
    printerSubscriptionsActive = typeof message.message === 'string' &&
      message.message.startsWith('Native ADD_JOB event subscriptions active for ');
    console.log(`[PrintEnforcer] ${message.message}`);
  } else if (message.type === 'error') {
    printerSubscriptionsActive = false;
    console.error('[PrintEnforcer] Monitor error:', message.message);
  } else if (message.type === 'job') {
    handleDetectedJob(message);
  } else if (message.type === 'result') {
    handleCommandResult(message);
  }
}

function handleDetectedJob(job) {
  const printer = String(job.printer || '');
  const jobId = Number(job.jobId);
  const docName = String(job.docName || '');
  const jobName = `${printer}, ${jobId}`; // Same format Windows uses in Win32_PrintJob.Name
  const label = docName || 'Unknown document';

  // Slow-fallback jobs (not paused) are reported once; ignore quick repeats.
  if (!job.paused) {
    const key = `${jobName}|${docName}|${job.owner || ''}`;
    const now = Date.now();
    for (const [seenKey, timestamp] of recentlySeenJobs) {
      if (now - timestamp > 10000) recentlySeenJobs.delete(seenKey);
    }
    if (recentlySeenJobs.has(key)) return;
    recentlySeenJobs.set(key, now);
  }

  const authorized = consumeApproval(docName, printer);
  console.log(`[PrintEnforcer] New job detected: "${label}" by ${job.owner || 'unknown owner'} on ${printer}; ${authorized ? 'AUTHORIZED' : 'UNAUTHORIZED'}${job.paused ? ' (held)' : ''}.`);
  if (!authorized) {
    reportBlockedAttempt({ printer, document: docName, windowsUser: String(job.owner || '') });
  }

  // Fast path: the job is already paused inside the monitor, so it cannot print yet.
  if (job.paused) {
    if (authorized) {
      if (!sendMonitorCommand('RESUME', printer, jobId)) {
        console.error(`[PrintEnforcer] Could not resume authorized job "${label}" (${jobName}); it stays on hold.`);
      }
    } else if (sendMonitorCommand('DELETE', printer, jobId)) {
      showBlockedNotification();
    } else {
      cancelPrintJob(jobName, docName);
    }
    return;
  }

  // Slow fallback: the job could not be paused, so cancel it through a new PowerShell process.
  if (!authorized) cancelPrintJob(jobName, docName);
}

function handleCommandResult(result) {
  if (result.command === 'PING') {
    channelVerified = true;
    channelFailures = 0;
    if (channelCheckTimer) { clearTimeout(channelCheckTimer); channelCheckTimer = null; }
    console.log('[PrintEnforcer] Command channel verified; new jobs are now held until decided.');
    return;
  }
  const label = `${result.command} ${result.printer}, ${result.jobId}`;
  if (result.ok) {
    console.log(`[PrintEnforcer] ${label}: done.`);
    return;
  }
  console.error(`[PrintEnforcer] ${label}: FAILED (Windows error ${result.error}).`);
  // If a delete did not work, try the slower cancel as a backup.
  if (result.command === 'DELETE') {
    cancelPrintJob(`${result.printer}, ${result.jobId}`, '', false);
  }
}

function cancelPrintJob(jobName, docName, notify = true) {
  if (!jobName) {
    console.error(`[PrintEnforcer] Cannot cancel "${docName || 'Unknown document'}": detected job has no printer/job identifier.`);
    return;
  }

  const escapedJobName = jobName.replace(/'/g, "''");
  const psCancel = `
$ErrorActionPreference = 'Stop'
try {
  $job = Get-CimInstance -ClassName Win32_PrintJob -ErrorAction Stop |
    Where-Object { $_.Name -eq '${escapedJobName}' }
  if (-not $job) {
    Write-Output 'JOB_NOT_FOUND'
    exit 2
  }
  Remove-CimInstance -InputObject $job -ErrorAction Stop
  Write-Output 'JOB_CANCELLED'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

  console.log(`[PrintEnforcer] Cancelling unauthorized job "${docName || 'Unknown document'}" (${jobName}).`);
  if (notify) showBlockedNotification();

  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShell(psCancel)
  ], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => {
    console.error('[PrintEnforcer] Cancellation process error:', error.message);
  });
  child.on('close', code => {
    if (code === 0 && stdout.includes('JOB_CANCELLED')) {
      console.log(`[PrintEnforcer] Unauthorized job cancelled: "${docName || 'Unknown document'}" (${jobName}).`);
    } else if (stdout.includes('JOB_NOT_FOUND')) {
      console.error(`[PrintEnforcer] Could not cancel unauthorized job "${docName || 'Unknown document'}": it was no longer in the spooler.`);
    } else {
      console.error(`[PrintEnforcer] Failed to cancel unauthorized job "${docName || 'Unknown document'}": ${stderr.trim() || `PowerShell exited with code ${code}.`}`);
    }
  });

}

function showBlockedNotification() {
  if (!blockedPrintNotificationHandler) {
    console.error('[PrintEnforcer] Cannot show blocked-print warning: no renderer notification handler is registered.');
    return;
  }
  try {
    blockedPrintNotificationHandler();
  } catch (error) {
    console.error('[PrintEnforcer] Could not send blocked-print warning to the renderer:', error.message);
  }
}

// ─── Network Printer Port Blocking ───

function blockDirectPrinterPorts() {
  if (process.platform !== 'win32') return Promise.resolve();

  console.log('[PrintEnforcer] Blocking direct printer network ports...');

  const psScript = `
    try {
      # Block RAW printing (port 9100)
      New-NetFirewallRule -DisplayName 'SecurePrint-Block-RAW-9100' -Direction Outbound -LocalPort 9100 -Protocol TCP -Action Block -ErrorAction SilentlyContinue
      # Block LPR printing (port 515)
      New-NetFirewallRule -DisplayName 'SecurePrint-Block-LPR-515' -Direction Outbound -LocalPort 515 -Protocol TCP -Action Block -ErrorAction SilentlyContinue
      # Block IPP printing (port 631)
      New-NetFirewallRule -DisplayName 'SecurePrint-Block-IPP-631' -Direction Outbound -LocalPort 631 -Protocol TCP -Action Block -ErrorAction SilentlyContinue
      Write-Output 'PORTS_BLOCKED'
    } catch {
      Write-Output "PORT_ERROR: $_"
    }
  `;

  return runElevatedPowerShell(psScript);
}

function unblockDirectPrinterPorts() {
  if (process.platform !== 'win32') return Promise.resolve();

  const psScript = `
    try {
      Remove-NetFirewallRule -DisplayName 'SecurePrint-Block-RAW-9100' -ErrorAction SilentlyContinue
      Remove-NetFirewallRule -DisplayName 'SecurePrint-Block-LPR-515' -ErrorAction SilentlyContinue
      Remove-NetFirewallRule -DisplayName 'SecurePrint-Block-IPP-631' -ErrorAction SilentlyContinue
      Write-Output 'PORTS_UNBLOCKED'
    } catch {
      Write-Output "PORT_ERROR: $_"
    }
  `;

  return runElevatedPowerShell(psScript);
}

// ─── Printer Visibility Control ───

function hideAllPrintersExcept(allowedPrinterNames) {
  if (process.platform !== 'win32') return Promise.resolve();

  const allowed = (allowedPrinterNames || []).map(n => `'${n.replace(/'/g, "''")}'`).join(',');

  const psScript = `
    try {
      $allowed = @(${allowed})
      $printers = Get-Printer -ErrorAction SilentlyContinue
      foreach ($p in $printers) {
        if ($allowed -notcontains $p.Name) {
          # Set printer to offline / hidden
          Set-Printer -Name $p.Name -PermissionSDDL $null -ErrorAction SilentlyContinue
          Write-Output "HIDDEN: $($p.Name)"
        }
      }
    } catch {
      Write-Output "HIDE_ERROR: $_"
    }
  `;

  return runElevatedPowerShell(psScript);
}

// ─── Enforce All Policies ───

async function enforceAllPolicies() {
  console.log('[PrintEnforcer] Enforcing all print security policies...');
  const results = [];

  // USB printers only: firewall port blocking is not needed (no network printing).
  // Best-effort cleanup of rules left behind by older SecurePrint versions.
  try {
    await unblockDirectPrinterPorts();
    results.push('Old printer port firewall rules cleaned up');
  } catch (e) {
    results.push('Old firewall rule cleanup skipped: ' + e.message);
  }

  startMonitoring();
  results.push('Spooler monitor active');

  console.log('[PrintEnforcer] Policy enforcement results:', results.join('; '));
  return results;
}

async function removeAllPolicies() {
  console.log('[PrintEnforcer] Removing all print security policies...');
  stopMonitoring();

  try { await unblockDirectPrinterPorts(); } catch (e) { /* ignore */ }
}

// ─── Get Enforcer Status ───

function getStatus() {
  return {
    spoolerMonitorActive: isMonitoring && monitorReady,
    monitorProcessRunning: Boolean(monitorProcess),
    printerSubscriptionsActive,
    whitelistedJobs: (pruneApprovals(), Array.from(approvedJobs.keys())),
    monitorLaunchMode: launchMode,
    platform: process.platform
  };
}

// ─── Utility ───

function runElevatedPowerShell(script) {
  return new Promise((resolve, reject) => {
    const escaped = script.replace(/"/g, '\\"');
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${escaped}"`,
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          // Try with elevation
          console.log('[PrintEnforcer] Standard exec failed, may need admin rights.');
          reject(new Error(stderr || err.message));
        } else {
          console.log('[PrintEnforcer] PS output:', stdout.trim());
          resolve(stdout.trim());
        }
      }
    );
  });
}

module.exports = {
  setBlockedPrintNotificationHandler,
  setBlockedAttemptHandler,
  setProtectionAlertHandler,
  // Whitelist
  whitelistJob,
  removeWhitelistedJob,
  isJobWhitelisted,
  consumeApproval,
  // Monitor
  startMonitoring,
  stopMonitoring,
  // Ports
  blockDirectPrinterPorts,
  unblockDirectPrinterPorts,
  // Printer visibility
  hideAllPrintersExcept,
  // Combined
  enforceAllPolicies,
  removeAllPolicies,
  // Status
  getStatus
};