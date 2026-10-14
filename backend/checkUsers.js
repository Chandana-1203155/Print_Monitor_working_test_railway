require('dotenv').config();
const { sequelize } = require('./config/database');
const { User } = require('./models');

(async () => {
  try {
    await sequelize.authenticate();
    const users = await User.findAll({ attributes: ['id', 'name', 'email', 'role'] });
    console.log(JSON.stringify(users.map(u => u.toJSON()), null, 2));
  } catch (e) {
    console.error('ERR', e.message);
    if (e.code) console.error('CODE', e.code);
  } finally {
    await sequelize.close();
  }
})();
