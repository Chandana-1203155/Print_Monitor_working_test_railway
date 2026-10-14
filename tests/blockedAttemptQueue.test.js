const fs = require('fs');
const os = require('os');
const path = require('path');
const BlockedAttemptQueue = require('../electron/services/blocked-attempt-queue');

describe('BlockedAttemptQueue', () => {
  let dir;
  let queue;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-queue-'));
    queue = new BlockedAttemptQueue(path.join(dir, 'blocked.json'), 3);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('saves attempts and survives a restart', () => {
    queue.add({ document: 'a.pdf', printer: 'HP', windowsUser: 'u', machine: 'PC1', occurredAt: '2026-10-14T00:00:00.000Z' });
    const reopened = new BlockedAttemptQueue(path.join(dir, 'blocked.json'));
    expect(reopened.count()).toBe(1);
    expect(reopened.peek()[0]).toEqual(expect.objectContaining({
      document: 'a.pdf', printer: 'HP', windows_user: 'u', machine: 'PC1', occurred_at: '2026-10-14T00:00:00.000Z'
    }));
  });

  test('removes only delivered entries', () => {
    ['a', 'b', 'c'].forEach(document => queue.add({ document }));
    const [first, second] = queue.peek();
    queue.remove([first.id]);
    expect(queue.peek().map(e => e.document)).toEqual(['b', 'c']);
    expect(queue.peek().some(e => e.id === second.id)).toBe(true);
  });

  test('keeps only the newest entries when full', () => {
    ['a', 'b', 'c', 'd'].forEach(document => queue.add({ document }));
    expect(queue.peek().map(e => e.document)).toEqual(['b', 'c', 'd']);
  });

  test('cleans control characters and limits length', () => {
    queue.add({ document: `bad\u0000name\n${'x'.repeat(400)}` });
    const [entry] = queue.peek();
    expect(entry.document).not.toMatch(/[\u0000-\u001f]/);
    expect(entry.document.length).toBeLessThanOrEqual(255);
  });

  test('treats a damaged file as empty instead of crashing', () => {
    fs.writeFileSync(path.join(dir, 'blocked.json'), '{not json');
    expect(queue.count()).toBe(0);
    expect(() => queue.add({ document: 'ok' })).not.toThrow();
  });
});
