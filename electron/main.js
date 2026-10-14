const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const fileConverter = require('./services/file-converter');
const printEnforcer = require('./services/print-enforcer');
const PrintLogOutbox = require('./services/print-log-outbox');
const BlockedAttemptQueue = require('./services/blocked-attempt-queue');
const { resolveApiBaseUrl } = require('./client-config');

let mainWindow;
let mainWindowLoaded = false;
let pendingWarningMessage = null;
let lastBlockedPrintWarningAt = 0;
let pendingFilePath = null; // File passed via command line or context menu
let printLogOutbox;
let activePrintToken = null;
let activePrintUserId = null;
let printLogFlushPromise = null;
let printLogRetryTimer = null;
let printLogRetryDelay = 5000;
let lastPrintLogError = null;

function getPrintLogOutbox() {
  if (!printLogOutbox) {
    printLogOutbox = new PrintLogOutbox(path.join(app.getPath('userData'), 'print-log-outbox.json'));
  }
  return printLogOutbox;
}

const BLOCKED_PRINT_WARNING = 'Print Blocked. All printing must go through SecurePrint.';
const BLOCKED_PRINT_WARNING_COOLDOWN_MS = 3000;

function flushBlockedPrintWarning() {
  if (!pendingWarningMessage || !mainWindow || mainWindow.isDestroyed() || !mainWindowLoaded) return;
  try {
    mainWindow.webContents.send('print-blocked-warning', pendingWarningMessage);
    pendingWarningMessage = null;
  } catch (error) {
    console.error('[Electron] Could not deliver warning to the renderer:', error.message);
  }
}

// Shows a warning in the app window (opening the window if needed).
// The usual "Print Blocked" warning is rate-limited; other messages (for example
// "print protection is not running") are always shown.
function showBlockedPrintWarning(message = BLOCKED_PRINT_WARNING) {
  const now = Date.now();
  if (message === BLOCKED_PRINT_WARNING) {
    if (now - lastBlockedPrintWarningAt < BLOCKED_PRINT_WARNING_COOLDOWN_MS) return;
    lastBlockedPrintWarningAt = now;
  }
  pendingWarningMessage = message;

  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      pendingFilePath = null; // a stale file from an earlier launch must not reopen
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    flushBlockedPrintWarning();
  } catch (error) {
    console.error('[Electron] Could not display warning:', error.message);
  }
}

function getTokenUserId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const userId = Number(payload.id);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}

function schedulePrintLogRetry(error) {
  if (error) console.error('[PrintLog] Central server delivery failed; record remains queued:', error.message);
  if (printLogRetryTimer || !activePrintUserId || !getPrintLogOutbox().getPending(activePrintUserId).length) return;

  const delay = printLogRetryDelay;
  printLogRetryDelay = Math.min(printLogRetryDelay * 2, 5 * 60 * 1000);
  printLogRetryTimer = setTimeout(() => {
    printLogRetryTimer = null;
    void flushPrintLogOutbox();
  }, delay);
  printLogRetryTimer.unref();
}

