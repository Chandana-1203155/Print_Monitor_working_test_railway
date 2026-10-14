const { PrintLog, User } = require('../models');
const { Op, fn, col, literal } = require('sequelize');
const { calculateRangePages } = require('../utils/printPages');
const { logAudit } = require('../utils/audit');

// POST /api/print/log - Log a print job
const logPrint = async (req, res) => {
  try {
    const {
      file_name, file_path, num_pages, copies, page_range, printer_name,
      status, client_job_id, printed_at
    } = req.body;
    const user = req.user;

    if (!file_name || typeof file_name !== 'string') {
      return res.status(400).json({ success: false, message: 'File name is required.' });
    }
    if (client_job_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(client_job_id)) {
      return res.status(400).json({ success: false, message: 'Print job ID is invalid.' });
    }

    const documentPages = parseInt(num_pages) || 1;
    const selectedPages = calculateRangePages(page_range, documentPages);
    if (selectedPages < 1) {
      return res.status(400).json({ success: false, message: 'The page range selects no pages in this document.' });
    }
    const totalSheets = selectedPages * (parseInt(copies) || 1);
    const printTime = printed_at ? new Date(printed_at) : new Date();
    if (!Number.isFinite(printTime.getTime())) {
      return res.status(400).json({ success: false, message: 'Print timestamp is invalid.' });
    }
    const printStatus = status || 'success';
    if (!['success', 'failed', 'cancelled'].includes(printStatus)) {
      return res.status(400).json({ success: false, message: 'Print status is invalid.' });
    }

    const logData = {
      user_id: user.id,
      file_name,
      file_path: file_path || null,
      num_pages: selectedPages,
      copies: parseInt(copies) || 1,
      total_sheets: totalSheets,
      page_range: page_range || 'All',
      printer_name: printer_name || 'Default',
      client_job_id: client_job_id || null,
      status: printStatus,
      print_month: printTime.getMonth() + 1,
      print_year: printTime.getFullYear(),
      created_at: printTime
    };

    let log;
    let created = true;
    if (client_job_id) {
      [log, created] = await PrintLog.findOrCreate({
        where: { client_job_id },
        defaults: logData
      });
      if (!created && log.user_id !== user.id) {
        return res.status(409).json({ success: false, message: 'Print job ID is already associated with another account.' });
      }
    } else {
      log = await PrintLog.create(logData);
    }

    return res.status(created ? 201 : 200).json({
      success: true,
      message: created ? 'Print job logged successfully.' : 'Print job was already logged.',
      log
    });
  } catch (error) {
    console.error('Log print error:', error);
    return res.status(500).json({ success: false, message: 'Failed to log print job.' });
  }
};

// GET /api/print/my-logs - Faculty's own logs
const getMyLogs = async (req, res) => {
  try {
    const { page = 1, limit = 20, month, year } = req.query;
    const offset = (page - 1) * limit;
    const now = new Date();

    // Default to the current month/year unless the caller explicitly asks for all records
    const where = { user_id: req.user.id };
    if (month !== 'all' && year !== 'all') {
      where.print_month = month ? parseInt(month) : now.getMonth() + 1;
      where.print_year = year ? parseInt(year) : now.getFullYear();
    }

    const { count, rows } = await PrintLog.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    return res.json({
      success: true,
      logs: rows,
      total: count,
      pages: Math.ceil(count / limit),
      currentPage: parseInt(page)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch logs.' });
  }
};

// GET /api/print/admin/all-logs - Admin: all logs with filters
const getAllLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, user_id, month, year, status } = req.query;
    const offset = (page - 1) * limit;
    const now = new Date();

    const where = {};
    if (user_id) where.user_id = user_id;
    if (month) where.print_month = month;
    if (year) where.print_year = year;
    if (status) where.status = status;

    // Department-based filtering for admin role
    const userIncludeWhere = {};
    if (req.user.role === 'admin' && req.user.department) {
      userIncludeWhere.department = req.user.department;
    }

    const { count, rows } = await PrintLog.findAndCountAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'department', 'employee_id'], where: userIncludeWhere }],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    return res.json({
      success: true,
      logs: rows,
      total: count,
      pages: Math.ceil(count / limit),
      currentPage: parseInt(page)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch logs.' });
  }
};

