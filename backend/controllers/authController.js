const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { User } = require('../models');
const { logAudit } = require('../utils/audit');
const emailService = require('../services/emailService');
require('dotenv').config();

const RESET_EXPIRES_MS = () => parseInt(process.env.RESET_TOKEN_EXPIRES_MS, 10) || 15 * 60 * 1000;
const MAX_FAILED_LOGINS = () => parseInt(process.env.MAX_FAILED_LOGINS, 10) || 5;
const LOCKOUT_MINUTES = () => parseInt(process.env.LOCKOUT_MINUTES, 10) || 15;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3010';

const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
};

const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

const isLocked = (user) => {
  if (!user.locked_until) return false;
  return new Date(user.locked_until) > new Date();
};

const recordFailedLogin = async (user, req) => {
  const attempts = (user.failed_login_attempts || 0) + 1;
  const updates = { failed_login_attempts: attempts };
  if (attempts >= MAX_FAILED_LOGINS()) {
    updates.locked_until = new Date(Date.now() + LOCKOUT_MINUTES() * 60 * 1000);
    await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'account_locked', metadata: { failed_attempts: attempts, locked_until: updates.locked_until } });
  }
  await user.update(updates);
};

const resetFailedLogins = async (user) => {
  if (user.failed_login_attempts || user.locked_until) {
    await user.update({ failed_login_attempts: 0, locked_until: null });
  }
};

// Public self-registration is disabled. Accounts must be created by an admin or superadmin.
// Use POST /api/admin/users from an authenticated admin/superadmin session.

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { identifier, password, secretCode } = req.body;

    if (!identifier || !password) {
      await logAudit({ req, action: 'failed_login', metadata: { reason: 'missing fields' } });
      return res.status(400).json({ success: false, message: 'Username/email and password are required.' });
    }

    const user = await User.findOne({
      where: {
        [Op.or]: [
          { email: identifier.trim() },
          { username: identifier.trim() }
        ]
      }
    });

    if (!user) {
      await logAudit({ req, action: 'failed_login', metadata: { identifier } });
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const isAdminAccount = ['admin', 'superadmin'].includes(user.role);
    if (!isAdminAccount && isLocked(user)) {
      await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'failed_login', metadata: { reason: 'account_locked', locked_until: user.locked_until } });
      return res.status(403).json({ success: false, message: 'Account temporarily locked. Try again later or contact an administrator.' });
    }

    if (!user.is_active || user.status === 'inactive') {
      await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'login_blocked_inactive' });
      return res.status(403).json({ success: false, message: 'Account deactivated. Contact admin.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      if (!isAdminAccount) await recordFailedLogin(user, req);
      await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'failed_login' });
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    if (isAdminAccount) {
      if (!secretCode) {
        return res.status(400).json({ success: false, message: 'Secret access code required for this role.' });
      }
      const codeMatch = await user.compareSecretCode(secretCode);
      if (!codeMatch) {
        await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'failed_secret_code' });
        return res.status(401).json({ success: false, message: 'Invalid secret access code.' });
      }
    }

    await resetFailedLogins(user);
    await user.update({ last_login: new Date() });
    const token = generateToken(user);
    const safeUser = user.toSafeObject();

    await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'login_success' });

    return res.json({
      success: true,
      message: `Welcome back, ${user.name}!`,
      token,
      user: safeUser,
      forcePasswordChange: user.force_password_change
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, message: 'Login failed.' });
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    return res.json({ success: true, user: user.toSafeObject() });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error fetching profile.' });
  }
};

// POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      await logAudit({ req, action: 'forgot_password', metadata: { email, result: 'email_not_found' } });
      return res.status(200).json({ success: true, message: 'If the email exists, a reset link has been sent.' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_EXPIRES_MS());

    await user.update({ reset_password_token_hash: tokenHash, reset_password_expires: expiresAt });
    const resetUrl = `${APP_BASE_URL}/reset-password?token=${rawToken}`;

    const emailResult = await emailService.sendPasswordReset(user.email, resetUrl);
    await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'forgot_password', metadata: { email, email_sent: emailResult.success } });

    return res.status(200).json({
      success: true,
      message: 'If the email exists, a reset link has been sent.'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ success: false, message: 'Error processing request.' });
  }
};

// POST /api/auth/reset-password
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const tokenHash = hashToken(token);
    const user = await User.findOne({ where: { reset_password_token_hash: tokenHash } });
    if (!user || new Date() > new Date(user.reset_password_expires)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
    }

    user.password = newPassword;
    user.reset_password_token_hash = null;
    user.reset_password_expires = null;
    user.force_password_change = false;
    await user.save();

    await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'password_reset' });
    emailService.sendSecurityAlert(user.email, 'Password Reset Successful', 'Your SecurePrint password has been reset.').catch(() => {});

    return res.json({ success: true, message: 'Password updated successfully. Please log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ success: false, message: 'Error resetting password.' });
  }
};

// POST /api/auth/forgot-secret
const forgotSecret = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      await logAudit({ req, action: 'forgot_secret', metadata: { email, result: 'email_not_found' } });
      return res.status(200).json({ success: true, message: 'If the email exists, a reset code has been sent.' });
    }

    if (!['admin', 'superadmin'].includes(user.role)) {
      return res.status(400).json({ success: false, message: 'Secret access code is only for admin accounts.' });
    }

    const rawOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = hashToken(rawOtp);
    const expiresAt = new Date(Date.now() + RESET_EXPIRES_MS());

    await user.update({ reset_secret_otp_hash: otpHash, reset_secret_otp_expires: expiresAt });

    const emailResult = await emailService.sendSecretResetOtp(user.email, rawOtp);
    await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'forgot_secret', metadata: { email, email_sent: emailResult.success } });

    return res.status(200).json({
      success: true,
      message: 'If the email exists, a reset code has been sent.'
    });
  } catch (error) {
    console.error('Forgot secret error:', error);
    return res.status(500).json({ success: false, message: 'Error processing request.' });
  }
};

// POST /api/auth/reset-secret
const resetSecret = async (req, res) => {
  try {
    const { otp, newSecretCode } = req.body;
    if (!otp || !newSecretCode) {
      return res.status(400).json({ success: false, message: 'OTP and new secret code are required.' });
    }
    if (newSecretCode.length < 6) {
      return res.status(400).json({ success: false, message: 'Secret code must be at least 6 characters.' });
    }

    const otpHash = hashToken(otp);
    const user = await User.findOne({ where: { reset_secret_otp_hash: otpHash } });
    if (!user || new Date() > new Date(user.reset_secret_otp_expires)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset code.' });
    }

    user.secret_code_hash = newSecretCode;
    user.reset_secret_otp_hash = null;
    user.reset_secret_otp_expires = null;
    await user.save();
    await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'secret_code_reset' });
    emailService.sendSecurityAlert(user.email, 'Secret Code Reset Successful', 'Your SecurePrint secret access code has been changed.').catch(() => {});

    return res.json({ success: true, message: 'Secret access code updated successfully.' });
  } catch (error) {
    console.error('Reset secret error:', error);
    return res.status(500).json({ success: false, message: 'Error resetting secret code.' });
  }
};

// POST /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Current password and a new password of at least 6 characters are required.' });
    }

    const user = await User.findByPk(req.user.id);
    const match = await user.comparePassword(currentPassword);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    user.force_password_change = false;
    await user.save();
    await logAudit({ req, userId: user.id, username: user.username || user.email, role: user.role, action: 'password_change' });

    return res.json({ success: true, message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ success: false, message: 'Error changing password.' });
  }
};

module.exports = { login, getMe, forgotPassword, resetPassword, forgotSecret, resetSecret, changePassword };
