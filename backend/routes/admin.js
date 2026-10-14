const express = require('express');
const router = express.Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  getAllUsers, createUser, toggleUserStatus,
  deleteUser, exportReport, updateUser, resetUserPassword, resetUserSecret,
  getReportById, listReports, deleteReport, getAuditLogs
} = require('../controllers/adminController');

router.get('/users', authenticate, requireAdmin, getAllUsers);
router.post('/users', authenticate, requireAdmin, createUser);
router.put('/users/:id', authenticate, requireAdmin, updateUser);
router.put('/users/:id/toggle', authenticate, requireAdmin, toggleUserStatus);
router.delete('/users/:id', authenticate, requireAdmin, deleteUser);
router.post('/users/:id/reset-password', authenticate, requireAdmin, resetUserPassword);
router.post('/users/:id/reset-secret', authenticate, requireAdmin, resetUserSecret);
router.get('/export', authenticate, requireAdmin, exportReport);
router.get('/reports', authenticate, requireAdmin, listReports);
router.get('/reports/:id/download', authenticate, requireAdmin, getReportById);
router.delete('/reports/:id', authenticate, requireAdmin, deleteReport);
router.get('/audit-logs', authenticate, requireAdmin, getAuditLogs);

module.exports = router;
