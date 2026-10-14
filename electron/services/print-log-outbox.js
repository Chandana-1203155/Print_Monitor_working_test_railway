const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class PrintLogOutbox {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = null;
  }

  initialize() {
    if (this.records) return this.getStatus();

    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(stored)) throw new Error('Outbox data must be an array.');
      this.records = stored;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.records = [];
      } else {
        throw new Error(`Unable to read the print log outbox: ${error.message}`);
      }
    }

    return this.getStatus();
  }

  addAttempt(payload, userId) {
    this.ensureInitialized();
    const record = {
      client_job_id: randomUUID(),
      user_id: userId,
      state: 'printing',
      payload: { ...payload },
      created_at: new Date().toISOString()
    };
    this.records.push(record);
    this.persist();
    return record.client_job_id;
  }

  markSucceeded(clientJobId, printedAt) {
    this.ensureInitialized();
    const record = this.records.find(item => item.client_job_id === clientJobId);
    if (!record) throw new Error(`Print log outbox entry ${clientJobId} was not found.`);
    record.state = 'pending';
    record.payload = { ...record.payload, client_job_id: clientJobId, printed_at: printedAt };
    this.persist();
  }

  removeAttempt(clientJobId) {
    this.ensureInitialized();
    const originalLength = this.records.length;
    this.records = this.records.filter(item => item.client_job_id !== clientJobId);
    if (this.records.length !== originalLength) this.persist();
  }

  getPending(userId) {
    this.ensureInitialized();
    return this.records.filter(record => (
      record.state === 'pending' && (userId === undefined || record.user_id === userId)
    ));
  }

  removeDelivered(clientJobId) {
    this.ensureInitialized();
    const originalLength = this.records.length;
    this.records = this.records.filter(item => item.client_job_id !== clientJobId);
    if (this.records.length !== originalLength) this.persist();
  }

  getStatus(userId) {
    this.ensureInitialized();
    const records = this.records.filter(record => userId === undefined || record.user_id === userId);
    return {
      pending: records.filter(record => record.state === 'pending').length,
      uncertain: records
        .filter(record => record.state === 'printing')
        .map(record => ({
          client_job_id: record.client_job_id,
          user_id: record.user_id,
          file_name: record.payload.file_name,
          created_at: record.created_at
        }))
    };
  }

  ensureInitialized() {
    if (!this.records) this.initialize();
  }

  persist() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify(this.records), 'utf8');
      fs.fsyncSync(descriptor);
      const completedDescriptor = descriptor;
      descriptor = undefined;
      fs.closeSync(completedDescriptor);
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          console.error('[PrintLogOutbox] Failed to remove temporary outbox file:', cleanupError.message);
        }
      }
      throw new Error(`Unable to persist the print log outbox: ${error.message}`);
    }
  }
}

module.exports = PrintLogOutbox;
