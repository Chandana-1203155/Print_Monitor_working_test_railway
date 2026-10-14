const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [2, 100]
    }
  },
  username: {
    type: DataTypes.STRING(50),
    allowNull: true,
    unique: true,
    validate: {
      len: [2, 50]
    }
  },
  email: {
    type: DataTypes.STRING(150),
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  role: {
    type: DataTypes.ENUM('faculty', 'admin', 'superadmin'),
    defaultValue: 'faculty',
    allowNull: false
  },
  department: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  employee_id: {
    type: DataTypes.STRING(50),
    allowNull: true,
    unique: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive', 'pending'),
    defaultValue: 'active'
  },
  email_verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  force_password_change: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  last_login: {
    type: DataTypes.DATE,
    allowNull: true
  },
  secret_code_hash: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  reset_password_token_hash: {
    type: DataTypes.STRING(255),
    allowNull: true,
    unique: true
  },
  reset_password_expires: {
    type: DataTypes.DATE,
    allowNull: true
  },
  reset_secret_otp_hash: {
    type: DataTypes.STRING(255),
    allowNull: true,
    unique: true
  },
  reset_secret_otp_expires: {
    type: DataTypes.DATE,
    allowNull: true
  },
  failed_login_attempts: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  locked_until: {
    type: DataTypes.DATE,
    allowNull: true
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: true
  }
}, {
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 12);
      }
      if (user.secret_code_hash) {
        user.secret_code_hash = await bcrypt.hash(user.secret_code_hash, 12);
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 12);
      }
      if (user.changed('secret_code_hash')) {
        user.secret_code_hash = await bcrypt.hash(user.secret_code_hash, 12);
      }
    }
  }
});

User.prototype.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

User.prototype.compareSecretCode = async function(candidateSecretCode) {
  if (!this.secret_code_hash) return false;
  return bcrypt.compare(candidateSecretCode, this.secret_code_hash);
};

User.prototype.toSafeObject = function() {
  const { password, secret_code_hash, reset_password_token_hash, reset_secret_otp_hash, ...safe } = this.toJSON();
  return safe;
};

module.exports = User;
