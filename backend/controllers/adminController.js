const { User, PrintLog, Report, AuditLog } = require('../models');
const { Op } = require('sequelize');
const xlsx = require('xlsx');
const crypto = require('crypto');
const { logAudit } = require('../utils/audit');
const emailService = require('../services/emailService');

const departmentsMatch = (first, second) => (
  typeof first === 'string' &&
  typeof second === 'string' &&
  first.trim().toLowerCase() === second.trim().toLowerCase()
);

// GET /api/admin/users - List all users
const getAllUsers = async (req, res) => {
  try {
    const where = {};
    // Department-based filtering: admins only see users in their department
    if (req.user.role === 'admin' && req.user.department) {
      where[Op.or] = [
        { department: req.user.department },
        { role: 'admin', id: req.user.id }
      ];
    }
    const users = await User.findAll({
      where,
      attributes: { exclude: ['password', 'secret_code_hash'] },
      order: [['created_at', 'DESC']]
    });
    // Admins should never see superadmin accounts
    const filtered = req.user.role === 'admin'
      ? users.filter(u => u.role !== 'superadmin')
      : users;
    return res.json({ success: true, users: filtered });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch users.' });
  }
};

// PUT /api/admin/users/:id/toggle - Activate/deactivate user
const toggleUserStatus = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'superadmin') return res.status(403).json({ success: false, message: 'Cannot modify super admin accounts.' });
    if (user.role === 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Only super admin can modify admin accounts.' });

    const newState = !user.is_active;
    const newStatus = newState ? 'active' : 'inactive';
    await user.update({ is_active: newState, status: newStatus });
    await logAudit({ req, userId: req.user.id, username: req.user.username || req.user.email, role: req.user.role, action: 'user_status_toggled', metadata: { target_user_id: user.id, target_role: user.role, is_active: newState, status: newStatus } });
    emailService.sendSecurityAlert(user.email, 'Account Status Changed', `Your SecurePrint account has been ${newStatus}.`).catch(() => {});
    return res.json({
      success: true,
      message: `User ${newState ? 'activated' : 'deactivated'} successfully.`,
      is_active: newState,
      status: newStatus
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to toggle user status.' });
  }
};

// DELETE /api/admin/users/:id - Delete user
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'superadmin') return res.status(403).json({ success: false, message: 'Cannot delete super admin accounts.' });
    if (user.role === 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Only super admin can delete admin accounts.' });
    if (user.id === req.user.id) return res.status(403).json({ success: false, message: 'Cannot delete your own account.' });

    await PrintLog.destroy({ where: { user_id: user.id } });
    await user.destroy();
    await logAudit({ req, userId: req.user.id, username: req.user.username || req.user.email, role: req.user.role, action: 'user_deleted', metadata: { deleted_user_id: user.id, deleted_role: user.role } });
    return res.json({ success: true, message: 'User deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete user.' });
  }
};

const formatReportWorkbook = (data, summaryData) => {
  const wb = xlsx.utils.book_new();
  const logHeaders = ['S.No', 'Faculty Name', 'Employee ID', 'Department', 'Email', 'File Name', 'Copies', 'Total Sheets', 'Page Range', 'Printer', 'Status', 'Date & Time'];
  const summaryHeaders = ['Faculty Name', 'Employee ID', 'Department', 'Number of Prints', 'Total Sheets Used'];

  const ws1 = xlsx.utils.aoa_to_sheet([logHeaders]);
  const ws2 = xlsx.utils.aoa_to_sheet([summaryHeaders]);

  const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFFFF' } }, fill: { fgColor: { rgb: 'FF2563EB' } }, alignment: { horizontal: 'center' } };
  const range1 = xlsx.utils.decode_range(ws1['!ref'] || 'A1:Z1');
  const range2 = xlsx.utils.decode_range(ws2['!ref'] || 'A1:Z1');

  for (let c = range1.s.c; c <= range1.e.c; c += 1) {
    const cell = ws1[xlsx.utils.encode_cell({ r: range1.s.r, c })];
    if (cell) cell.s = headerStyle;
  }
  for (let c = range2.s.c; c <= range2.e.c; c += 1) {
    const cell = ws2[xlsx.utils.encode_cell({ r: range2.s.r, c })];
    if (cell) cell.s = headerStyle;
  }

  if (data.length > 0) {
    xlsx.utils.sheet_add_json(ws1, data, { origin: 'A2', skipHeader: true });
  } else {
    ws1['A2'] = { v: 'No records found', t: 's' };
  }

  if (summaryData.length > 0) {
    xlsx.utils.sheet_add_json(ws2, summaryData, { origin: 'A2', skipHeader: true });
  } else {
    ws2['A2'] = { v: 'No records found', t: 's' };
  }

  ws1['!cols'] = logHeaders.map((header) => ({ width: Math.max(12, header.length + 2) }));
  ws2['!cols'] = summaryHeaders.map((header) => ({ width: Math.max(12, header.length + 2) }));

  xlsx.utils.book_append_sheet(wb, ws1, 'Print Logs');
  xlsx.utils.book_append_sheet(wb, ws2, 'Faculty Summary');

  return wb;
};