async function postPrintLog(record, token) {
  const apiUrl = `${resolveApiBaseUrl()}/api/print/log`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(record.payload),
      signal: controller.signal
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Central server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok || !result.success) {
      throw new Error(result.message || `Central server rejected the print log (HTTP ${response.status}).`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function flushPrintLogOutbox(token) {
  if (token) {
    activePrintUserId = getTokenUserId(token);
    activePrintToken = activePrintUserId ? token : null;
  }
  if (!activePrintToken || !activePrintUserId) return getPrintLogOutbox().getStatus();
  if (printLogFlushPromise) return printLogFlushPromise;

  printLogFlushPromise = (async () => {
    const outbox = getPrintLogOutbox();
    const userId = activePrintUserId;
    const token = activePrintToken;
    for (const record of outbox.getPending(userId)) {
      try {
        await postPrintLog(record, token);
        outbox.removeDelivered(record.client_job_id);
        printLogRetryDelay = 5000;
        lastPrintLogError = null;
        console.log(`[PrintLog] Central server recorded print job ${record.client_job_id}.`);
      } catch (error) {
        lastPrintLogError = error.message;
        schedulePrintLogRetry(error);
        break;
      }
    }
    return outbox.getStatus();
  })();

  try {
    return await printLogFlushPromise;
  } finally {
    printLogFlushPromise = null;
  }
}

// ─── Blocked print attempts: saved locally, sent to the server when a user is signed in ───
let blockedAttemptQueue;
let blockedAttemptFlushPromise = null;

function getBlockedAttemptQueue() {
  if (!blockedAttemptQueue) {
    blockedAttemptQueue = new BlockedAttemptQueue(path.join(app.getPath('userData'), 'blocked-attempts.json'));
  }
  return blockedAttemptQueue;
}

function recordBlockedAttempt(attempt) {
  try {
    getBlockedAttemptQueue().add({
      document: attempt.document,
      printer: attempt.printer,
      windowsUser: attempt.windowsUser,
      machine: os.hostname(),
      occurredAt: attempt.occurredAt
    });
  } catch (error) {
    console.error('[BlockedAttempts] Could not save blocked attempt:', error.message);
    return;
  }
  void flushBlockedAttempts();
}

async function postBlockedAttempts(attempts, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${resolveApiBaseUrl()}/api/print/blocked-attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        attempts: attempts.map(({ document, printer, windows_user, machine, occurred_at }) =>
          ({ document, printer, windows_user, machine, occurred_at }))
      }),
      signal: controller.signal
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Central server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok || !result.success) {
      throw new Error(result.message || `Central server rejected the blocked attempts (HTTP ${response.status}).`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Sends saved blocked attempts to the server. Needs a signed-in user; otherwise they wait.
async function flushBlockedAttempts() {
  if (!activePrintToken) return;
  if (blockedAttemptFlushPromise) return blockedAttemptFlushPromise;

  blockedAttemptFlushPromise = (async () => {
    const queue = getBlockedAttemptQueue();
    for (;;) {
      const batch = queue.peek(50);
      if (!batch.length) return;
      try {
        await postBlockedAttempts(batch, activePrintToken);
        queue.remove(batch.map(entry => entry.id));
        console.log(`[BlockedAttempts] Reported ${batch.length} blocked print attempt(s) to the central server.`);
      } catch (error) {
        console.error('[BlockedAttempts] Delivery failed; attempts stay queued:', error.message);
        return;
      }
    }
  })();

  try {
    await blockedAttemptFlushPromise;
  } finally {
    blockedAttemptFlushPromise = null;
  }
}

// ─── Private copy of each document SecurePrint prints ───
// The copy has a random, unguessable name. The enforcer approves exactly that name, so no other
// document can ever match the approval.
const JOB_COPY_DIR_NAME = 'secureprint-jobs';

function createSecureJobCopy(sourcePath) {
  const dir = path.join(app.getPath('temp'), JOB_COPY_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^\w.\- ]+/g, '_').slice(0, 60) || 'document';
  const copyPath = path.join(dir, `${base}__sp${crypto.randomBytes(12).toString('hex')}.pdf`);
  fs.copyFileSync(sourcePath, copyPath);
  return copyPath;
}

function removeSecureJobCopyLater(copyPath) {
  // Short delay so the spooler is certain to be finished with the file.
  const timer = setTimeout(() => {
    try { fs.rmSync(copyPath, { force: true }); } catch { /* ignored */ }
  }, 10000);
  timer.unref();
}

function purgeStaleJobCopies() {
  try {
    fs.rmSync(path.join(app.getPath('temp'), JOB_COPY_DIR_NAME), { recursive: true, force: true });
  } catch { /* ignored */ }
}

// ─── Parse command-line arguments for --print-file ───
function extractFileArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--print-file=')) {
      return arg.substring('--print-file='.length).replace(/^"|"$/g, '');
    }
    if (arg === '--print-file' && argv[i + 1]) {
      return argv[i + 1].replace(/^"|"$/g, '');
    }
    // Also accept bare file paths (from Windows "Open with")
    if (!arg.startsWith('-') && !arg.startsWith('/') && fs.existsSync(arg) && fileConverter.isSupported(arg)) {
      return arg;
    }
    // Windows passes full paths like C:\...
    if (/^[A-Z]:\\/i.test(arg) && fs.existsSync(arg) && fileConverter.isSupported(arg)) {
      return arg;
    }
  }
  return null;
}

