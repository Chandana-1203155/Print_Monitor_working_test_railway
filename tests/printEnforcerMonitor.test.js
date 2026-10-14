const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PassThrough } = require('stream');

jest.mock('child_process', () => ({
  exec: jest.fn(),
  spawn: jest.fn()
}));

const { spawn } = require('child_process');
const printEnforcer = require('../electron/services/print-enforcer');

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = jest.fn(() => true);
  child.kill = jest.fn();
  return child;
}

const send = (child, message) => child.stdout.write(`${JSON.stringify(message)}\n`);
const job = (overrides = {}) => ({
  type: 'job', printer: 'Office Printer', jobId: 1, docName: 'direct-print.pdf',
  owner: 'faculty', paused: true, ...overrides
});

describe('Windows print-job monitor', () => {
  let child;
  let platformDescriptor;
  let warning;
  let attempt;
  let alert;

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    warning = jest.fn();
    attempt = jest.fn();
    alert = jest.fn();
    printEnforcer.setBlockedPrintNotificationHandler(warning);
    printEnforcer.setBlockedAttemptHandler(attempt);
    printEnforcer.setProtectionAlertHandler(alert);

    child = makeChild();
    spawn.mockReset();
    spawn.mockReturnValue(child);
  });

  afterEach(() => {
    printEnforcer.stopMonitoring();
    child.emit('close', 0, null);
    printEnforcer.setBlockedPrintNotificationHandler(null);
    printEnforcer.setBlockedAttemptHandler(null);
    printEnforcer.setProtectionAlertHandler(null);
    jest.useRealTimers();
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  describe('launching', () => {
    test('starts from a compressed inline command: no script file, under the Windows length limit', () => {
      printEnforcer.startMonitoring();

      const [executable, args, options] = spawn.mock.calls[0];
      expect(executable).toBe('powershell.exe');
      expect(args).toContain('-EncodedCommand');
      expect(args).not.toContain('-File');
      expect(args.join(' ').length).toBeLessThan(32767);
      expect(options).toEqual({ windowsHide: true });

      // The command must carry the real watcher script, compressed.
      const bootstrap = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
      const packed = /FromBase64String\('([^']+)'\)/.exec(bootstrap)[1];
      const script = zlib.gunzipSync(Buffer.from(packed, 'base64')).toString('utf8');
      expect(script).toContain('FindFirstPrinterChangeNotification');
      expect(script).toContain('JobControlPause');
    });

    test('reports readiness and verifies the command channel with a PING', () => {
      printEnforcer.startMonitoring();
      send(child, { type: 'ready', message: 'Native Windows printer watcher initialized.' });
      send(child, {
        type: 'state',
        message: 'Native ADD_JOB event subscriptions active for 1 printers: Office Printer.'
      });

      expect(child.stdin.write).toHaveBeenCalledWith('PING\t\t0\n');
      expect(printEnforcer.getStatus()).toEqual(expect.objectContaining({
        spoolerMonitorActive: true,
        monitorProcessRunning: true,
        printerSubscriptionsActive: true
      }));
    });

    test('falls back to a script file if the inline launch never becomes ready, then cleans it up', () => {
      jest.useFakeTimers();
      printEnforcer.startMonitoring();
      child.emit('close', 1, null); // died before "ready"

      const second = makeChild();
      spawn.mockReturnValue(second);
      jest.advanceTimersByTime(1100);

      const args = spawn.mock.calls[1][1];
      expect(args).toContain('-File');
      expect(args.join(' ').length).toBeLessThan(32767);
      const scriptPath = args[args.indexOf('-File') + 1];
      expect(fs.readFileSync(scriptPath, 'utf8')).toContain('FindFirstPrinterChangeNotification');

      printEnforcer.stopMonitoring();
      second.emit('close', 0, null);
      expect(fs.existsSync(path.dirname(scriptPath))).toBe(false);
    });

    test('tells the user when protection cannot start after repeated failures', () => {
      jest.useFakeTimers();
      printEnforcer.startMonitoring();
      for (let i = 0; i < 3; i++) {
        const current = i === 0 ? child : makeChild();
        if (i > 0) spawn.mockReturnValue(current);
        if (i > 0) jest.advanceTimersByTime(40000);
        current.emit('close', 1, null);
      }
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][0]).toMatch(/NOT being monitored/);
    });

    test('switches launch mode when the command channel stays silent', () => {
      jest.useFakeTimers();
      printEnforcer.startMonitoring();
      send(child, { type: 'ready', message: 'ok' });
      jest.advanceTimersByTime(5100); // no PING answer
      expect(child.kill).toHaveBeenCalled();
      expect(printEnforcer.getStatus().monitorLaunchMode).toBe('file');
    });

    test('does not switch mode once the channel answers', () => {
      jest.useFakeTimers();
      printEnforcer.startMonitoring();
      send(child, { type: 'ready', message: 'ok' });
      send(child, { type: 'result', command: 'PING', printer: '', jobId: 0, ok: true, error: '0' });
      jest.advanceTimersByTime(6000);
      expect(child.kill).not.toHaveBeenCalled();
      expect(printEnforcer.getStatus().monitorLaunchMode).toBe('inline');
    });
  });

  describe('deciding held jobs', () => {
    beforeEach(() => printEnforcer.startMonitoring());

    test('deletes an unauthorized job, warns the user, and reports the attempt', () => {
      send(child, job({ jobId: 17, docName: 'C:\\Users\\a\\direct-print.pdf' }));

      expect(child.stdin.write).toHaveBeenCalledWith('DELETE\tOffice Printer\t17\n');
      expect(warning).toHaveBeenCalledTimes(1);
      expect(attempt).toHaveBeenCalledWith(expect.objectContaining({
        printer: 'Office Printer',
        document: 'C:\\Users\\a\\direct-print.pdf',
        windowsUser: 'faculty',
        occurredAt: expect.any(String)
      }));
    });

    test('resumes a job SecurePrint approved, without a warning or a blocked report', () => {
      printEnforcer.whitelistJob('report__sp1234.pdf', { printer: 'Office Printer' });
      send(child, job({ jobId: 18, docName: 'C:\\Users\\a\\AppData\\Local\\Temp\\secureprint-jobs\\report__sp1234.pdf' }));

      expect(child.stdin.write).toHaveBeenCalledWith('RESUME\tOffice Printer\t18\n');
      expect(warning).not.toHaveBeenCalled();
      expect(attempt).not.toHaveBeenCalled();
    });

    test('approval needs the EXACT name: look-alike names are blocked', () => {
      printEnforcer.whitelistJob('report.pdf');
      const lookAlikes = ['my-report.pdf', 'report.pdf.exe', 'report', 'C:\\x\\xreport.pdf', 'a'];
      lookAlikes.forEach((docName, index) => send(child, job({ jobId: 100 + index, docName })));

      lookAlikes.forEach((_name, index) => {
        expect(child.stdin.write).toHaveBeenCalledWith(`DELETE\tOffice Printer\t${100 + index}\n`);
      });
      expect(child.stdin.write).not.toHaveBeenCalledWith(expect.stringContaining('RESUME'));
    });

    test('approval accepts the same name or a full path ending with it, ignoring case', () => {
      printEnforcer.whitelistJob('Report.PDF');
      send(child, job({ jobId: 1, docName: 'report.pdf' }));
      send(child, job({ jobId: 2, docName: 'C:\\Users\\a\\REPORT.pdf' }));
      send(child, job({ jobId: 3, docName: 'C:/Users/a/report.pdf' }));
      [1, 2, 3].forEach(id => expect(child.stdin.write).toHaveBeenCalledWith(`RESUME\tOffice Printer\t${id}\n`));
    });

    test('an approval works for a few jobs only, not forever', () => {
      printEnforcer.whitelistJob('once.pdf', { maxJobs: 1 });
      send(child, job({ jobId: 1, docName: 'once.pdf' }));
      send(child, job({ jobId: 2, docName: 'once.pdf' }));
      expect(child.stdin.write).toHaveBeenCalledWith('RESUME\tOffice Printer\t1\n');
      expect(child.stdin.write).toHaveBeenCalledWith('DELETE\tOffice Printer\t2\n');
    });

    test('an approval is bound to the printer SecurePrint printed to', () => {
      printEnforcer.whitelistJob('bound.pdf', { printer: 'Office Printer' });
      send(child, job({ jobId: 1, printer: 'Other Printer', docName: 'bound.pdf' }));
      expect(child.stdin.write).toHaveBeenCalledWith('DELETE\tOther Printer\t1\n');
    });

    test('an approval expires', () => {
      jest.useFakeTimers();
      printEnforcer.whitelistJob('late.pdf');
      jest.advanceTimersByTime(61000);
      send(child, job({ jobId: 1, docName: 'late.pdf' }));
      expect(child.stdin.write).toHaveBeenCalledWith('DELETE\tOffice Printer\t1\n');
    });

    test('a removed approval no longer works', () => {
      printEnforcer.whitelistJob('gone.pdf');
      printEnforcer.removeWhitelistedJob('gone.pdf');
      send(child, job({ jobId: 1, docName: 'gone.pdf' }));
      expect(child.stdin.write).toHaveBeenCalledWith('DELETE\tOffice Printer\t1\n');
    });

    test('a held job that is re-reported (someone resumed it by hand) is decided again', () => {
      send(child, job({ jobId: 8, docName: 'sneaky.pdf' }));
      send(child, job({ jobId: 8, docName: 'sneaky.pdf', source: 'sweep' }));
      const deletes = child.stdin.write.mock.calls.filter(([text]) => text === 'DELETE\tOffice Printer\t8\n');
      expect(deletes).toHaveLength(2);
    });

    test('uses the slower cancel when a job could not be held, and still reports it', () => {
      send(child, job({ jobId: 9, docName: 'other.txt', paused: false }));
      expect(spawn).toHaveBeenCalledTimes(2); // monitor + cancel
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
    });

    test('tries the slower cancel when a delete fails', () => {
      send(child, { type: 'result', command: 'DELETE', printer: 'Office Printer', jobId: 8, ok: false, error: '5' });
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    test('does not crash when the monitor is gone', () => {
      child.stdin.destroyed = true;
      expect(() => send(child, job({ jobId: 11, docName: 'x.pdf' }))).not.toThrow();
      expect(spawn).toHaveBeenCalledTimes(2); // falls back to the slower cancel
    });
  });

  test('the monitor script holds jobs, re-holds hand-resumed jobs and ignores virtual printers by port/driver', () => {
    printEnforcer.startMonitoring();
    const args = spawn.mock.calls[0][1];
    const bootstrap = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    const script = zlib.gunzipSync(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(bootstrap)[1], 'base64')).toString('utf8');
    expect(script).toContain('resumedByHand');
    expect(script).toContain("'PORTPROMPT:'");
    expect(script).toContain("'Microsoft Print To PDF*'");
    expect(script).toContain('AddSeconds(5)');
  });
});
