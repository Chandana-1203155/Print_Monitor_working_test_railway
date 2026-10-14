const express = require('express');
const router = express.Router();
const { login, getMe, forgotPassword, resetPassword, forgotSecret, resetSecret, changePassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' }
});

router.post('/login', loginLimiter, login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/forgot-secret', forgotSecret);
router.post('/reset-secret', resetSecret);
router.post('/change-password', authenticate, changePassword);
router.get('/me', authenticate, getMe);

module.exports = router;
