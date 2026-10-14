const express = require('express');
const router = express.Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  logPrint, getMyLogs, reportBlockedAttempts,
  getAllLogs, getDashboardStats, getFacultyReport
} = require('../controllers/printController');

// Faculty routes
router.post('/log', authenticate, logPrint);
router.get('/my-logs', authenticate, getMyLogs);
router.post('/blocked-attempts', authenticate, reportBlockedAttempts);

// Admin routes
router.get('/admin/all-logs', authenticate, requireAdmin, getAllLogs);
router.get('/admin/dashboard', authenticate, requireAdmin, getDashboardStats);
router.get('/admin/faculty-report', authenticate, requireAdmin, getFacultyReport);

module.exports = router;
