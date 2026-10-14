const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const Report = sequelize.define('Report', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  report_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  report_type: {
    type: DataTypes.STRING(50),
    defaultValue: 'excel'
  },
  generated_by: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  report_data: {
    type: DataTypes.BLOB('long'),
    allowNull: true
  },
  report_size: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  month: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  year: {
    type: DataTypes.INTEGER,
    allowNull: true
  }
}, {
  tableName: 'reports',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

Report.belongsTo(User, { foreignKey: 'generated_by', as: 'generatedBy' });
User.hasMany(Report, { foreignKey: 'generated_by', as: 'reports' });

module.exports = Report;