const buildReportPayload = async (targetMonth, targetYear, department = null) => {
  const userInclude = { model: User, as: 'user', attributes: ['name', 'email', 'department', 'employee_id'] };
  if (department) userInclude.where = { department };

  const logs = await PrintLog.findAll({
    where: { print_month: targetMonth, print_year: targetYear },
    include: [userInclude],
    order: [['created_at', 'DESC']]
  });

  const data = logs.length > 0 ? logs.map((log, i) => ({
    'S.No': i + 1,
    'Faculty Name': log.user?.name || 'N/A',
    'Employee ID': log.user?.employee_id || 'N/A',
    'Department': log.user?.department || 'N/A',
    'Email': log.user?.email || 'N/A',
    'File Name': log.file_name,
    'Copies': log.copies,
    'Total Sheets': log.total_sheets,
    'Page Range': log.page_range,
    'Printer': log.printer_name,
    'Status': log.status,
    'Date & Time': new Date(log.created_at).toLocaleString()
  })) : [];

  const userWhere = { role: 'faculty', is_active: true };
  if (department) userWhere.department = department;
  const users = await User.findAll({ where: userWhere });
  const summaryData = await Promise.all(users.map(async (u) => {
    const total = await PrintLog.sum('total_sheets', {
      where: { user_id: u.id, print_month: targetMonth, print_year: targetYear, status: 'success' }
    }) || 0;
    const printCount = await PrintLog.count({
      where: { user_id: u.id, print_month: targetMonth, print_year: targetYear }
    });
    return {
      'Faculty Name': u.name,
      'Employee ID': u.employee_id || 'N/A',
      'Department': u.department || 'N/A',
      'Number of Prints': printCount,
      'Total Sheets Used': total,
    };
  }));

  return { data, summaryData };
};

