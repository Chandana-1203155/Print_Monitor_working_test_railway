const User = require('./User');
const PrintLog = require('./PrintLog');
const Report = require('./Report');
const AuditLog = require('./AuditLog');

// Associations
User.hasMany(PrintLog, { foreignKey: 'user_id', as: 'printLogs' });
PrintLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

module.exports = { User, PrintLog, Report, AuditLog };