// Check if running in background mode (tray-only)
const isBackgroundMode = process.argv.includes('--background');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'SecurePrint - Academic Print Monitor',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    backgroundColor: '#f8fafc'
  });

  // Remove menu bar for kiosk-like experience
  Menu.setApplicationMenu(null);

  // If a file was passed via context menu, go to print-intercept page
  // Otherwise, load the normal login page
  if (pendingFilePath) {
    loadPrintInterceptPage(pendingFilePath);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'pages', 'login.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindowLoaded = false;
  mainWindow.webContents.on('did-start-loading', () => {
    mainWindowLoaded = false; // a warning sent mid-navigation would be lost; wait for the page
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindowLoaded = true;
    flushBlockedPrintWarning();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    mainWindowLoaded = false;
  });
}

// ─── Single Instance Lock ───
// Ensures only one SecurePrint runs. If a second instance is launched
// (e.g. user right-clicks another file), the file path is forwarded
// to the already-running instance.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is running — forward the file arg and quit
  app.quit();
} else {
  printEnforcer.setBlockedPrintNotificationHandler(() => showBlockedPrintWarning());
  printEnforcer.setBlockedAttemptHandler(recordBlockedAttempt);
  printEnforcer.setProtectionAlertHandler((message) => showBlockedPrintWarning(message));

  app.on('second-instance', (event, commandLine) => {
    const filePath = extractFileArg(commandLine);
    // The scheduled-task watchdog and auto-start relaunch SecurePrint with --background to make
    // sure it is running. That must never pop up a window.
    if (commandLine.includes('--background') && !filePath) return;
    // Background mode has no window open. Create one so the user can still use the app
    // (or "Print with SecurePrint") while the enforcer keeps running.
    if (!mainWindow) {
      pendingFilePath = filePath || null;
      createWindow();
      return;
    }
    if (filePath && mainWindow) {
      console.log('[Electron] Second instance file:', filePath);
      pendingFilePath = filePath;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      loadPrintInterceptPage(filePath);
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const outboxStatus = getPrintLogOutbox().getStatus();
      if (outboxStatus.pending) {
        console.log(`[PrintLog] ${outboxStatus.pending} successful print log(s) are waiting for user authentication and server delivery.`);
      }
      for (const record of outboxStatus.uncertain) {
        console.error(`[PrintLog] Print outcome is uncertain after an application interruption: "${record.file_name}" (${record.client_job_id}, ${record.created_at}). Retained locally; not reported as successful.`);
      }
    } catch (error) {
      console.error('[PrintLog] Durable outbox could not be initialized:', error.message);
    }

    try {
      console.log(`[Electron] Central SecurePrint API: ${resolveApiBaseUrl()}`);
    } catch (error) {
      console.error('[Electron] Central API configuration error:', error.message);
    }

    purgeStaleJobCopies();

    // Check for file argument from context menu / "Open with"
    pendingFilePath = extractFileArg(process.argv);

    // Enable auto-start on Windows login
    if (process.platform === 'win32' && app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: true,
        args: ['--background']
      });
    }

    if (!isBackgroundMode || pendingFilePath) {
      createWindow();
    }

    // The backend runs centrally; only local printing and monitoring run in Electron.
    try {
      await printEnforcer.enforceAllPolicies();
    } catch (e) {
      console.log('[Electron] Print enforcement partial (needs admin):', e.message);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Never quit when the last window closes. Print blocking must keep working with no
    // window open and nobody logged in to SecurePrint. Only an explicit app.quit() stops it.
  });

  app.on('before-quit', () => {
    printEnforcer.stopMonitoring();
  });
}

// ─── Helper: Load the print intercept page with a file ───
function loadPrintInterceptPage(filePath) {
  if (!mainWindow) return;
  const encodedPath = encodeURIComponent(filePath);
  mainWindow.loadFile(
    path.join(__dirname, '..', 'frontend', 'pages', 'print-intercept.html'),
    { query: { file: encodedPath } }
  );
}

// ─── IPC Handlers ───

ipcMain.handle('get-client-config', () => {
  try {
    return { apiBaseUrl: resolveApiBaseUrl(), apiConfigError: '' };
  } catch (error) {
    console.error('[Electron] Central API configuration error:', error.message);
    return { apiBaseUrl: '', apiConfigError: error.message };
  }
});