// GET /api/admin/export - Export report to Excel
const exportReport = async (req, res) => {
  try {
    const { month, year } = req.query;
    const now = new Date();
    const targetMonth = parseInt(month) || now.getMonth() + 1;
    const targetYear = parseInt(year) || now.getFullYear();

    // Department-based filtering for admin role
    const deptFilter = (req.user.role === 'admin' && req.user.department) ? req.user.department : null;
    const { data, summaryData } = await buildReportPayload(targetMonth, targetYear, deptFilter);
    const workbook = formatReportWorkbook(data, summaryData);
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fileName = `PrintReport_${monthNames[targetMonth - 1] || 'Report'}_${targetYear}.xlsx`;

    const reportRecord = await Report.create({
      report_name: fileName,
      report_type: 'excel',
      generated_by: req.user.id,
      report_data: buffer,
      report_size: buffer.length,
      month: targetMonth,
      year: targetYear,
      created_at: new Date()
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Report-Id', reportRecord.id);
    return res.send(buffer);
  } catch (error) {
    console.error('Export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export report.', error: error.message });
  }
};

const getReportById = async (req, res) => {
  try {
    const report = await Report.findByPk(req.params.id, {
      include: [{ model: User, as: 'generatedBy', attributes: ['name', 'email'] }]
    });

    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found.' });
    }

    const fileName = report.report_name || `report_${report.id}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(report.report_data);
  } catch (error) {
    console.error('Download report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to download report.', error: error.message });
  }
};

const listReports = async (req, res) => {
  try {
    const { month, year, search } = req.query;
    const where = {};

    if (month) where.month = month;
    if (year) where.year = year;
    if (search) {
      where.report_name = { [Op.like]: `%${search}%` };
    }

    const reports = await Report.findAll({
      where,
      include: [{ model: User, as: 'generatedBy', attributes: ['name', 'email'] }],
      order: [['created_at', 'DESC']]
    });

    return res.json({ success: true, reports: reports.map((report) => ({
      id: report.id,
      report_name: report.report_name,
      generated_by: report.generatedBy?.name || 'Unknown',
      generated_at: report.created_at,
      month: report.month,
      year: report.year,
      file_size: report.report_size
    })) });
  } catch (error) {
    console.error('List reports error:', error);
    return res.status(500).json({ success: false, message: 'Failed to list reports.', error: error.message });
  }
};

const deleteReport = async (req, res) => {
  try {
    const report = await Report.findByPk(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found.' });
    }

    await report.destroy();
    return res.json({ success: true, message: 'Report deleted successfully.' });
  } catch (error) {
    console.error('Delete report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete report.', error: error.message });
  }
};

// PUT /api/admin/users/:id - Update user details
const updateUser = async (req, res) => {
  try {
    const { name, department, employee_id, is_active, status, role } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'superadmin') return res.status(403).json({ success: false, message: 'Cannot modify super admin accounts.' });
    if (role === 'superadmin') return res.status(403).json({ success: false, message: 'Cannot promote to super admin.' });

    if (req.user.role === 'admin' && user.role === 'faculty') {
      if (!departmentsMatch(user.department, req.user.department)) {
        return res.status(403).json({ success: false, message: 'You can only modify faculty in your department.' });
      }
      if (department !== undefined && !departmentsMatch(department, req.user.department)) {
        return res.status(403).json({ success: false, message: 'You can only assign faculty to your department.' });
      }
    }

    if (role === 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ success: false, message: 'Only super admin can assign admin role.' });
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (department !== undefined) {
      updates.department = req.user.role === 'admin' && user.role === 'faculty'
        ? req.user.department
        : department;
    }
    if (employee_id !== undefined) updates.employee_id = employee_id;
    if (is_active !== undefined) {
      updates.is_active = is_active;
      updates.status = is_active ? 'active' : 'inactive';
    }
    if (status !== undefined) {
      updates.status = status;
      updates.is_active = status === 'active';
    }
    if (role !== undefined) updates.role = role;

    await user.update(updates);
    await logAudit({ req, userId: req.user.id, username: req.user.username || req.user.email, role: req.user.role, action: 'user_updated', metadata: { target_user_id: user.id, changes: Object.keys(updates) } });
    return res.json({ success: true, message: 'User updated successfully.', user: user.toSafeObject() });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update user.' });
  }
};

// POST /api/admin/users - Create user (admin/faculty) by admin or superadmin
const createUser = async (req, res) => {
  try {
    const { name, username, email, password, role, department, employee_id, secretCode } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    if (!['faculty', 'admin'].includes(role)) return res.status(400).json({ success: false, message: 'Role must be faculty or admin.' });
    if (role === 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Only super admin can create admin accounts.' });
    if (role === 'admin' && (!secretCode || secretCode.length < 6)) return res.status(400).json({ success: false, message: 'Admin secret access code is required (min 6 chars).' });

    if (req.user.role === 'admin') {
      if (!req.user.department) {
        return res.status(403).json({ success: false, message: 'Your account must have an assigned department to create faculty accounts.' });
      }
      if (department && !departmentsMatch(department, req.user.department)) {
        return res.status(403).json({ success: false, message: 'You can only create faculty in your department.' });
      }
    }

    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) return res.status(409).json({ success: false, message: 'Email already registered.' });

    if (username) {
      const existingUsername = await User.findOne({ where: { username } });
      if (existingUsername) return res.status(409).json({ success: false, message: 'Username already taken.' });
    }

    if (employee_id) {
      const existingEmp = await User.findOne({ where: { employee_id } });
      if (existingEmp) return res.status(409).json({ success: false, message: 'Employee ID already in use.' });
    }

    const user = await User.create({
      name,
      username: username || null,
      email,
      password,
      role,
      department: req.user.role === 'admin' ? req.user.department : (department || null),
      employee_id: employee_id || null,
      secret_code_hash: role === 'admin' ? secretCode : null,
      force_password_change: true,
      is_active: true,
      status: 'active',
      email_verified: false,
      created_by: req.user.id
    });

    if (role === 'admin') {
      emailService.sendAdminInvitation(email, name, password, secretCode).catch(() => {});
    } else {
      emailService.sendFacultyInvitation(email, name, password).catch(() => {});
    }

    await logAudit({ req, userId: req.user.id, username: req.user.username || req.user.email, role: req.user.role, action: 'user_created', metadata: { created_user_id: user.id, role } });
    return res.status(201).json({ success: true, message: 'Account created and invitation sent.', user: user.toSafeObject() });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to create user.', error: error.message });
  }
};

// POST /api/admin/users/:id/reset-password
const resetUserPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'superadmin' && req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Only super admin can reset super admin password.' });
    if (user.role === 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Only super admin can reset admin password.' });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    user.password = newPassword;
    user.force_password_change = true;
    await user.save();
    await logAudit({ req, userId: req.user.id, username: req.user.username || req.user.email, role: req.user.role, action: 'password_reset_by_admin', metadata: { target_user_id: user.id, target_role: user.role } });
    emailService.sendSecurityAlert(user.email, 'Password Reset by Administrator', 'Your SecurePrint password has been reset by an administrator.').catch(() => {});
    return res.json({ success: true, message: 'Password reset successfully. User must change it on next login.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to reset password.' });
  }
};

// POST /api/admin/users/:id/reset-secret
const resetUserSecret = async (req, res) => {
  try {
    const { newSecretCode } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!['admin', 'superadmin'].includes(user.role)) return res.status(400).json({ success: false, message: 'Secret code only applies to admin accounts.' });
    if (user.role === 'superadmin' && req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Only super admin can reset super admin secret.' });
    if (!newSecretCode || newSecretCode.length < 6) return res.status(400).json({ success: false, message: 'Secret code must be at least 6 characters.' });

    user.secret_code_hash = newSecretCode;
    await user.save();
    await logAudit({ req, userId: req.user.id, username: req.user.username || req.user.email, role: req.user.role, action: 'secret_code_reset_by_admin', metadata: { target_user_id: user.id, target_role: user.role } });
    emailService.sendSecurityAlert(user.email, 'Secret Code Reset by Administrator', 'Your SecurePrint secret access code has been reset by an administrator.').catch(() => {});
    return res.json({ success: true, message: 'Secret access code reset successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to reset secret code.' });
  }
};

// GET /api/admin/audit-logs
const getAuditLogs = async (req, res) => {
  try {
    const { action, search, page = 1, perPage = 50 } = req.query;
    const where = {};
    if (action) where.action = { [Op.like]: `%${action}%` };
    if (search) {
      where[Op.or] = [
        { username: { [Op.like]: `%${search}%` } },
        { role: { [Op.like]: `%${search}%` } },
        { action: { [Op.like]: `%${search}%` } }
      ];
    }

    const offset = (parseInt(page) - 1) * parseInt(perPage);
    const { count, rows } = await AuditLog.findAndCountAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['name', 'email'] }],
      order: [['created_at', 'DESC']],
      limit: parseInt(perPage),
      offset
    });

    return res.json({ success: true, logs: rows, total: count, pages: Math.ceil(count / perPage) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch audit logs.', error: error.message });
  }
};

module.exports = { getAllUsers, createUser, toggleUserStatus, deleteUser, updateUser, resetUserPassword, resetUserSecret, getAuditLogs, exportReport, getReportById, listReports, deleteReport };
