const fs = require('fs');
const os = require('os');
const path = require('path');
const PrintLogOutbox = require('../electron/services/print-log-outbox');

describe('PrintLogOutbox', () => {
  let directory;
  let filePath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secureprint-outbox-'));
    filePath = path.join(directory, 'print-log-outbox.json');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('persists a print intent before printing and retains uncertain outcomes after restart', () => {
    const outbox = new PrintLogOutbox(filePath);
    const clientJobId = outbox.addAttempt({ file_name: 'report.pdf' }, 42);

    expect(outbox.getStatus(42).uncertain).toHaveLength(1);

    const recoveredOutbox = new PrintLogOutbox(filePath);
    expect(recoveredOutbox.getStatus(42).uncertain[0]).toEqual(expect.objectContaining({
      client_job_id: clientJobId,
      user_id: 42,
      file_name: 'report.pdf'
    }));
  });

  test('persists successful records for retry and removes them only after delivery', () => {
    const outbox = new PrintLogOutbox(filePath);
    const clientJobId = outbox.addAttempt({ file_name: 'report.pdf' }, 42);
    const printedAt = '2026-10-08T01:00:00.000Z';
    outbox.markSucceeded(clientJobId, printedAt);

    const recoveredOutbox = new PrintLogOutbox(filePath);
    expect(recoveredOutbox.getPending(42)).toHaveLength(1);
    expect(recoveredOutbox.getPending(99)).toHaveLength(0);
    expect(recoveredOutbox.getPending(42)[0].payload).toEqual(expect.objectContaining({
      client_job_id: clientJobId,
      printed_at: printedAt,
      file_name: 'report.pdf'
    }));

    recoveredOutbox.removeDelivered(clientJobId);
    expect(new PrintLogOutbox(filePath).getPending(42)).toHaveLength(0);
  });

  test('removes an attempt that definitively failed to print', () => {
    const outbox = new PrintLogOutbox(filePath);
    const clientJobId = outbox.addAttempt({ file_name: 'report.pdf' }, 42);
    outbox.removeAttempt(clientJobId);

    expect(outbox.getStatus(42)).toEqual({ pending: 0, uncertain: [] });
  });
});
