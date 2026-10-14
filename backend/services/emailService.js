const nodemailer = require('nodemailer');

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE = 'false' } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: true }
  });
}

async function send({ to, subject, html, text }) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `SecurePrint <${process.env.SMTP_USER || 'noreply@example.com'}>`;

  if (!transporter) {
    console.warn('[EMAIL] SMTP not configured. Email not sent:', { to, subject });
    return { success: false, reason: 'SMTP not configured' };
  }

  try {
    const info = await transporter.sendMail({ from, to, subject, html, text });
    console.log('[EMAIL] Sent to', to, '-', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[EMAIL] Failed to send:', err.message);
    return { success: false, error: err.message };
  }
}

function baseTemplate(title, body) {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>${title}</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 20px; color: #1f2937; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb; }
        .header { background: #2563eb; color: #ffffff; padding: 28px; text-align: center; }
        .header h1 { margin: 0; font-size: 22px; }
        .content { padding: 28px; line-height: 1.6; }
        .btn { display: inline-block; background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; }
        .footer { padding: 20px; text-align: center; color: #9ca3af; font-size: 12px; }
        .code { background: #f3f4f6; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 18px; text-align: center; letter-spacing: 2px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header"><h1>SecurePrint</h1></div>
        <div class="content">${body}</div>
        <div class="footer">
          This is an automated security message from SecurePrint.<br/>
          If you did not request this action, please contact your administrator immediately.
        </div>
      </div>
    </body>
    </html>
  `;
}

async function sendPasswordReset(email, resetUrl) {
  const body = `
        <h2>Password Reset Request</h2>
        <p>We received a request to reset your SecurePrint password. Click the button below to set a new password. This link expires in 15 minutes and can only be used once.</p>
        <p style="text-align:center;"><a class="btn" href="${resetUrl}">Reset Password</a></p>
        <p>Or copy this link into your browser:</p>
        <p style="word-break:break-all;">${resetUrl}</p>
        <p>If you did not request this reset, please ignore this email.</p>
      `;
  return send({ to: email, subject: 'SecurePrint Password Reset', html: baseTemplate('Password Reset', body) });
}

async function sendSecretResetOtp(email, otp) {
  const body = `
        <h2>Secret Access Code Reset</h2>
        <p>Use the one-time code below to reset your SecurePrint admin secret access code. This code expires in 15 minutes and can only be used once.</p>
        <div class="code">${otp}</div>
        <p>Do not share this code with anyone.</p>
        <p>If you did not request this reset, contact your super administrator immediately.</p>
      `;
  return send({ to: email, subject: 'SecurePrint Secret Code Reset OTP', html: baseTemplate('Secret Code Reset', body) });
}

async function sendActivation(email, name, tempPassword) {
  const body = `
        <h2>Welcome to SecurePrint, ${name}</h2>
        <p>Your account has been created. Use the temporary password below to sign in. You will be required to change it on first login.</p>
        <div class="code">${tempPassword}</div>
        <p>Please keep your credentials safe and never share your secret access code.</p>
      `;
  return send({ to: email, subject: 'Your SecurePrint Account', html: baseTemplate('Account Activation', body) });
}

async function sendAdminInvitation(email, name, tempPassword, secretCode) {
  const body = `
        <h2>SecurePrint Administrator Invitation</h2>
        <p>Hello ${name}, you have been granted administrator access.</p>
        <p><strong>Password:</strong></p>
        <div class="code">${tempPassword}</div>
        <p><strong>Secret Access Code:</strong></p>
        <div class="code">${secretCode}</div>
        <p>You must change your password on first login. Do not share your secret code.</p>
      `;
  return send({ to: email, subject: 'SecurePrint Administrator Invitation', html: baseTemplate('Administrator Invitation', body) });
}

async function sendFacultyInvitation(email, name, tempPassword) {
  const body = `
        <h2>Welcome to SecurePrint</h2>
        <p>Hello ${name}, your faculty account is ready.</p>
        <p><strong>Temporary Password:</strong></p>
        <div class="code">${tempPassword}</div>
        <p>You must change your password on first login.</p>
      `;
  return send({ to: email, subject: 'Your SecurePrint Faculty Account', html: baseTemplate('Faculty Invitation', body) });
}

async function sendSecurityAlert(email, subject, message) {
  const body = `
        <h2>${subject}</h2>
        <p>${message}</p>
        <p>If this was not you, contact the system administrator immediately.</p>
      `;
  return send({ to: email, subject: `SecurePrint Security Alert: ${subject}`, html: baseTemplate('Security Alert', body) });
}

module.exports = {
  send,
  sendPasswordReset,
  sendSecretResetOtp,
  sendActivation,
  sendAdminInvitation,
  sendFacultyInvitation,
  sendSecurityAlert
};
