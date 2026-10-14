const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PrintLog = sequelize.define('PrintLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  file_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  file_path: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  num_pages: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  copies: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  total_sheets: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  page_range: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: 'All'
  },
  printer_name: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  client_job_id: {
    type: DataTypes.UUID,
    allowNull: true,
    unique: true
  },
  status: {
    type: DataTypes.ENUM('success', 'failed', 'cancelled'),
    defaultValue: 'success'
  },
  print_month: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  print_year: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
}, {
  tableName: 'print_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = PrintLog;
