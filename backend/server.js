require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { connectDB } = require('./config/database');
const { ensureSuperAdmin } = require('./utils/seed');

// Import models to register associations
require('./models/index');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for secure headers
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:*', 'file://'], credentials: true }));

// General API rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});
app.use('/api/', generalLimiter);

// Enforce HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    res.redirect(301, `https://${req.headers.host}${req.url}`);
  });
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/print', require('./routes/print'));
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'SecurePrint API is running', time: new Date() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Start server after DB connection
connectDB().then(async () => {
  await ensureSuperAdmin();
  const server = app.listen(PORT, () => {
    console.log(`\n🖨️  SecurePrint Server running on http://localhost:${PORT}`);
    console.log(`📊 Admin Panel: Open Electron app\n`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use. Please stop the process using it or set a different PORT in .env.`);
      process.exit(1);
    }
    console.error('❌ Server error:', error.message);
    process.exit(1);
  });
});

module.exports = app;
