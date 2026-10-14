const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const AuditLog = sequelize.define('AuditLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  username: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  role: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  action: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  ip_address: {
    type: DataTypes.STRING(45),
    allowNull: true
  },
  user_agent: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  device_info: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  metadata: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'audit_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(AuditLog, { foreignKey: 'user_id', as: 'auditLogs' });

module.exports = AuditLog;
