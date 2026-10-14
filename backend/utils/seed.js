const { User } = require('../models');

async function ensureSuperAdmin() {
  try {
    const {
      SUPER_ADMIN_EMAIL = 'superadmin@institution.edu',
      SUPER_ADMIN_USERNAME = 'superadmin',
      SUPER_ADMIN_PASSWORD,
      SUPER_ADMIN_SECRET_CODE
    } = process.env;

    if (!SUPER_ADMIN_PASSWORD || !SUPER_ADMIN_SECRET_CODE) {
      console.log('[SEED] SUPER_ADMIN_PASSWORD and SUPER_ADMIN_SECRET_CODE not set; skipping default superadmin creation.');
      return;
    }

    const existing = await User.findOne({ where: { role: 'superadmin' } });
    if (existing) {
      console.log('[SEED] Super admin already exists.');
      return;
    }

    await User.create({
      name: 'System Super Administrator',
      username: SUPER_ADMIN_USERNAME,
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
      role: 'superadmin',
      department: 'Administration',
      employee_id: 'SUPERADMIN001',
      secret_code_hash: SUPER_ADMIN_SECRET_CODE,
      is_active: true,
      status: 'active',
      email_verified: true,
      created_by: null
    });
    console.log('[SEED] Default superadmin created.');
  } catch (err) {
    console.error('[SEED] failed:', err.message);
  }
}

module.exports = { ensureSuperAdmin };
