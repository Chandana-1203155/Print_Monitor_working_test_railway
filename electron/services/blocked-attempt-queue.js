/**
 * Blocked Attempt Queue
 *
 * When the print enforcer blocks a print made outside SecurePrint, nobody may be signed in to
 * SecurePrint, so the event cannot be sent to the server right away. It is saved here, in a
 * small JSON file, and delivered to the server the next time a user signs in.
 *
 * The queue is capped; when it is full the oldest entries are dropped.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT = 255;

function clean(value, max = MAX_TEXT) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

class BlockedAttemptQueue {
  constructor(filePath, maxEntries = 200) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return []; // missing or damaged file: start fresh rather than crash the enforcer
    }
  }

  _write(entries) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(entries), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  add({ document, printer, windowsUser, machine, occurredAt }) {
    const entries = this._read();
    entries.push({
      id: crypto.randomUUID(),
      document: clean(document) || 'Unknown document',
      printer: clean(printer, 100),
      windows_user: clean(windowsUser, 100),
      machine: clean(machine, 100),
      occurred_at: clean(occurredAt, 40) || new Date().toISOString()
    });
    this._write(entries.slice(-this.maxEntries));
  }

  peek(limit = 50) {
    return this._read().slice(0, limit);
  }

  remove(ids) {
    const gone = new Set(ids);
    this._write(this._read().filter(entry => !gone.has(entry.id)));
  }

  count() {
    return this._read().length;
  }
}

module.exports = BlockedAttemptQueue;