// Get files from Downloads folder — now supports ALL file formats
ipcMain.handle('get-downloads', async () => {
  const downloadsPath = path.join(os.homedir(), 'Downloads');
  try {
    const supportedExts = Object.keys(fileConverter.SUPPORTED_EXTENSIONS);
    const files = fs.readdirSync(downloadsPath)
      .filter(f => {
        const ext = path.extname(f).toLowerCase();
        return supportedExts.includes(ext);
      })
      .map(f => ({
        name: f,
        path: path.join(downloadsPath, f),
        size: fs.statSync(path.join(downloadsPath, f)).size,
        modified: fs.statSync(path.join(downloadsPath, f)).mtime
      }))
      .sort((a, b) => b.modified - a.modified);
    return { success: true, files };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Browse for file — now supports ALL file formats
ipcMain.handle('browse-file', async () => {
  const supportedExts = Object.keys(fileConverter.SUPPORTED_EXTENSIONS).map(e => e.replace('.', ''));
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'All Printable Files', extensions: supportedExts },
      { name: 'PDF Files', extensions: ['pdf'] },
      { name: 'Word Documents', extensions: ['doc', 'docx', 'rtf'] },
      { name: 'Excel Spreadsheets', extensions: ['xls', 'xlsx'] },
      { name: 'PowerPoint Presentations', extensions: ['ppt', 'pptx'] },
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tiff', 'tif'] },
      { name: 'Text Files', extensions: ['txt', 'csv', 'log'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    return { success: true, path: filePath, name: path.basename(filePath) };
  }
  return { success: false };
});

// Get available printers
ipcMain.handle('get-printers', async () => {
  try {
    const printers = mainWindow.webContents.getPrintersAsync 
      ? await mainWindow.webContents.getPrintersAsync()
      : mainWindow.webContents.getPrinters();
    return { success: true, printers };
  } catch (e) {
    return { success: true, printers: [{ name: 'Default Printer', isDefault: true }] };
  }
});

// Convert any file to PDF
ipcMain.handle('convert-file', async (event, filePath) => {
  try {
    const pdfPath = await fileConverter.convertToPdf(filePath);
    return { success: true, pdfPath, originalName: path.basename(filePath) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Get pending file (passed from context menu / Open With)
ipcMain.handle('get-pending-file', async () => {
  if (pendingFilePath && fs.existsSync(pendingFilePath)) {
    const filePath = pendingFilePath;
    return {
      success: true,
      path: filePath,
      name: path.basename(filePath),
      size: fs.statSync(filePath).size,
      type: fileConverter.getFileType(filePath),
      supported: fileConverter.isSupported(filePath)
    };
  }
  return { success: false };
});

// Clear pending file
ipcMain.handle('clear-pending-file', async () => {
  pendingFilePath = null;
  return { success: true };
});

// Get print enforcer status
ipcMain.handle('get-enforcer-status', async () => {
  return { success: true, status: printEnforcer.getStatus() };
});

ipcMain.handle('sync-print-logs', async (event, token) => {
  if (typeof token !== 'string' || !token.trim()) {
    return { success: false, message: 'A signed-in user is required to sync print logs.' };
  }
  try {
    const userId = getTokenUserId(token.trim());
    if (!userId) return { success: false, message: 'The signed-in user token is invalid.' };
    const status = await flushPrintLogOutbox(token.trim());
    void flushBlockedAttempts();
    return { success: true, status: getPrintLogOutbox().getStatus(userId) };
  } catch (error) {
    console.error('[PrintLog] Could not load the durable print log outbox:', error.message);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('clear-print-log-token', async () => {
  activePrintToken = null;
  activePrintUserId = null;
  if (printLogRetryTimer) {
    clearTimeout(printLogRetryTimer);
    printLogRetryTimer = null;
  }
  return { success: true };
});

// Print file using pdf-to-printer with settings and retry
// Now integrates with the print enforcer whitelist
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

ipcMain.handle('print-file', async (event, {
  filePath, copies, printer, pageRange, monochrome, duplex, accessToken, logRecord
}) => {
  try {
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return { success: false, error: 'Sign in before printing so SecurePrint can record the job.' };
    }
    const userId = getTokenUserId(accessToken.trim());
    if (!userId) return { success: false, error: 'The signed-in user token is invalid; the job was not sent.' };
    if (!logRecord || typeof logRecord.file_name !== 'string' || !logRecord.file_name.trim()) {
      return { success: false, error: 'Print details are missing; the job was not sent so it cannot be logged accurately.' };
    }
    const numPages = Number(logRecord.num_pages);
    if (!Number.isInteger(numPages) || numPages < 1) {
      return { success: false, error: 'The document page count is invalid; the job was not sent.' };
    }

    // Convert to PDF if needed
    let pdfPath = filePath;
    if (!filePath.toLowerCase().endsWith('.pdf')) {
      pdfPath = await fileConverter.convertToPdf(filePath);
    }

    const printCopies = Number(copies) || 1;
    const pageSelection = pageRange || 'All';
    const printLogPayload = {
      file_name: logRecord.file_name.trim(),
      file_path: typeof logRecord.file_path === 'string' ? logRecord.file_path : null,
      num_pages: numPages,
      copies: printCopies,
      page_range: pageSelection,
      printer_name: printer || 'Default',
      status: 'success'
    };
    const outbox = getPrintLogOutbox();
    // Persist the intent before sending anything to the printer so a crash during
    // printing leaves an explicit recoverable/uncertain entry rather than no trace.
    const clientJobId = outbox.addAttempt(printLogPayload, userId);

    const ptp = require('pdf-to-printer');
    const options = {
      copies: printCopies,
      printer: printer || undefined,
      pages: pageSelection !== 'All' ? pageSelection : undefined
    };
    if (monochrome) options.monochrome = true;
    if (duplex) options.duplex = duplex;

    // Print a private copy with a random, unguessable name, and approve exactly that name
    // (for this printer only) BEFORE sending it. Nothing else can match the approval.
    let jobCopyPath;
    try {
      jobCopyPath = createSecureJobCopy(pdfPath);
    } catch (error) {
      try { outbox.removeAttempt(clientJobId); } catch { /* ignored */ }
      return { success: false, error: `Could not prepare the document for printing: ${error.message}` };
    }
    const docName = path.basename(jobCopyPath);
    printEnforcer.whitelistJob(docName, { printer: printer || undefined });

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ptp.print(jobCopyPath, options);
        removeSecureJobCopyLater(jobCopyPath);
        const printedAt = new Date().toISOString();
        try {
          outbox.markSucceeded(clientJobId, printedAt);
        } catch (error) {
          console.error(`[PrintLog] Print succeeded but could not finalize durable outbox entry ${clientJobId}:`, error.message);
          return {
            success: true,
            logStatus: 'recovery-required',
            logError: error.message
          };
        }

        try {
          const logStatus = await flushPrintLogOutbox(accessToken.trim());
          const pendingCount = getPrintLogOutbox().getPending(userId).length;
          if (pendingCount) schedulePrintLogRetry();
          return {
            success: true,
            logStatus: pendingCount ? 'queued' : 'recorded',
            logError: pendingCount ? lastPrintLogError : null,
            uncertainCount: logStatus.uncertain.filter(record => record.user_id === userId).length
          };
        } catch (error) {
          console.error(`[PrintLog] Print ${clientJobId} succeeded, but outbox synchronization failed:`, error.message);
          return { success: true, logStatus: 'recovery-required', logError: error.message };
        }
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(1000);
      }
    }

    // Remove approval and the private copy on failure
    printEnforcer.removeWhitelistedJob(docName);
    removeSecureJobCopyLater(jobCopyPath);
    try {
      outbox.removeAttempt(clientJobId);
    } catch (error) {
      console.error(`[PrintLog] Failed print attempt ${clientJobId} could not be removed from the outbox:`, error.message);
    }
    return { success: false, error: lastError.message };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Open file externally for preview
ipcMain.handle('preview-file', async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Navigate to page
ipcMain.handle('navigate', async (event, page) => {
  const pages = {
    login: 'login.html',
    'admin-portal': 'admin-portal.html',
    'forgot-password': 'forgot-password.html',
    'forgot-secret': 'forgot-secret.html',
    'reset-password': 'reset-password.html',
    'reset-secret': 'reset-secret.html',
    'change-password': 'change-password.html',
    faculty: 'faculty-dashboard.html',
    admin: 'admin-dashboard.html',
    'super-admin': 'super-admin-dashboard.html',
    'faculty-management': 'faculty-management.html',
    'client-download': 'client-download.html',
    'print-intercept': 'print-intercept.html'
  };
  const file = pages[page];
  console.log('[IPC] Navigate handler called with page:', page, '-> file:', file);
  if (file) {
    console.log('[IPC] Loading file:', path.join(__dirname, '..', 'frontend', 'pages', file));
    mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'pages', file));
  } else {
    console.log('[IPC] Unknown page:', page);
  }
});

// Get PDF page count
ipcMain.handle('get-pdf-info', async (event, filePath) => {
  try {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return { success: true, pages: data.numpages, text: data.text.substring(0, 200) };
  } catch (e) {
    return { success: false, error: e.message, pages: 1 };
  }
});