// GET /api/print/admin/dashboard - Admin dashboard summary
const getDashboardStats = async (req, res) => {
  try {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Department-based filtering for admin role
    const deptFilter = (req.user.role === 'admin' && req.user.department) ? req.user.department : null;
    const userWhere = { role: 'faculty', is_active: true };
    if (deptFilter) userWhere.department = deptFilter;

    const userInclude = { model: User, as: 'user', attributes: ['name', 'department', 'employee_id'] };
    if (deptFilter) userInclude.where = { department: deptFilter };

    // Get faculty IDs in department for filtering print logs
    let deptUserIds = null;
    if (deptFilter) {
      const deptUsers = await User.findAll({ where: userWhere, attributes: ['id'] });
      deptUserIds = deptUsers.map(u => u.id);
    }

    const printWhereTodayBase = { created_at: { [Op.gte]: todayStart }, status: 'success' };
    const printWhereMonthBase = { print_month: currentMonth, print_year: currentYear, status: 'success' };
    if (deptUserIds) {
      printWhereTodayBase.user_id = { [Op.in]: deptUserIds };
      printWhereMonthBase.user_id = { [Op.in]: deptUserIds };
    }

    const todayActiveWhere = { created_at: { [Op.gte]: todayStart } };
    if (deptUserIds) todayActiveWhere.user_id = { [Op.in]: deptUserIds };

    const [todaySheets, monthSheets, totalUsers, activeToday] = await Promise.all([
      PrintLog.sum('total_sheets', { where: printWhereTodayBase }),
      PrintLog.sum('total_sheets', { where: printWhereMonthBase }),
      User.count({ where: userWhere }),
      PrintLog.count({ where: todayActiveWhere, distinct: true, col: 'user_id' })
    ]);

    // Top users this month
    const topWhere = { print_month: currentMonth, print_year: currentYear, status: 'success' };
    if (deptUserIds) topWhere.user_id = { [Op.in]: deptUserIds };
    const topUsers = await PrintLog.findAll({
      where: topWhere,
      attributes: ['user_id', [fn('SUM', col('total_sheets')), 'total']],
      include: [userInclude],
      group: ['user_id', 'user.id'],
      order: [[literal('total'), 'DESC']],
      limit: 5
    });

    // Daily usage last 7 days
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      const dayWhere = { created_at: { [Op.between]: [dayStart, dayEnd] }, status: 'success' };
      if (deptUserIds) dayWhere.user_id = { [Op.in]: deptUserIds };
      const sheets = await PrintLog.sum('total_sheets', { where: dayWhere }) || 0;
      last7Days.push({ date: dayStart.toISOString().split('T')[0], sheets });
    }

    return res.json({
      success: true,
      stats: {
        todaySheets: todaySheets || 0,
        monthSheets: monthSheets || 0,
        totalFaculty: totalUsers,
        activeToday: activeToday,
        topUsers,
        dailyTrend: last7Days
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats.' });
  }
};

// GET /api/print/admin/faculty-report - Per faculty report
const getFacultyReport = async (req, res) => {
  try {
    const { month, year } = req.query;
    const now = new Date();
    const targetMonth = month || now.getMonth() + 1;
    const targetYear = year || now.getFullYear();

    const userWhere = { role: 'faculty', is_active: true };
    // Department-based filtering for admin role
    if (req.user.role === 'admin' && req.user.department) {
      userWhere.department = req.user.department;
    }
    const users = await User.findAll({ where: userWhere });

    const report = await Promise.all(users.map(async (u) => {
      const totalSheets = await PrintLog.sum('total_sheets', {
        where: { user_id: u.id, print_month: targetMonth, print_year: targetYear, status: 'success' }
      }) || 0;
      const printCount = await PrintLog.count({
        where: { user_id: u.id, print_month: targetMonth, print_year: targetYear }
      });
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        department: u.department,
        employee_id: u.employee_id,
        totalSheets,
        printCount
      };
    }));

    return res.json({ success: true, report, month: targetMonth, year: targetYear });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to generate report.' });
  }
};

// Keeps text short and free of control characters before it is stored.
const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

const MAX_BLOCKED_ATTEMPTS_PER_REQUEST = 50;

// POST /api/print/blocked-attempts - The desktop app reports prints it blocked (made outside
// SecurePrint). They are kept locally until a user signs in, then sent here and stored in the
// audit log so admins can see them.
const reportBlockedAttempts = async (req, res) => {
  try {
    const { attempts } = req.body || {};
    if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > MAX_BLOCKED_ATTEMPTS_PER_REQUEST) {
      return res.status(400).json({
        success: false,
        message: `Send between 1 and ${MAX_BLOCKED_ATTEMPTS_PER_REQUEST} blocked attempts.`
      });
    }

    const now = Date.now();
    let recorded = 0;
    for (const attempt of attempts) {
      if (!attempt || typeof attempt !== 'object') continue;
      const occurred = new Date(attempt.occurred_at);
      const occurredAt = Number.isFinite(occurred.getTime()) && occurred.getTime() <= now + 86400000
        ? occurred.toISOString()
        : new Date(now).toISOString();
      await logAudit({
        req,
        userId: req.user.id,
        username: req.user.username || req.user.email,
        role: req.user.role,
        action: 'print_blocked',
        metadata: {
          document: cleanText(attempt.document, 255) || 'Unknown document',
          printer: cleanText(attempt.printer, 100),
          windows_user: cleanText(attempt.windows_user, 100),
          machine: cleanText(attempt.machine, 100),
          occurred_at: occurredAt
        }
      });
      recorded += 1;
    }

    return res.status(201).json({ success: true, recorded });
  } catch (error) {
    console.error('Report blocked attempts error:', error);
    return res.status(500).json({ success: false, message: 'Failed to record blocked print attempts.' });
  }
};

module.exports = { logPrint, getMyLogs, getAllLogs, getDashboardStats, getFacultyReport, reportBlockedAttempts };
