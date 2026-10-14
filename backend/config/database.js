const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME || 'monitor_print',
  process.env.DB_USER || 'root',
  process.env.DB_PASS || '',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    }
  }
);

const connectDB = async () => {
  try {
    await sequelize.authenticate();
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.error('Check that XAMPP MySQL is running on the configured host and port.');
    process.exit(1);
    return;
  }

  console.log('✅ MySQL (XAMPP) connected successfully.');
  try {
    // Create missing tables only; alter:true can repeatedly add duplicate MySQL indexes.
    await sequelize.sync();
    console.log('✅ Database tables synchronized.');
  } catch (error) {
    console.error('❌ Database schema initialization failed:', error.message);
    process.exit(1);
  }
};

module.exports = { sequelize, connectDB };
