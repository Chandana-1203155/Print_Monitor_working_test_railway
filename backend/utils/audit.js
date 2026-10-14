const { AuditLog } = require('../models');

async function logAudit({ req, userId, username, role, action, metadata = {} }) {
  try {
    const data = {
      user_id: userId || null,
      username: username || null,
      role: role || null,
      action,
      metadata: metadata && Object.keys(metadata).length ? JSON.stringify(metadata) : null,
      ip_address: req && req.ip ? req.ip : null,
      user_agent: req && req.headers ? req.headers['user-agent'] : null,
      device_info: req && req.headers ? req.headers['user-agent'] : null
    };
    await AuditLog.create(data);
  } catch (err) {
    console.error('[AUDIT] failed to log:', err.message);
  }
}

module.exports = { logAudit };
