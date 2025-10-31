// PostPay - Complete Production Server (FULLY WORKING VERSION)

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const connectRedis = require('connect-redis');
const IORedis = require('ioredis');
const Bull = require('bull');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const sgMail = require('@sendgrid/mail');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

// ==================== RENDER.COM CONFIGURATION ====================
// Render.com specific setup for persistent data
let DATA_DIR, UPLOADS_DIR, BACKUPS_DIR;

if (process.env.NODE_ENV === 'production') {
  // Use Render's persistent disk for data
  const renderDataDir = '/opt/render/project/src/data';
  if (fs.existsSync(renderDataDir)) {
    DATA_DIR = path.join(renderDataDir, 'postpay');
    UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
    BACKUPS_DIR = path.join(DATA_DIR, 'backups');
    console.log('✅ Using Render persistent disk for data storage');
  } else {
    // Fallback to original paths if Render disk doesn't exist
    const ROOT = __dirname;
    DATA_DIR = path.join(ROOT, 'data');
    UPLOADS_DIR = path.join(ROOT, 'uploads');
    BACKUPS_DIR = path.join(ROOT, 'backups');
    console.log('✅ Using local file system for data storage');
  }
} else {
  // Development environment - use original paths
  const ROOT = __dirname;
  DATA_DIR = path.join(ROOT, 'data');
  UPLOADS_DIR = path.join(ROOT, 'uploads');
  BACKUPS_DIR = path.join(ROOT, 'backups');
  console.log('✅ Development mode - using local data storage');
}

// Create directories if they don't exist
[DATA_DIR, UPLOADS_DIR, BACKUPS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
});
// ==================== END RENDER.COM CONFIGURATION ====================

const PORT = Number(process.env.PORT || 10000);
// Note: ROOT is no longer used since we're handling paths above
// Remove this line: const ROOT = __dirname;

// Continue with the rest of your existing code...
const app = express();

// Middleware setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static('public'));
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// Database setup - FIXED FOR LOWDB v7+
const adapter = new JSONFileSync(path.join(DATA_DIR, 'db.json'));
// ... rest of your existing code continues unchanged
const defaultData = {
  users: [],
  activations: [],
  displays: [],
  editRequests: [],
  payments: [],
  adminLogs: [],
  emailQueue: [],
  settings: {
    activationPrice: 50,
    editPrice: 19,
    validityDays: Number(process.env.VALIDITY_DAYS || 30),
    editAccessHours: Number(process.env.EDIT_ACCESS_HOURS || 24),
    bep20Address: '0x626Cf0750f44FEa35E1e295082fe80D0F6E9234a',
    trc20Address: 'TGE4Yb9USJWKeXEjFNUstE584',
    usdtTrc20Contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    usdtBep20Contract: '0x55d398326f99059fF775485246999027B3197955',
    trc20Decimals: 6,
    bep20Decimals: 18
  },
  admin: {
    email: 'techmagnet.pro@gmail.com',
    passwordHash: bcrypt.hashSync('@UniqueP01', 10)
  }
};

const db = new LowSync(adapter, defaultData);

// Read database and initialize
db.read();
db.write();
console.log('✅ LowDB initialized');

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/i;
    const extname = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowed.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

// Email configuration - SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'techmagnet.pro@gmail.com';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'PostPay Platform';

let emailConfigured = false;

if (SENDGRID_API_KEY) {
  try {
    sgMail.setApiKey(SENDGRID_API_KEY);
    emailConfigured = true;
    console.log('✅ SendGrid email configured successfully');
  } catch (error) {
    console.log('❌ SendGrid configuration error:', error.message);
  }
} else {
  console.log('⚠️ SENDGRID_API_KEY not set - emails will not be sent');
}

// Redis and session configuration
let redisAvailable = false;
let emailQueue = null;
let redisClient;

try {
  redisClient = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASS || undefined,
    retryStrategy: () => null
  });

  redisClient.on('ready', () => {
    redisAvailable = true;
    console.log('✅ Redis ready');
  });

  redisClient.on('error', (err) => {
    redisAvailable = false;
    console.log('⚠️ Redis error:', err.message);
  });

  const RedisStore = connectRedis(session);

  app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || 'change_this_in_production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true
    }
  }));

  // Initialize email queue only if Redis is available
  emailQueue = new Bull('emailQueue', {
    redis: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASS || undefined
    }
  });

  emailQueue.process(5, async (job) => {
    try {
      await sgMail.send(job.data);
      console.log('✅ Email sent successfully to:', job.data.to);
      return { success: true };
    } catch (emailError) {
      console.log('❌ Failed to send email:', emailError.message);
      throw emailError;
    }
  });

} catch (e) {
  console.warn('⚠️ Redis not available - using memory session');
  app.use(session({
    secret: process.env.SESSION_SECRET || 'change_this_in_production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true
    }
  }));
}

// Utility functions
async function queueEmail(to, subject, html) {
  if (!emailConfigured) {
    console.log('⚠️ Email not configured - message stored in queue');
    db.data.emailQueue.push({
      id: uuidv4(),
      to,
      subject,
      html,
      attempts: 0,
      createdAt: new Date().toISOString(),
      status: 'pending'
    });
    db.write();
    return;
  }

  const msg = {
    to: to,
    from: {
      email: EMAIL_FROM,
      name: EMAIL_FROM_NAME
    },
    subject: subject,
    html: html
  };

  if (emailQueue && redisAvailable) {
    try {
      await emailQueue.add(msg, {
        attempts: 3,
        backoff: 5000,
        removeOnComplete: true,
        removeOnFail: false
      });
      console.log('📧 Email queued for:', to);
    } catch (queueError) {
      console.log('❌ Failed to queue email, sending immediately:', queueError.message);
      await sendEmailImmediately(msg);
    }
  } else {
    // Fallback: immediate sending
    await sendEmailImmediately(msg);
  }
}

async function sendEmailImmediately(msg) {
  try {
    await sgMail.send(msg);
    console.log('✅ Email sent immediately to:', msg.to);
  } catch (error) {
    console.log('❌ Failed to send email to:', msg.to, error.message);
    // Store in database for retry
    db.data.emailQueue.push({
      id: uuidv4(),
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      attempts: 0,
      createdAt: new Date().toISOString(),
      status: 'failed',
      error: error.message
    });
    db.write();
  }
}

const hash = (s) => bcrypt.hashSync(String(s), 10);
const compare = (s, h) => bcrypt.compareSync(String(s), String(h));
const generateActivationKey = () => `PPAY-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

// Background email processing for fallback
if (!emailQueue || !redisAvailable) {
  setInterval(async () => {
    if (!db.data.emailQueue || db.data.emailQueue.length === 0) return;

    const pendingJobs = db.data.emailQueue.filter(job =>
      job.status === 'pending' || (job.status === 'failed' && (job.attempts || 0) < 3)
    );

    for (const job of pendingJobs.slice(0, 3)) {
      if (!emailConfigured) continue;

      try {
        await sgMail.send({
          to: job.to,
          from: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
          subject: job.subject,
          html: job.html
        });

        // Remove successful job
        db.data.emailQueue = db.data.emailQueue.filter(j => j.id !== job.id);
        db.write();
        console.log('✅ Background email sent to:', job.to);
      } catch (err) {
        console.log('❌ Background email failed for:', job.to, err.message);
        const jobIndex = db.data.emailQueue.findIndex(j => j.id === job.id);
        if (jobIndex !== -1) {
          db.data.emailQueue[jobIndex].attempts = (job.attempts || 0) + 1;
          db.data.emailQueue[jobIndex].lastAttempt = new Date().toISOString();
          db.data.emailQueue[jobIndex].error = err.message;
          if (db.data.emailQueue[jobIndex].attempts >= 3) {
            db.data.emailQueue[jobIndex].status = 'failed';
          }
          db.write();
        }
      }
    }
  }, 30000); // Check every 30 seconds
}

// Payment verification functions
async function verifyTRC20Payment(address, amount) {
  try {
    const apiKey = process.env.TRONGRID_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'TRONGRID_API_KEY not configured' };
    }

    if (!address) {
      return { success: false, error: 'No wallet address provided' };
    }

    const response = await axios.get(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20`, {
      params: {
        limit: 50,
        contract_address: db.data.settings.usdtTrc20Contract
      },
      headers: { 'TRON-PRO-API-KEY': apiKey }
    });

    const transactions = response.data.data || [];
    const requiredAmount = Math.floor(amount * Math.pow(10, db.data.settings.trc20Decimals));

    for (const tx of transactions) {
      if (tx.to && tx.to.toLowerCase() === address.toLowerCase() &&
        parseInt(tx.value) === requiredAmount &&
        tx.token_info?.symbol === 'USDT') {
        return { success: true, transaction: tx };
      }
    }

    return { success: false, error: 'Payment not found' };
  } catch (error) {
    console.error('TRC20 verification error:', error.message);
    return { success: false, error: error.message };
  }
}

async function verifyBEP20Payment(address, amount) {
  try {
    const apiKey = process.env.BSCSCAN_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'BSCSCAN_API_KEY not configured' };
    }

    if (!address) {
      return { success: false, error: 'No wallet address provided' };
    }

    const response = await axios.get(`https://api.bscscan.com/api`, {
      params: {
        module: 'account',
        action: 'tokentx',
        address: address,
        contractaddress: db.data.settings.usdtBep20Contract,
        page: 1,
        offset: 50,
        sort: 'desc',
        apikey: apiKey
      }
    });

    const transactions = response.data.result || [];
    const requiredAmount = Math.floor(amount * Math.pow(10, db.data.settings.bep20Decimals));

    for (const tx of transactions) {
      if (tx.to && tx.to.toLowerCase() === address.toLowerCase() &&
        parseInt(tx.value) === requiredAmount &&
        tx.tokenSymbol === 'USDT') {
        return { success: true, transaction: tx };
      }
    }

    return { success: false, error: 'Payment not found' };
  } catch (error) {
    console.error('BEP20 verification error:', error.message);
    return { success: false, error: error.message };
  }
}

// Middleware
function requireUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.data.users.find(u => u.id === req.session.userId);
    if (user) {
      req.user = user;
      return next();
    }
  }
  res.redirect('/auth');
}

function requireActivation(req, res, next) {
  if (req.session && req.session.userId) {
    const activation = db.data.activations.find(a =>
      a.userId === req.session.userId &&
      a.status === 'active' &&
      new Date(a.expiryDate) >= new Date()
    );
    if (activation) {
      req.session.isActivated = true;
      return next();
    }
  }
  res.redirect('/dashboard?error=activation_required');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// Routes

// Serve default avatar
app.get('/default-avatar.png', (req, res) => {
  res.redirect('https://ui-avatars.com/api/?name=User&background=1e3a8a&color=fff&size=200');
});

// Landing Page
app.get('/', (req, res) => {
  const company = process.env.COMPANY_NAME || 'Tech-Magnet-Studio';
  const whatsapp = process.env.WHATSAPP_NUMBER || '+2349071524404';

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#1e3a8a">
  <link rel="manifest" href="/manifest.json">
  <title>PostPay - Professional Wallet Displays</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { max-width: 900px; text-align: center; }
    h1 { font-size: 3em; margin-bottom: 20px; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
    .tagline { font-size: 1.3em; margin-bottom: 40px; opacity: 0.95; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 40px 0; }
    .feature { background: rgba(255,255,255,0.1); padding: 30px; border-radius: 15px; backdrop-filter: blur(10px); }
    .feature h3 { margin-bottom: 10px; font-size: 1.5em; }
    .cta { display: inline-block; padding: 15px 40px; background: #ffd700; color: #333; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 1.2em; margin: 10px; transition: transform 0.3s; box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
    .cta:hover { transform: translateY(-3px); }
    .footer { margin-top: 60px; opacity: 0.8; }
    .company { color: #ffd700; font-weight: bold; }

    /* Mobile Responsive */
    @media (max-width: 768px) {
      h1 { font-size: 2em; }
      .tagline { font-size: 1em; }
      .features { grid-template-columns: 1fr; gap: 15px; margin: 20px 0; }
      .feature { padding: 20px; }
      .feature h3 { font-size: 1.2em; }
      .cta { padding: 12px 30px; font-size: 1em; }
      .footer { margin-top: 40px; }
    }
    @media (max-width: 480px) {
      body { padding: 15px; }
      h1 { font-size: 1.8em; }
      .tagline { font-size: 0.95em; }
      .cta { width: 100%; display: block; margin: 10px 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 PostPay</h1>
    <p class="tagline">Build Professional Wallet Displays with Blockchain-Verified Security</p>
    <div class="features">
      <div class="feature">
        <h3>⚡ Auto-Verification</h3>
        <p>Instant on-chain payment verification with TRC20 & BEP20 support</p>
      </div>
      <div class="feature">
        <h3>🎨 Beautiful Displays</h3>
        <p>Create stunning wallet displays with transactions, balances & bills</p>
      </div>
      <div class="feature">
        <h3>🔒 Secure Sharing</h3>
        <p>30-day activation keys with public shareable links</p>
      </div>
    </div>
    <a href="/auth" class="cta">Get Started Now</a>
    <div class="footer">
      <p>Powered by <span class="company">${company}</span></p>
      <p style="margin-top:10px;">💬 WhatsApp: ${whatsapp}</p>
    </div>
  </div>
</body>
</html>
  `);
});

// Authentication Page
app.get('/auth', (req, res) => {
  const company = process.env.COMPANY_NAME || 'Tech-Magnet-Studio';
  const whatsapp = process.env.WHATSAPP_NUMBER || '+2349071524404';

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#1e3a8a">
  <title>Login / Register - PostPay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { max-width: 480px; width: 100%; background: #fff; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; }
    .brand { text-align: center; color: #ffd700; font-weight: 800; font-size: 28px; margin-bottom: 10px; }
    .contact { text-align: center; color: #666; margin-bottom: 30px; }
    .tabs { display: flex; gap: 10px; margin-bottom: 30px; }
    .tabs button { flex: 1; padding: 12px; border-radius: 10px; border: 2px solid #e0e0e0; background: #f9f9f9; cursor: pointer; font-size: 16px; font-weight: 600; color: #666; transition: all 0.3s; }
    .tabs button.active { background: #1e3a8a; color: #fff; border-color: #1e3a8a; }
    form { display: none; }
    form.active { display: block; }
    input { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #ddd; font-size: 14px; }
    button.submit { width: 100%; padding: 14px; background: #1e3a8a; border: none; border-radius: 10px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 10px; }
    .small { font-size: 13px; color: #999; text-align: center; margin-top: 20px; }
    .profile-preview { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; margin: 10px auto; display: block; border: 3px solid #1e3a8a; }

    /* Mobile Responsive */
    @media (max-width: 768px) {
      .card { padding: 30px 25px; max-width: 100%; }
      .brand { font-size: 24px; }
      .contact { font-size: 14px; }
      .tabs button { font-size: 14px; padding: 10px; }
      input { font-size: 16px; }
      button.submit { font-size: 15px; }
    }
    @media (max-width: 480px) {
      body { padding: 15px; }
      .card { padding: 25px 20px; border-radius: 15px; }
      .brand { font-size: 22px; }
      .tabs { gap: 8px; }
      .tabs button { font-size: 13px; padding: 8px; }
      .profile-preview { width: 70px; height: 70px; }
    }
  </style>
  <script>
    function showTab(tab) {
      document.querySelectorAll('form').forEach(f => f.classList.remove('active'));
      document.getElementById(tab).classList.add('active');
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      document.getElementById(tab + 'Btn').classList.add('active');
    }

    function previewImage(input) {
      if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
          let preview = document.getElementById('profilePreview');
          if (!preview) {
            preview = document.createElement('img');
            preview.id = 'profilePreview';
            preview.className = 'profile-preview';
            input.parentNode.appendChild(preview);
          }
          preview.src = e.target.result;
        }
        reader.readAsDataURL(input.files[0]);
      }
    }

    window.onload = () => showTab('loginForm');
  </script>
</head>
<body>
  <div class="card">
    <div class="brand">${company}</div>
    <div class="contact">💬 ${whatsapp}</div>
    <div class="tabs">
      <button id="loginFormBtn" onclick="showTab('loginForm')">Login</button>
      <button id="registerFormBtn" onclick="showTab('registerForm')">Register</button>
    </div>
    <form id="loginForm" method="POST" action="/auth/login">
      <input name="email" type="email" placeholder="Email Address" required>
      <input name="password" type="password" placeholder="Password" required>
      <button class="submit" type="submit">Login to Dashboard</button>
    </form>
    <form id="registerForm" method="POST" action="/auth/register" enctype="multipart/form-data">
      <input name="name" placeholder="Full Name" required>
      <input name="email" type="email" placeholder="Email Address" required>
      <input name="password" type="password" placeholder="Create Password" required>
      <label style="font-size: 13px; color: #666;">Profile Image (Optional)</label>
      <input type="file" name="profileImage" accept="image/*" onchange="previewImage(this)">
      <button class="submit" type="submit">Create Account</button>
    </form>
    <div class="small">Powered by PostPay</div>
  </div>
</body>
</html>
  `);
});

// Registration
app.post('/auth/register', upload.single('profileImage'), async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).send('<p>Missing fields. <a href="/auth">Go back</a></p>');
    }

    const exists = db.data.users.find(u => u.email === email);
    if (exists) {
      return res.send('<p>Email already registered. <a href="/auth">Try logging in</a></p>');
    }

    const user = {
      id: uuidv4(),
      name,
      email,
      passwordHash: hash(password),
      profileImage: req.file ? `/uploads/${req.file.filename}` : '/default-avatar.png',
      createdAt: new Date().toISOString(),
      isActive: false,
      lastLogin: new Date().toISOString()
    };

    db.data.users.push(user);
    db.write();

    // Send welcome email
    try {
      await queueEmail(email, 'Welcome to PostPay 🎉 - Account Created Successfully', `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; border-radius: 15px;">
          <div style="text-align: center; padding: 30px;">
            <h1 style="color: #ffd700; margin-bottom: 10px;">🚀 Welcome to PostPay!</h1>
            <h2 style="margin-bottom: 20px;">Hello ${name}!</h2>
          </div>
          <div style="background: white; color: #333; padding: 30px; border-radius: 10px;">
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
              Your PostPay account has been created successfully! 🎉
            </p>
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
              <strong>What's Next?</strong><br>
              To start creating professional wallet displays, please activate your account by purchasing a 30-day activation key for $50.
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="http://localhost:${PORT}/dashboard"
                style="background: #1e3a8a; color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">
                🚀 Go to Dashboard
              </a>
            </div>
            <p style="font-size: 14px; color: #666; text-align: center;">
              Need help? Contact us at ${process.env.WHATSAPP_NUMBER || '+2349071524404'}
            </p>
          </div>
          <div style="text-align: center; padding: 20px; color: #ffd700;">
            <p>Powered by <strong>Tech-Magnet-Studio</strong></p>
          </div>
        </div>
      `);
      console.log('✅ Welcome email queued for:', email);
    } catch (emailError) {
      console.log('❌ Failed to queue welcome email:', emailError.message);
    }

    // Log admin action
    db.data.adminLogs.push({
      id: uuidv4(),
      action: 'user_registered',
      userId: user.id,
      userEmail: user.email,
      time: new Date().toISOString()
    });
    db.write();

    req.session.userId = user.id;
    console.log('✅ New user registered:', email);
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).send('<p>Server error. <a href="/auth">Try again</a></p>');
  }
});

// Login
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.data.users.find(u => u.email === email);

  if (!user || !compare(password, user.passwordHash)) {
    return res.send('<p>Invalid credentials. <a href="/auth">Try again</a></p>');
  }

  // Update last login
  user.lastLogin = new Date().toISOString();
  db.write();

  req.session.userId = user.id;

  // Check if user has active activation
  const activation = db.data.activations.find(a =>
    a.userId === user.id &&
    a.status === 'active' &&
    new Date(a.expiryDate) >= new Date()
  );

  if (activation) {
    req.session.isActivated = true;
  }

  console.log('✅ User logged in:', email);
  res.redirect('/dashboard');
});

// Dashboard
app.get('/dashboard', requireUser, (req, res) => {
  const user = db.data.users.find(u => u.id === req.session.userId);
  const settings = db.data.settings;

  // Check activation status
  const activation = db.data.activations.find(a =>
    a.userId === req.session.userId &&
    a.status === 'active' &&
    new Date(a.expiryDate) >= new Date()
  );

  // Check edit access
  const editAccess = db.data.editRequests.find(e =>
    e.userId === req.session.userId &&
    e.status === 'active' &&
    new Date(e.expiryDate) >= new Date()
  );

  // Get user's display - only show if activated
  const userDisplay = activation ? db.data.displays.find(d => d.userId === req.session.userId) : null;

  const error = req.query.error;
  const success = req.query.success;

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - PostPay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; padding: 30px; border-radius: 15px; margin-bottom: 30px; position: relative; }
    .welcome { font-size: 2em; margin-bottom: 10px; display: flex; align-items: center; gap: 15px; flex-wrap: wrap; }
    .profile-image { width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 3px solid #ffd700; }
    .balance-card { background: white; padding: 25px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 25px; }
    .section-title { font-size: 1.5em; margin-bottom: 20px; color: #1e3a8a; border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-weight: 600; color: #555; }
    input, select, textarea { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; transition: border-color 0.3s; }
    input:focus, select:focus, textarea:focus { border-color: #1e3a8a; outline: none; }
    .transaction-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px; }
    .btn { background: #1e3a8a; color: white; padding: 15px 30px; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.3s; margin: 5px; }
    .btn:hover { background: #3b82f6; }
    .btn-success { background: #10b981; }
    .btn-warning { background: #f59e0b; }
    .btn-danger { background: #ef4444; }
    .display-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 3px 10px rgba(0,0,0,0.1); margin-bottom: 15px; }
    .display-link { color: #1e3a8a; text-decoration: none; word-break: break-all; }
    .nav { display: flex; gap: 15px; margin-bottom: 30px; flex-wrap: wrap; }
    .nav a { padding: 10px 20px; background: white; border-radius: 8px; text-decoration: none; color: #1e3a8a; font-weight: 600; }
    .nav a.active { background: #1e3a8a; color: white; }
    .activation-status { padding: 15px; border-radius: 10px; margin-bottom: 20px; }
    .activation-status.active { background: #d1fae5; color: #065f46; border: 1px solid #a7f3d0; }
    .activation-status.inactive { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
    .biller-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 15px; margin: 20px 0; }
    .biller-icon { background: white; padding: 20px; border-radius: 10px; text-align: center; cursor: pointer; transition: transform 0.3s; border: 2px solid #e0e0e0; }
    .biller-icon:hover { transform: translateY(-5px); border-color: #1e3a8a; }
    .biller-icon img { width: 50px; height: 50px; object-fit: contain; margin-bottom: 10px; }
    .alert { padding: 15px; border-radius: 10px; margin-bottom: 20px; }
    .alert-error { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
    .alert-success { background: #d1fae5; color: #065f46; border: 1px solid #a7f3d0; }
    .payment-methods { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }
    .payment-method { background: white; padding: 20px; border-radius: 10px; text-align: center; }
    .payment-address { background: #f8f9fa; padding: 10px; border-radius: 5px; font-family: monospace; margin: 10px 0; word-break: break-all; font-size: 14px; }
    .hidden { display: none; }
    .user-info { display: flex; align-items: center; gap: 15px; margin-bottom: 15px; }

    /* Mobile Responsive */
    @media (max-width: 1024px) {
      .container { padding: 15px; }
      .grid { grid-template-columns: 1fr; gap: 20px; }
      .payment-methods { grid-template-columns: 1fr; }
    }
    @media (max-width: 768px) {
      .header { padding: 20px; border-radius: 10px; }
      .welcome { font-size: 1.5em; }
      .profile-image { width: 50px; height: 50px; }
      .section-title { font-size: 1.3em; }
      .balance-card { padding: 20px; }
      .nav { gap: 10px; }
      .nav a { padding: 8px 15px; font-size: 14px; }
      .btn { padding: 12px 20px; font-size: 14px; }
      .transaction-row { grid-template-columns: 1fr; gap: 5px; }
      .transaction-row input { margin-bottom: 5px; }
      .biller-grid { grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .biller-icon { padding: 15px; }
      .payment-address { font-size: 11px; padding: 8px; }
    }
    @media (max-width: 480px) {
      .container { padding: 10px; }
      .header { padding: 15px; margin-bottom: 20px; }
      .welcome { font-size: 1.2em; gap: 10px; }
      .welcome div { font-size: 1em; }
      .profile-image { width: 45px; height: 45px; border: 2px solid #ffd700; }
      .section-title { font-size: 1.1em; padding-bottom: 8px; }
      .balance-card { padding: 15px; margin-bottom: 20px; }
      .nav { gap: 8px; }
      .nav a { padding: 7px 12px; font-size: 13px; border-radius: 6px; }
      .btn { padding: 10px 15px; font-size: 13px; margin: 3px; width: 100%; }
      input, select, textarea { font-size: 16px; padding: 10px; }
      .biller-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .biller-icon { padding: 12px; }
      .biller-icon div:first-child { font-size: 30px !important; }
      .payment-method { padding: 15px; }
      .payment-method h4 { font-size: 14px; }
      .payment-address { font-size: 10px; padding: 6px; }
      .display-card { padding: 15px; }
      .alert { padding: 12px; font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="welcome">
        <img src="${user.profileImage}" alt="Profile" class="profile-image" onerror="this.src='/default-avatar.png'">
        <div>
          Welcome, ${user.name}!
          <div style="font-size: 0.8em; opacity: 0.9;">${user.email}</div>
        </div>
      </div>
      <p>Manage your wallet displays and bill payments</p>
    </div>

    <div class="nav">
      <a href="#overview" class="active">Overview</a>
      <a href="#displays">My Display</a>
      <a href="#create" ${!activation || userDisplay ? 'style="opacity: 0.5; pointer-events: none;"' : ''}>Create Display</a>
      <a href="#bills">Bill Payments</a>
      <a href="/logout">Logout</a>
    </div>

    ${error === 'activation_required' ? `
    <div class="alert alert-error">
      <strong>Activation Required!</strong> You need to purchase a 30-day activation key to access display creation features.
    </div>
    ` : ''}

    ${success === 'activation_success' ? `
    <div class="alert alert-success">
      <strong>Activation Successful!</strong> Your account has been activated for 30 days.
    </div>
    ` : ''}

    ${success === 'edit_access_granted' ? `
    <div class="alert alert-success">
      <strong>Edit Access Granted!</strong> You can now edit your display for 24 hours.
    </div>
    ` : ''}

    ${success === 'display_created' ? `
    <div class="alert alert-success">
      <strong>Display Created Successfully!</strong> Your wallet display has been created and is now publicly accessible.
    </div>
    ` : ''}

    ${success === 'display_updated' ? `
    <div class="alert alert-success">
      <strong>Display Updated Successfully!</strong> Your wallet display has been updated.
    </div>
    ` : ''}

    <div id="overview">
      <div class="activation-status ${activation ? 'active' : 'inactive'}">
        <strong>Account Status:</strong> ${activation ? 'ACTIVATED' : 'NOT ACTIVATED'}
        ${activation ? `
        <br>Expires: ${new Date(activation.expiryDate).toLocaleDateString()}
        <br>Activation Key: ${activation.activationKey}
        ` : `
        <br>Purchase activation to create wallet displays
        `}
      </div>

      ${!activation ? `
      <div class="balance-card">
        <h3 class="section-title">Activate Your Account</h3>
        <p>Purchase a 30-day activation key for $${settings.activationPrice} to unlock:</p>
        <ul style="margin: 15px 0; padding-left: 20px;">
          <li>Wallet display creation</li>
          <li>Public sharing links</li>
          <li>Professional templates</li>
          <li>Bill payment features</li>
        </ul>
        <div class="payment-methods">
          <div class="payment-method">
            <h4>Pay with TRC20 (Tron)</h4>
            <div class="payment-address">${settings.trc20Address}</div>
            <p>Send exactly $${settings.activationPrice} USDT</p>
            <form method="POST" action="/payment/verify/trc20">
              <input type="hidden" name="amount" value="${settings.activationPrice}">
              <input type="hidden" name="type" value="activation">
              <button type="submit" class="btn">Verify TRC20 Payment</button>
            </form>
          </div>
          <div class="payment-method">
            <h4>Pay with BEP20 (BSC)</h4>
            <div class="payment-address">${settings.bep20Address}</div>
            <p>Send exactly $${settings.activationPrice} USDT</p>
            <form method="POST" action="/payment/verify/bep20">
              <input type="hidden" name="amount" value="${settings.activationPrice}">
              <input type="hidden" name="type" value="activation">
              <button type="submit" class="btn">Verify BEP20 Payment</button>
            </form>
          </div>
        </div>
      </div>
      ` : ''}

      ${activation && !editAccess ? `
      <div class="balance-card">
        <h3 class="section-title">Purchase Edit Access</h3>
        <p>Get 24-hour edit access for your display for $${settings.editPrice}</p>
        <div class="payment-methods">
          <div class="payment-method">
            <h4>Pay with TRC20 (Tron)</h4>
            <div class="payment-address">${settings.trc20Address}</div>
            <p>Send exactly $${settings.editPrice} USDT</p>
            <form method="POST" action="/payment/verify/trc20">
              <input type="hidden" name="amount" value="${settings.editPrice}">
              <input type="hidden" name="type" value="edit_access">
              <button type="submit" class="btn">Verify TRC20 Payment</button>
            </form>
          </div>
          <div class="payment-method">
            <h4>Pay with BEP20 (BSC)</h4>
            <div class="payment-address">${settings.bep20Address}</div>
            <p>Send exactly $${settings.editPrice} USDT</p>
            <form method="POST" action="/payment/verify/bep20">
              <input type="hidden" name="amount" value="${settings.editPrice}">
              <input type="hidden" name="type" value="edit_access">
              <button type="submit" class="btn">Verify BEP20 Payment</button>
            </form>
          </div>
        </div>
      </div>
      ` : ''}

      ${editAccess ? `
      <div class="activation-status active">
        <strong>Edit Access:</strong> ACTIVE
        <br>Expires: ${new Date(editAccess.expiryDate).toLocaleDateString()} at ${new Date(editAccess.expiryDate).toLocaleTimeString()}
      </div>
      ` : ''}
    </div>

    <div id="displays" class="hidden">
      <div class="section-title">Your Wallet Display</div>
      ${!activation ? `
      <p>Your display is currently hidden because your activation has expired. Please renew activation to view and share your display.</p>
      ` : !userDisplay ? `
      <p>No display created yet. ${activation ? 'Create your wallet display!' : 'Activate your account to create displays.'}</p>
      ` : `
      <div class="display-card">
        <h3>${userDisplay.walletName || 'Unnamed Wallet'}</h3>
        <p><strong>Balance:</strong> $${userDisplay.balance.toFixed(2)} | <strong>Account Type:</strong> ${userDisplay.accountType}</p>
        <p><strong>Public Link:</strong>
          <a href="/display/${userDisplay.id}" target="_blank" class="display-link">
            http://localhost:${PORT}/display/${userDisplay.id}
          </a></p>
        <p><strong>Created:</strong> ${new Date(userDisplay.createdAt).toLocaleDateString()}</p>
        <p><strong>Last Updated:</strong> ${new Date(userDisplay.updatedAt).toLocaleDateString()}</p>
        ${editAccess ? `
        <button onclick="showEditForm('${userDisplay.id}')" class="btn btn-warning">Edit Display</button>
        <div id="editForm-${userDisplay.id}" class="hidden" style="margin-top: 15px; padding: 20px; background: #f8f9fa; border-radius: 10px;">
          <h4>Edit Display</h4>
          <form method="POST" action="/dashboard/display/${userDisplay.id}/edit">
            <div class="form-group">
              <label>Wallet Name</label>
              <input type="text" name="walletName" value="${userDisplay.walletName}" placeholder="e.g., My Business Wallet">
            </div>
            <div class="grid">
              <div class="form-group">
                <label>Balance</label>
                <input type="number" name="balance" value="${userDisplay.balance}" step="0.01" placeholder="0.00">
              </div>
              <div class="form-group">
                <label>Next Withdrawable Date</label>
                <input type="date" name="nextWithdrawableDate" value="${userDisplay.nextWithdrawableDate}">
              </div>
            </div>
            <div class="form-group">
              <label>Account Type</label>
              <select name="accountType">
                <option value="">Select Account Type</option>
                <option value="Savings" ${userDisplay.accountType === 'Savings' ? 'selected' : ''}>Savings</option>
                <option value="Checking" ${userDisplay.accountType === 'Checking' ? 'selected' : ''}>Checking</option>
                <option value="Business" ${userDisplay.accountType === 'Business' ? 'selected' : ''}>Business</option>
                <option value="Investment" ${userDisplay.accountType === 'Investment' ? 'selected' : ''}>Investment</option>
              </select>
            </div>
            <div class="form-group">
              <label>Transactions (All Optional)</label>
              ${Array.from({length: 5}, (_, i) => {
                const transaction = userDisplay.transactions[i] || { description: '', date: '', time: '', amount: '' };
                return `
                <div class="transaction-row">
                  <input type="text" name="transactions[${i}][description]" value="${transaction.description}" placeholder="Description">
                  <input type="date" name="transactions[${i}][date]" value="${transaction.date}">
                  <input type="time" name="transactions[${i}][time]" value="${transaction.time}">
                  <input type="number" name="transactions[${i}][amount]" value="${transaction.amount}" step="0.01" placeholder="Amount">
                </div>
                `;
              }).join('')}
            </div>
            <div class="form-group">
              <label>Additional Notes</label>
              <textarea name="additionalNotes" rows="3" placeholder="Any additional information about your wallet...">${userDisplay.additionalNotes || ''}</textarea>
            </div>
            <button type="submit" class="btn btn-success">Update Display</button>
            <button type="button" onclick="hideEditForm('${userDisplay.id}')" class="btn btn-danger">Cancel</button>
          </form>
        </div>
        ` : ''}
      </div>
      `}
    </div>

    <div id="create" class="hidden">
      ${activation && !userDisplay ? `
      <div class="section-title">Create New Wallet Display</div>
      <div class="balance-card">
        <form id="displayForm" method="POST" action="/dashboard/display">
          <div class="form-group">
            <label for="walletName">Wallet Name</label>
            <input type="text" id="walletName" name="walletName" placeholder="e.g., My Business Wallet">
          </div>
          <div class="grid">
            <div class="form-group">
              <label for="balance">Current Balance (USD)</label>
              <input type="number" id="balance" name="balance" step="0.01" placeholder="0.00">
            </div>
            <div class="form-group">
              <label for="nextWithdrawableDate">Next Withdrawable Date</label>
              <input type="date" id="nextWithdrawableDate" name="nextWithdrawableDate">
            </div>
          </div>
          <div class="form-group">
            <label for="accountType">Account Type</label>
            <select id="accountType" name="accountType">
              <option value="">Select Account Type</option>
              <option value="Savings">Savings Account</option>
              <option value="Checking">Checking Account</option>
              <option value="Business">Business Account</option>
              <option value="Investment">Investment Account</option>
            </select>
          </div>
          <div class="form-group">
            <label>Last 5 Transactions (All Optional)</label>
            <div id="transactions">
              ${Array.from({length: 5}, (_, i) => `
              <div class="transaction-row">
                <input type="text" name="transactions[${i}][description]" placeholder="Transaction description">
                <input type="date" name="transactions[${i}][date]">
                <input type="time" name="transactions[${i}][time]">
                <input type="number" name="transactions[${i}][amount]" step="0.01" placeholder="Amount">
              </div>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label for="additionalNotes">Additional Notes (Optional)</label>
            <textarea id="additionalNotes" name="additionalNotes" rows="3" placeholder="Any additional information about your wallet..."></textarea>
          </div>
          <button type="submit" class="btn">Create Wallet Display</button>
        </form>
      </div>
      ` : activation && userDisplay ? `
      <div class="alert alert-error">
        <strong>Display Already Created!</strong> You can only create one display. Purchase edit access to modify your existing display.
      </div>
      ` : `
      <div class="alert alert-error">
        <strong>Activation Required!</strong> Please purchase a 30-day activation key to create wallet displays.
      </div>
      `}
    </div>

    <div id="bills" class="hidden">
      <div class="section-title">Bill Payments</div>
      <div class="balance-card">
        <p>Pay your bills instantly using our integrated payment system:</p>
        <div class="biller-grid">
          <div class="biller-icon" onclick="payBill('electricity')">
            <div style="font-size: 40px; margin-bottom: 10px;">⚡</div>
            <div>Electricity</div>
          </div>
          <div class="biller-icon" onclick="payBill('water')">
            <div style="font-size: 40px; margin-bottom: 10px;">💧</div>
            <div>Water</div>
          </div>
          <div class="biller-icon" onclick="payBill('internet')">
            <div style="font-size: 40px; margin-bottom: 10px;">🌐</div>
            <div>Internet</div>
          </div>
          <div class="biller-icon" onclick="payBill('mobile')">
            <div style="font-size: 40px; margin-bottom: 10px;">📱</div>
            <div>Mobile</div>
          </div>
          <div class="biller-icon" onclick="payBill('cable')">
            <div style="font-size: 40px; margin-bottom: 10px;">📺</div>
            <div>Cable TV</div>
          </div>
          <div class="biller-icon" onclick="payBill('gas')">
            <div style="font-size: 40px; margin-bottom: 10px;">🔥</div>
            <div>Gas</div>
          </div>
        </div>
        <div id="billPaymentForm" class="hidden">
          <h4>Pay <span id="billType"></span> Bill</h4>
          <form id="billForm">
            <div class="form-group">
              <label for="accountNumber">Account Number *</label>
              <input type="text" id="accountNumber" name="accountNumber" required>
            </div>
            <div class="form-group">
              <label for="billAmount">Amount (USD) *</label>
              <input type="number" id="billAmount" name="billAmount" step="0.01" required>
            </div>
            <button type="submit" class="btn">Proceed to Payment</button>
          </form>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Navigation
    document.querySelectorAll('.nav a').forEach(link => {
      if (link.getAttribute('href').startsWith('#')) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
          link.classList.add('active');
          document.getElementById('overview').style.display = 'none';
          document.getElementById('displays').style.display = 'none';
          document.getElementById('create').style.display = 'none';
          document.getElementById('bills').style.display = 'none';
          const targetId = link.getAttribute('href').substring(1);
          document.getElementById(targetId).style.display = 'block';
        });
      }
    });

    // Set minimum date to today
    if (document.getElementById('nextWithdrawableDate')) {
      document.getElementById('nextWithdrawableDate').min = new Date().toISOString().split('T')[0];
    }

    function showEditForm(displayId) {
      document.getElementById('editForm-' + displayId).style.display = 'block';
    }

    function hideEditForm(displayId) {
      document.getElementById('editForm-' + displayId).style.display = 'none';
    }

    function payBill(billType) {
      const billNames = {
        electricity: 'Electricity',
        water: 'Water',
        internet: 'Internet',
        mobile: 'Mobile',
        cable: 'Cable TV',
        gas: 'Gas'
      };
      document.getElementById('billType').textContent = billNames[billType];
      document.getElementById('billPaymentForm').style.display = 'block';
      document.getElementById('billForm').onsubmit = function(e) {
        e.preventDefault();
        const accountNumber = document.getElementById('accountNumber').value;
        const amount = document.getElementById('billAmount').value;
        alert('Bill payment initiated:\\nType: ' + billNames[billType] + '\\nAccount: ' + accountNumber + '\\nAmount: $' + amount + '\\n\\nYou will be redirected to payment...');
      };
    }

    // Show overview by default
    document.getElementById('overview').style.display = 'block';
  </script>
</body>
</html>
  `);
});

// Display Creation - ALL FIELDS OPTIONAL
app.post('/dashboard/display', requireUser, requireActivation, upload.none(), (req, res) => {
  try {
    const { walletName, balance, nextWithdrawableDate, accountType, additionalNotes } = req.body;

    // Check if user already has a display
    const existingDisplay = db.data.displays.find(d => d.userId === req.session.userId);
    if (existingDisplay) {
      return res.status(400).send('<p>You can only create one display. Purchase edit access to modify your existing display. <a href="/dashboard">Go back</a></p>');
    }

    // Parse transactions - Accept any filled transactions (all optional)
    const transactions = [];
    for (let i = 0; i < 5; i++) {
      const desc = req.body[`transactions[${i}][description]`];
      const date = req.body[`transactions[${i}][date]`];
      const time = req.body[`transactions[${i}][time]`];
      const amount = req.body[`transactions[${i}][amount]`];

      // Only add transaction if ANY field is filled (not all required)
      if (desc && desc.trim() !== '' ||
          date && date.trim() !== '' ||
          time && time.trim() !== '' ||
          amount && amount.trim() !== '') {
        transactions.push({
          description: desc ? desc.trim() : 'Transaction',
          date: date ? date.trim() : new Date().toISOString().split('T')[0],
          time: time ? time.trim() : '12:00',
          amount: amount ? parseFloat(amount) : 0
        });
      }
    }

    // ALL FIELDS ARE NOW OPTIONAL - Set defaults for empty values
    const display = {
      id: uuidv4(),
      userId: req.session.userId,
      walletName: walletName || 'My Wallet',
      balance: balance ? parseFloat(balance) : 0.00,
      nextWithdrawableDate: nextWithdrawableDate || new Date().toISOString().split('T')[0],
      accountType: accountType || 'General',
      transactions: transactions,
      additionalNotes: additionalNotes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isActive: true
    };

    db.data.displays.push(display);
    db.write();

    // Log admin action
    db.data.adminLogs.push({
      id: uuidv4(),
      action: 'display_created',
      userId: req.session.userId,
      displayId: display.id,
      displayName: display.walletName,
      time: new Date().toISOString()
    });
    db.write();

    console.log('✅ New display created:', display.walletName);
    res.redirect('/dashboard?success=display_created');
  } catch (error) {
    console.error('Display creation error:', error);
    res.status(500).send('<p>Server error. <a href="/dashboard">Try again</a></p>');
  }
});

// Display Editing - ALL FIELDS OPTIONAL
app.post('/dashboard/display/:id/edit', requireUser, upload.none(), (req, res) => {
  try {
    const displayId = req.params.id;
    const { walletName, balance, nextWithdrawableDate, accountType, additionalNotes } = req.body;

    // Check if user has edit access
    const editAccess = db.data.editRequests.find(e =>
      e.userId === req.session.userId &&
      e.status === 'active' &&
      new Date(e.expiryDate) >= new Date()
    );

    if (!editAccess) {
      return res.status(400).send('<p>Edit access required. Purchase 24-hour edit access to modify your display. <a href="/dashboard">Go back</a></p>');
    }

    // Find user's display
    const display = db.data.displays.find(d => d.id === displayId && d.userId === req.session.userId);
    if (!display) {
      return res.status(404).send('<p>Display not found. <a href="/dashboard">Go back</a></p>');
    }

    // Parse transactions - ALL OPTIONAL
    const transactions = [];
    for (let i = 0; i < 5; i++) {
      const desc = req.body[`transactions[${i}][description]`];
      const date = req.body[`transactions[${i}][date]`];
      const time = req.body[`transactions[${i}][time]`];
      const amount = req.body[`transactions[${i}][amount]`];

      // Only update if any field is filled
      if (desc && desc.trim() !== '' ||
          date && date.trim() !== '' ||
          time && time.trim() !== '' ||
          amount && amount.trim() !== '') {
        transactions.push({
          description: desc ? desc.trim() : display.transactions[i]?.description || 'Transaction',
          date: date ? date.trim() : display.transactions[i]?.date || new Date().toISOString().split('T')[0],
          time: time ? time.trim() : display.transactions[i]?.time || '12:00',
          amount: amount ? parseFloat(amount) : display.transactions[i]?.amount || 0
        });
      } else if (display.transactions[i]) {
        // Keep existing transaction if no new data
        transactions.push(display.transactions[i]);
      }
    }

    // Update display with new values or keep existing ones
    display.walletName = walletName || display.walletName;
    display.balance = balance ? parseFloat(balance) : display.balance;
    display.nextWithdrawableDate = nextWithdrawableDate || display.nextWithdrawableDate;
    display.accountType = accountType || display.accountType;
    if (transactions.length > 0) {
      display.transactions = transactions;
    }
    display.additionalNotes = additionalNotes !== undefined ? additionalNotes : display.additionalNotes;
    display.updatedAt = new Date().toISOString();

    db.write();

    console.log('✅ Display updated:', display.walletName);
    res.redirect('/dashboard?success=display_updated');
  } catch (error) {
    console.error('Display edit error:', error);
    res.status(500).send('<p>Server error. <a href="/dashboard">Try again</a></p>');
  }
});

// Payment Verification - TRC20
app.post('/payment/verify/trc20', requireUser, async (req, res) => {
  try {
    const { amount, type } = req.body;
    const user = db.data.users.find(u => u.id === req.session.userId);
    const settings = db.data.settings;

    console.log(`🔍 Verifying TRC20 payment for ${user.email}, amount: $${amount}, type: ${type}`);

    const verification = await verifyTRC20Payment(settings.trc20Address, parseFloat(amount));

    if (verification.success) {
      console.log('✅ TRC20 payment verified successfully');

      if (type === 'activation') {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + settings.validityDays);

        const activation = {
          id: uuidv4(),
          userId: user.id,
          activationKey: generateActivationKey(),
          paymentAmount: settings.activationPrice,
          paymentMethod: 'TRC20',
          transactionHash: verification.transaction.transaction_id,
          activationDate: new Date().toISOString(),
          expiryDate: expiryDate.toISOString(),
          status: 'active'
        };

        db.data.activations.push(activation);
        db.write();
        req.session.isActivated = true;

        // Send activation success email
        await queueEmail(user.email, '🎉 Account Activated Successfully!', `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; border-radius: 15px;">
            <div style="text-align: center; padding: 30px;">
              <h1 style="color: #ffd700; margin-bottom: 10px;">✅ Activation Successful!</h1>
              <h2 style="margin-bottom: 20px;">Welcome to PostPay Premium, ${user.name}!</h2>
            </div>
            <div style="background: white; color: #333; padding: 30px; border-radius: 10px;">
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                <strong>Your account has been successfully activated!</strong>
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                <strong>Activation Key:</strong> ${activation.activationKey}<br>
                <strong>Expiry Date:</strong> ${expiryDate.toLocaleDateString()}<br>
                <strong>Payment Amount:</strong> $${settings.activationPrice} USDT
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                You can now create professional wallet displays and use all premium features for 30 days!
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="http://localhost:${PORT}/dashboard"
                  style="background: #10b981; color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">
                  🚀 Start Creating Displays
                </a>
              </div>
            </div>
          </div>
        `);

        // Log admin action
        db.data.adminLogs.push({
          id: uuidv4(),
          action: 'user_activated',
          userId: user.id,
          userEmail: user.email,
          activationKey: activation.activationKey,
          time: new Date().toISOString()
        });
        db.write();

        res.redirect('/dashboard?success=activation_success');
      } else if (type === 'edit_access') {
        const expiryDate = new Date();
        expiryDate.setHours(expiryDate.getHours() + settings.editAccessHours);

        const editAccess = {
          id: uuidv4(),
          userId: user.id,
          paymentAmount: settings.editPrice,
          paymentMethod: 'TRC20',
          transactionHash: verification.transaction.transaction_id,
          purchaseDate: new Date().toISOString(),
          expiryDate: expiryDate.toISOString(),
          status: 'active'
        };

        db.data.editRequests.push(editAccess);
        db.write();

        // Send edit access email
        await queueEmail(user.email, '✏️ Edit Access Activated!', `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; padding: 20px; background: #1e3a8a; color: white; border-radius: 10px 10px 0 0;">
              <h1 style="color: #ffd700; margin-bottom: 10px;">✏️ Edit Access Activated!</h1>
            </div>
            <div style="padding: 30px; background: #f8f9fa; border-radius: 0 0 10px 10px;">
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                Hello ${user.name},
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                You now have <strong>24-hour edit access</strong> for your wallet display.
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                <strong>Expiry:</strong> ${expiryDate.toLocaleString()}
              </p>
              <div style="text-align: center;">
                <a href="http://localhost:${PORT}/dashboard"
                  style="background: #1e3a8a; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                  Edit Your Display
                </a>
              </div>
            </div>
          </div>
        `);

        res.redirect('/dashboard?success=edit_access_granted');
      }
    } else {
      console.log('❌ TRC20 payment verification failed:', verification.error);
      res.redirect('/dashboard?error=payment_not_found');
    }
  } catch (error) {
    console.error('TRC20 verification error:', error);
    res.redirect('/dashboard?error=verification_failed');
  }
});

// Payment Verification - BEP20
app.post('/payment/verify/bep20', requireUser, async (req, res) => {
  try {
    const { amount, type } = req.body;
    const user = db.data.users.find(u => u.id === req.session.userId);
    const settings = db.data.settings;

    console.log(`🔍 Verifying BEP20 payment for ${user.email}, amount: $${amount}, type: ${type}`);

    const verification = await verifyBEP20Payment(settings.bep20Address, parseFloat(amount));

    if (verification.success) {
      console.log('✅ BEP20 payment verified successfully');

      if (type === 'activation') {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + settings.validityDays);

        const activation = {
          id: uuidv4(),
          userId: user.id,
          activationKey: generateActivationKey(),
          paymentAmount: settings.activationPrice,
          paymentMethod: 'BEP20',
          transactionHash: verification.transaction.hash,
          activationDate: new Date().toISOString(),
          expiryDate: expiryDate.toISOString(),
          status: 'active'
        };

        db.data.activations.push(activation);
        db.write();
        req.session.isActivated = true;

        // Send activation success email
        await queueEmail(user.email, '🎉 Account Activated Successfully!', `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; border-radius: 15px;">
            <div style="text-align: center; padding: 30px;">
              <h1 style="color: #ffd700; margin-bottom: 10px;">✅ Activation Successful!</h1>
              <h2 style="margin-bottom: 20px;">Welcome to PostPay Premium, ${user.name}!</h2>
            </div>
            <div style="background: white; color: #333; padding: 30px; border-radius: 10px;">
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                <strong>Your account has been successfully activated!</strong>
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                <strong>Activation Key:</strong> ${activation.activationKey}<br>
                <strong>Expiry Date:</strong> ${expiryDate.toLocaleDateString()}<br>
                <strong>Payment Amount:</strong> $${settings.activationPrice} USDT
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                You can now create professional wallet displays and use all premium features for 30 days!
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="http://localhost:${PORT}/dashboard"
                  style="background: #10b981; color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">
                  🚀 Start Creating Displays
                </a>
              </div>
            </div>
          </div>
        `);

        // Log admin action
        db.data.adminLogs.push({
          id: uuidv4(),
          action: 'user_activated',
          userId: user.id,
          userEmail: user.email,
          activationKey: activation.activationKey,
          time: new Date().toISOString()
        });
        db.write();

        res.redirect('/dashboard?success=activation_success');
      } else if (type === 'edit_access') {
        const expiryDate = new Date();
        expiryDate.setHours(expiryDate.getHours() + settings.editAccessHours);

        const editAccess = {
          id: uuidv4(),
          userId: user.id,
          paymentAmount: settings.editPrice,
          paymentMethod: 'BEP20',
          transactionHash: verification.transaction.hash,
          purchaseDate: new Date().toISOString(),
          expiryDate: expiryDate.toISOString(),
          status: 'active'
        };

        db.data.editRequests.push(editAccess);
        db.write();

        // Send edit access email
        await queueEmail(user.email, '✏️ Edit Access Activated!', `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; padding: 20px; background: #1e3a8a; color: white; border-radius: 10px 10px 0 0;">
              <h1 style="color: #ffd700; margin-bottom: 10px;">✏️ Edit Access Activated!</h1>
            </div>
            <div style="padding: 30px; background: #f8f9fa; border-radius: 0 0 10px 10px;">
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                Hello ${user.name},
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
                You now have <strong>24-hour edit access</strong> for your wallet display.
              </p>
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                <strong>Expiry:</strong> ${expiryDate.toLocaleString()}
              </p>
              <div style="text-align: center;">
                <a href="http://localhost:${PORT}/dashboard"
                  style="background: #1e3a8a; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                  Edit Your Display
                </a>
              </div>
            </div>
          </div>
        `);

        res.redirect('/dashboard?success=edit_access_granted');
      }
    } else {
      console.log('❌ BEP20 payment verification failed:', verification.error);
      res.redirect('/dashboard?error=payment_not_found');
    }
  } catch (error) {
    console.error('BEP20 verification error:', error);
    res.redirect('/dashboard?error=verification_failed');
  }
});

// Manual User Activation by Admin
app.post('/admin/activate-user', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const user = db.data.users.find(u => u.id === userId);

    if (!user) {
      return res.redirect('/admin?error=user_not_found');
    }

    // Check if user already has active activation
    const existingActivation = db.data.activations.find(a =>
      a.userId === userId &&
      a.status === 'active' &&
      new Date(a.expiryDate) >= new Date()
    );

    if (existingActivation) {
      return res.redirect('/admin?error=already_activated');
    }

    // Create manual activation
    const settings = db.data.settings;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + settings.validityDays);

    const activation = {
      id: uuidv4(),
      userId: user.id,
      activationKey: generateActivationKey(),
      paymentAmount: 0, // Manual activation - no payment
      paymentMethod: 'MANUAL_ADMIN',
      transactionHash: 'MANUAL_ACTIVATION_BY_ADMIN',
      activationDate: new Date().toISOString(),
      expiryDate: expiryDate.toISOString(),
      status: 'active',
      manualActivation: true,
      activatedBy: 'admin',
      activatedAt: new Date().toISOString()
    };

    db.data.activations.push(activation);
    db.write();

    // Send activation email
    try {
      await queueEmail(user.email, '🎉 Account Manually Activated by Admin!', `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; border-radius: 15px;">
          <div style="text-align: center; padding: 30px;">
            <h1 style="color: #ffd700; margin-bottom: 10px;">✅ Account Activated!</h1>
            <h2 style="margin-bottom: 20px;">Welcome to PostPay Premium, ${user.name}!</h2>
          </div>
          <div style="background: white; color: #333; padding: 30px; border-radius: 10px;">
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              <strong>Your account has been manually activated by the administrator!</strong>
            </p>
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              <strong>Activation Key:</strong> ${activation.activationKey}<br>
              <strong>Expiry Date:</strong> ${expiryDate.toLocaleDateString()}<br>
              <strong>Activation Type:</strong> Manual (Admin Approved)
            </p>
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
              You can now create professional wallet displays and use all premium features for 30 days!
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="http://localhost:${PORT}/dashboard"
                style="background: #10b981; color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">
                🚀 Start Creating Displays
              </a>
            </div>
          </div>
        </div>
      `);
    } catch (emailError) {
      console.log('❌ Failed to send activation email:', emailError.message);
    }

    // Log admin action
    db.data.adminLogs.push({
      id: uuidv4(),
      action: 'manual_user_activation',
      userId: user.id,
      userEmail: user.email,
      activationKey: activation.activationKey,
      details: `Admin manually activated user ${user.email}`,
      time: new Date().toISOString()
    });
    db.write();

    console.log(`✅ Admin manually activated user: ${user.email}`);
    res.redirect('/admin?success=user_activated');
  } catch (error) {
    console.error('Manual activation error:', error);
    res.redirect('/admin?error=activation_failed');
  }
});

// Admin Routes
app.get('/admin/login', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login - PostPay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .login-container { max-width: 400px; width: 100%; background: #fff; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; }
    .admin-header { text-align: center; margin-bottom: 30px; }
    .admin-title { color: #ffd700; font-weight: 800; font-size: 24px; margin-bottom: 10px; }
    .admin-subtitle { color: #666; font-size: 14px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-weight: 600; color: #555; }
    input { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; transition: border-color 0.3s; }
    input:focus { border-color: #1e3a8a; outline: none; }
    .login-btn { width: 100%; padding: 14px; background: #1e3a8a; border: none; border-radius: 10px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.3s; }
    .login-btn:hover { background: #3b82f6; }
    .error-message { color: #ef4444; text-align: center; margin-top: 15px; padding: 10px; background: #fee2e2; border-radius: 5px; }

    /* Mobile Responsive */
    @media (max-width: 768px) {
      .login-container { padding: 35px; max-width: 100%; }
      .admin-title { font-size: 22px; }
      .admin-subtitle { font-size: 13px; }
    }
    @media (max-width: 480px) {
      body { padding: 15px; }
      .login-container { padding: 30px 25px; border-radius: 15px; }
      .admin-title { font-size: 20px; }
      .admin-subtitle { font-size: 12px; }
      .form-group { margin-bottom: 18px; }
      input { font-size: 16px; padding: 11px; }
      .login-btn { padding: 13px; font-size: 15px; }
      .error-message { font-size: 14px; padding: 9px; }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="admin-header">
      <div class="admin-title">🔐 Admin Portal</div>
      <div class="admin-subtitle">PostPay Management System</div>
    </div>
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label for="email">Admin Email</label>
        <input type="email" id="email" name="email" placeholder="admin@example.com" required>
      </div>
      <div class="form-group">
        <label for="password">Admin Password</label>
        <input type="password" id="password" name="password" placeholder="••••••••" required>
      </div>
      <button type="submit" class="login-btn">Login to Admin Dashboard</button>
    </form>
    ${req.query.error === 'invalid' ? '<div class="error-message">Invalid credentials. Please try again.</div>' : ''}
  </div>
</body>
</html>
  `);
});

app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  const admin = db.data.admin;

  console.log('🔐 Admin login attempt:', email);

  if (email === admin.email && compare(password, admin.passwordHash)) {
    req.session.isAdmin = true;

    // Log admin login
    db.data.adminLogs.push({
      id: uuidv4(),
      action: 'admin_login',
      details: `Admin logged in from ${req.ip}`,
      time: new Date().toISOString()
    });
    db.write();

    console.log('✅ Admin logged in successfully:', email);
    res.redirect('/admin');
  } else {
    console.log('❌ Failed admin login attempt:', email);
    res.redirect('/admin/login?error=invalid');
  }
});

// Enhanced Admin Dashboard
app.get('/admin', requireAdmin, (req, res) => {
  const users = db.data.users || [];
  const activations = db.data.activations || [];
  const displays = db.data.displays || [];
  const adminLogs = db.data.adminLogs || [];
  const settings = db.data.settings || {};

  const activeActivations = activations.filter(a => a.status === 'active' && new Date(a.expiryDate) >= new Date());
  const totalRevenue = activations.reduce((sum, act) => sum + (act.paymentAmount || 0), 0) +
    (db.data.editRequests || []).reduce((sum, edit) => sum + (edit.paymentAmount || 0), 0);

  const recentLogs = [...adminLogs].reverse().slice(0, 10);

  const success = req.query.success;
  const error = req.query.error;

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard - PostPay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8f9fa; color: #333; }
    .admin-container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .admin-header { background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; padding: 30px; border-radius: 15px; margin-bottom: 30px; }
    .admin-title { font-size: 2.5em; margin-bottom: 10px; display: flex; align-items: center; gap: 15px; }
    .admin-subtitle { font-size: 1.1em; opacity: 0.9; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 25px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); text-align: center; }
    .stat-number { font-size: 2.5em; font-weight: bold; color: #1e3a8a; margin-bottom: 10px; }
    .stat-label { color: #666; font-size: 1.1em; }
    .section { background: white; padding: 25px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 25px; }
    .section-title { font-size: 1.5em; color: #1e3a8a; margin-bottom: 20px; border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; }
    .table-container { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #e0e0e0; }
    th { background: #f8f9fa; font-weight: 600; color: #1e3a8a; }
    tr:hover { background: #f8f9fa; }
    .status-active { color: #10b981; font-weight: 600; }
    .status-inactive { color: #ef4444; font-weight: 600; }
    .nav { display: flex; gap: 15px; margin-bottom: 30px; flex-wrap: wrap; }
    .nav a { padding: 12px 25px; background: white; border-radius: 10px; text-decoration: none; color: #1e3a8a; font-weight: 600; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
    .nav a.active { background: #1e3a8a; color: white; }
    .nav a:hover { background: #3b82f6; color: white; }
    .logout-btn { background: #ef4444 !important; color: white !important; }
    .logout-btn:hover { background: #dc2626 !important; }
    .revenue { color: #10b981; font-weight: bold; }
    .log-time { font-size: 0.9em; color: #666; }
    .user-email { color: #1e3a8a; }
    .hidden { display: none; }

    /* Mobile Responsive */
    @media (max-width: 1024px) {
      .admin-container { padding: 15px; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 15px; }
      .table-container { -webkit-overflow-scrolling: touch; }
      th, td { padding: 10px 12px; font-size: 14px; }
    }
    @media (max-width: 768px) {
      .admin-header { padding: 20px; border-radius: 10px; }
      .admin-title { font-size: 2em; flex-direction: column; gap: 10px; text-align: center; }
      .admin-subtitle { font-size: 1em; }
      .stats-grid { grid-template-columns: 1fr; gap: 12px; }
      .stat-card { padding: 20px; }
      .stat-number { font-size: 2em; }
      .stat-label { font-size: 1em; }
      .section { padding: 20px; margin-bottom: 20px; }
      .section-title { font-size: 1.3em; }
      .nav { gap: 10px; }
      .nav a { padding: 10px 18px; font-size: 14px; }
      th, td { padding: 8px 10px; font-size: 13px; }
      .table-container table { min-width: 600px; }
    }
    @media (max-width: 480px) {
      .admin-container { padding: 10px; }
      .admin-header { padding: 15px; margin-bottom: 20px; }
      .admin-title { font-size: 1.6em; }
      .admin-subtitle { font-size: 0.95em; }
      .stats-grid { gap: 10px; margin-bottom: 20px; }
      .stat-card { padding: 18px; }
      .stat-number { font-size: 1.8em; margin-bottom: 8px; }
      .stat-label { font-size: 0.95em; }
      .section { padding: 15px; margin-bottom: 15px; }
      .section-title { font-size: 1.15em; padding-bottom: 8px; }
      .nav { gap: 8px; }
      .nav a { padding: 8px 15px; font-size: 13px; border-radius: 8px; }
      th, td { padding: 6px 8px; font-size: 12px; }
      .table-container table { min-width: 550px; }
      .log-time { font-size: 0.85em; }
    }
  </style>
</head>
<body>
  <div class="admin-container">
    <div class="admin-header">
      <div class="admin-title">🏠 Admin Dashboard</div>
      <div class="admin-subtitle">PostPay Management & Analytics</div>
    </div>

    <div class="nav">
      <a href="#overview" class="active">Overview</a>
      <a href="#users">Users</a>
      <a href="#activations">Activations</a>
      <a href="#displays">Displays</a>
      <a href="#logs">Activity Logs</a>
      <a href="/admin/logout" class="logout-btn">Logout</a>
    </div>

    ${success === 'user_activated' ? `
    <div style="background: #d1fae5; color: #065f46; padding: 15px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #a7f3d0;">
      <strong>✅ Success!</strong> User has been manually activated for 30 days.
    </div>
    ` : ''}

    ${error === 'already_activated' ? `
    <div style="background: #fee2e2; color: #991b1b; padding: 15px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #fecaca;">
      <strong>⚠️ Error!</strong> This user is already activated.
    </div>
    ` : ''}

    ${error === 'user_not_found' ? `
    <div style="background: #fee2e2; color: #991b1b; padding: 15px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #fecaca;">
      <strong>❌ Error!</strong> User not found.
    </div>
    ` : ''}

    ${error === 'activation_failed' ? `
    <div style="background: #fee2e2; color: #991b1b; padding: 15px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #fecaca;">
      <strong>❌ Error!</strong> Failed to activate user. Please try again.
    </div>
    ` : ''}

    <div id="overview">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-number">${users.length}</div>
          <div class="stat-label">Total Users</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${activeActivations.length}</div>
          <div class="stat-label">Active Activations</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${displays.length}</div>
          <div class="stat-label">Wallet Displays</div>
        </div>
        <div class="stat-card">
          <div class="stat-number revenue">$${totalRevenue.toFixed(2)}</div>
          <div class="stat-label">Total Revenue</div>
        </div>
      </div>

      <div class="section">
        <h3 class="section-title">📊 System Overview</h3>
        <div class="grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div>
            <h4>System Information</h4>
            <p><strong>Server:</strong> Running on port ${PORT}</p>
            <p><strong>Redis:</strong> ${redisAvailable ? '✅ Connected' : '❌ Not Available'}</p>
            <p><strong>Email:</strong> ${emailConfigured ? '✅ Configured (SendGrid)' : '❌ Not Configured'}</p>
            <p><strong>Database:</strong> ✅ LowDB Active</p>
          </div>
          <div>
            <h4>Pricing Settings</h4>
            <p><strong>Activation Price:</strong> $${settings.activationPrice || 50}</p>
            <p><strong>Edit Access Price:</strong> $${settings.editPrice || 19}</p>
            <p><strong>Validity Period:</strong> ${settings.validityDays || 30} days</p>
            <p><strong>Edit Access:</strong> ${settings.editAccessHours || 24} hours</p>
          </div>
        </div>
      </div>
    </div>

    <div id="users" class="hidden">
      <div class="section">
        <h3 class="section-title">👥 Registered Users (${users.length})</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Registered</th>
                <th>Last Login</th>
                <th>Status</th>
                <th>Profile</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(user => {
                const userActivation = activations.find(a => a.userId === user.id && a.status === 'active' && new Date(a.expiryDate) >= new Date());
                return `
                <tr>
                  <td>${user.name}</td>
                  <td class="user-email">${user.email}</td>
                  <td>${new Date(user.createdAt).toLocaleDateString()}</td>
                  <td>${user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Never'}</td>
                  <td class="${userActivation ? 'status-active' : 'status-inactive'}">
                    ${userActivation ? 'ACTIVATED' : 'INACTIVE'}
                  </td>
                  <td>
                    ${user.profileImage && user.profileImage !== '/default-avatar.png' ? '✅ Has Image' : '❌ No Image'}
                  </td>
                  <td>
                    ${!userActivation ? `
                    <form method="POST" action="/admin/activate-user" style="display: inline;" onsubmit="return confirm('Manually activate ${user.email}?')">
                      <input type="hidden" name="userId" value="${user.id}">
                      <button type="submit" style="background: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 600;">
                        ✅ Activate Manually
                      </button>
                    </form>
                    ` : `
                    <span style="color: #10b981; font-size: 12px;">✅ Active</span>
                    `}
                  </td>
                </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="activations" class="hidden">
      <div class="section">
        <h3 class="section-title">🔑 User Activations (${activations.length})</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>User Email</th>
                <th>Activation Key</th>
                <th>Payment Method</th>
                <th>Amount</th>
                <th>Activated</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${activations.map(activation => {
                const user = users.find(u => u.id === activation.userId);
                const isActive = activation.status === 'active' && new Date(activation.expiryDate) >= new Date();
                return `
                <tr>
                  <td class="user-email">${user ? user.email : 'Unknown User'}</td>
                  <td><code>${activation.activationKey}</code></td>
                  <td>${activation.paymentMethod}</td>
                  <td>$${activation.paymentAmount}</td>
                  <td>${new Date(activation.activationDate).toLocaleDateString()}</td>
                  <td>${new Date(activation.expiryDate).toLocaleDateString()}</td>
                  <td class="${isActive ? 'status-active' : 'status-inactive'}">
                    ${isActive ? 'ACTIVE' : 'EXPIRED'}
                  </td>
                </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="displays" class="hidden">
      <div class="section">
        <h3 class="section-title">🎨 Wallet Displays (${displays.length})</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Display Name</th>
                <th>User Email</th>
                <th>Balance</th>
                <th>Account Type</th>
                <th>Created</th>
                <th>Public URL</th>
              </tr>
            </thead>
            <tbody>
              ${displays.map(display => {
                const user = users.find(u => u.id === display.userId);
                const userActivation = activations.find(a => a.userId === display.userId && a.status === 'active' && new Date(a.expiryDate) >= new Date());
                return `
                <tr>
                  <td><strong>${display.walletName}</strong></td>
                  <td class="user-email">${user ? user.email : 'Unknown User'}</td>
                  <td>$${display.balance.toFixed(2)}</td>
                  <td>${display.accountType}</td>
                  <td>${new Date(display.createdAt).toLocaleDateString()}</td>
                  <td>
                    ${userActivation ? `
                    <a href="/display/${display.id}" target="_blank">
                      /display/${display.id}
                    </a>
                    ` : '❌ Inactive (Activation Expired)'}
                  </td>
                </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="logs" class="hidden">
      <div class="section">
        <h3 class="section-title">📋 Activity Logs (Last 10)</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>User</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              ${recentLogs.map(log => `
              <tr>
                <td class="log-time">${new Date(log.time).toLocaleString()}</td>
                <td><strong>${log.action.replace(/_/g, ' ').toUpperCase()}</strong></td>
                <td class="user-email">${log.userEmail || log.userId || 'System'}</td>
                <td>${log.details || log.displayName || log.activationKey || 'No additional details'}</td>
              </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Navigation for admin dashboard
    document.querySelectorAll('.nav a').forEach(link => {
      if (link.getAttribute('href').startsWith('#')) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
          link.classList.add('active');
          document.getElementById('overview').style.display = 'none';
          document.getElementById('users').style.display = 'none';
          document.getElementById('activations').style.display = 'none';
          document.getElementById('displays').style.display = 'none';
          document.getElementById('logs').style.display = 'none';
          const targetId = link.getAttribute('href').substring(1);
          document.getElementById(targetId).style.display = 'block';
        });
      }
    });

    // Show overview by default
    document.getElementById('overview').style.display = 'block';
  </script>
</body>
</html>
  `);
});

// Public Display View with Authentication
app.get('/display/:displayId', (req, res) => {
  const display = db.data.displays.find(d => d.id === req.params.displayId);

  if (!display) {
    return res.status(404).send(`
      <html>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h2>Display Not Found</h2>
        <p>This wallet display doesn't exist or has been deactivated.</p>
        <a href="/">Return to Home</a>
      </body>
      </html>
    `);
  }

  // Check if display owner has active activation
  const ownerActivation = db.data.activations.find(a =>
    a.userId === display.userId &&
    a.status === 'active' &&
    new Date(a.expiryDate) >= new Date()
  );

  if (!ownerActivation) {
    return res.status(404).send(`
      <html>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h2>Display Not Available</h2>
        <p>This wallet display is currently unavailable because the owner's activation has expired.</p>
        <p>Please contact the display owner to renew their activation.</p>
        <a href="/">Return to Home</a>
      </body>
      </html>
    `);
  }

  const owner = db.data.users.find(u => u.id === display.userId);

  // Check if user is authenticated to view this display
  const isAuthenticated = req.session &&
    req.session.displayAuth &&
    req.session.displayAuth[display.id] === display.userId;

  if (!isAuthenticated) {
    // Show login form
    const error = req.query.error;
    return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Required - ${display.walletName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .login-box { max-width: 450px; width: 100%; background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; }
    .header { text-align: center; margin-bottom: 30px; }
    .icon { font-size: 4em; margin-bottom: 15px; }
    h2 { color: #1e3a8a; margin-bottom: 10px; font-size: 1.8em; }
    .subtitle { color: #666; font-size: 0.95em; margin-bottom: 5px; }
    .wallet-name { color: #1e3a8a; font-weight: 600; margin-top: 10px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-weight: 600; color: #555; }
    input { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; transition: border-color 0.3s; }
    input:focus { border-color: #1e3a8a; outline: none; }
    .btn { width: 100%; padding: 14px; background: #1e3a8a; border: none; border-radius: 10px; color: white; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.3s; }
    .btn:hover { background: #3b82f6; }
    .error { background: #fee2e2; color: #991b1b; padding: 12px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #fecaca; text-align: center; }
    .info { background: #dbeafe; color: #1e40af; padding: 12px; border-radius: 8px; margin-top: 20px; font-size: 0.9em; text-align: center; }

    @media (max-width: 480px) {
      .login-box { padding: 30px 25px; }
      h2 { font-size: 1.5em; }
      .icon { font-size: 3em; }
    }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="header">
      <div class="icon">🔐</div>
      <h2>Login Required</h2>
      <p class="subtitle">Please login to view this wallet display</p>
      <p class="wallet-name">${display.walletName}</p>
    </div>

    ${error === 'invalid' ? '<div class="error">Invalid email or password. Please try again.</div>' : ''}

    <form method="POST" action="/display/${display.id}/auth">
      <div class="form-group">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email" placeholder="Enter your email" required autofocus>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Enter your password" required>
      </div>
      <button type="submit" class="btn">Login to View Display</button>
    </form>

    <div class="info">
      💡 Login with your PostPay account credentials
    </div>
  </div>
</body>
</html>
    `);
  }

  // User is authenticated, show the display with corrected hide/show balance feature
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${display.walletName} - Wallet Display</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: #333; min-height: 100vh; }
    .container { max-width: 800px; margin: 0 auto; padding: 30px; }
    .display-card { background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; position: relative; }
    .header { background: #1e3a8a; color: white; padding: 30px; text-align: center; position: relative; }
    .wallet-name { font-size: 2.5em; margin-bottom: 10px; }
    .account-type { font-size: 1.2em; opacity: 0.9; }
    .content { padding: 40px; }
    .balance-section { text-align: center; margin-bottom: 40px; position: relative; }
    .balance-amount-container { display: flex; align-items: center; justify-content: center; margin: 10px 0; }
    .balance-amount { font-size: 3em; color: #1e3a8a; font-weight: bold; margin: 10px 0; transition: all 0.3s; }
    .balance-label { font-size: 1.2em; color: #666; }
    .balance-toggle { background: rgba(30, 58, 138, 0.1); border: 2px solid #1e3a8a; color: #1e3a8a; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.3s; margin-left: 15px; backdrop-filter: blur(10px); }
    .balance-toggle:hover { background: rgba(30, 58, 138, 0.2); transform: scale(1.05); }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 40px; }
    .info-card { background: #f8f9fa; padding: 25px; border-radius: 15px; border-left: 5px solid #1e3a8a; }
    .info-title { font-size: 1.1em; color: #666; margin-bottom: 10px; }
    .info-value { font-size: 1.4em; color: #1e3a8a; font-weight: bold; }
    .transactions-section h3 { color: #1e3a8a; margin-bottom: 20px; border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; }
    .transaction-item { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 15px; padding: 15px; border-bottom: 1px solid #eee; }
    .transaction-item:last-child { border-bottom: none; }
    .transaction-desc { font-weight: 600; }
    .transaction-amount { text-align: right; font-weight: bold; }
    .transaction-amount.positive { color: #10b981; }
    .transaction-amount.negative { color: #ef4444; }
    .transaction-date { color: #666; font-size: 0.9em; }
    .footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #666; }
    .notes { background: #fff3cd; padding: 20px; border-radius: 10px; margin-top: 20px; border-left: 5px solid #ffc107; }
    .powered-by { color: #ffd700; font-weight: bold; }
    .logout-btn { text-align: center; margin-top: 20px; }
    .logout-btn a { display: inline-block; padding: 10px 20px; background: #ef4444; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; transition: background 0.3s; }
    .logout-btn a:hover { background: #dc2626; }

    /* Mobile Responsive */
    @media (max-width: 768px) {
      .container { padding: 20px; }
      .header { padding: 25px 20px; }
      .wallet-name { font-size: 2em; }
      .account-type { font-size: 1em; }
      .content { padding: 30px 20px; }
      .balance-amount-container { flex-direction: column; gap: 10px; }
      .balance-toggle { margin-left: 0; margin-top: 10px; }
      .balance-amount { font-size: 2.5em; }
      .balance-label { font-size: 1em; }
      .info-grid { grid-template-columns: 1fr; gap: 20px; }
      .info-card { padding: 20px; }
      .info-title { font-size: 1em; }
      .info-value { font-size: 1.2em; }
      .transaction-item { grid-template-columns: 1fr; gap: 8px; padding: 12px; }
      .transaction-amount { text-align: left; }
      .transaction-date { font-size: 0.85em; }
      .notes { padding: 15px; }
    }
    @media (max-width: 480px) {
      .container { padding: 15px; }
      .display-card { border-radius: 15px; }
      .header { padding: 20px 15px; }
      .wallet-name { font-size: 1.6em; word-break: break-word; }
      .account-type { font-size: 0.95em; }
      .content { padding: 25px 15px; }
      .balance-section { margin-bottom: 30px; }
      .balance-amount { font-size: 2em; }
      .balance-label { font-size: 0.95em; }
      .info-grid { gap: 15px; margin-bottom: 30px; }
      .info-card { padding: 15px; border-left-width: 4px; }
      .info-title { font-size: 0.95em; }
      .info-value { font-size: 1.1em; word-break: break-word; }
      .transactions-section h3 { font-size: 1.1em; margin-bottom: 15px; }
      .transaction-item { padding: 10px; }
      .transaction-desc { font-size: 0.95em; }
      .transaction-date { font-size: 0.8em; }
      .transaction-amount { font-size: 1em; }
      .notes { padding: 12px; font-size: 0.9em; }
      .footer { margin-top: 30px; font-size: 0.9em; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="display-card">
      <div class="header">
        <div class="wallet-name">${display.walletName || 'My Wallet'}</div>
        <div class="account-type">${display.accountType || 'General'} Account</div>
      </div>

      <div class="content">
        <div class="balance-section">
          <div class="balance-label">Current Balance</div>
          <div class="balance-amount-container">
            <div class="balance-amount" id="balanceAmount" style="filter: blur(12px); user-select: none;">$${display.balance.toFixed(2)}</div>
            <button class="balance-toggle" onclick="toggleBalance()">
              <span id="toggleIcon">👁️‍🗨️</span> <span id="toggleText">Show Balance</span>
            </button>
          </div>
          <div class="balance-label">USD</div>
        </div>

        <div class="info-grid">
          <div class="info-card">
            <div class="info-title">Next Withdrawable Date</div>
            <div class="info-value">${new Date(display.nextWithdrawableDate).toLocaleDateString()}</div>
          </div>
          <div class="info-card">
            <div class="info-title">Account Holder</div>
            <div class="info-value">${owner.name}</div>
          </div>
        </div>

        <div class="transactions-section">
          <h3>Recent Transactions</h3>
          ${display.transactions && display.transactions.length > 0 ? display.transactions.map(transaction => `
          <div class="transaction-item">
            <div class="transaction-desc">${transaction.description || 'Transaction'}</div>
            <div class="transaction-date">
              ${new Date(transaction.date).toLocaleDateString()} at ${transaction.time || '12:00'}
            </div>
            <div class="transaction-amount ${transaction.amount >= 0 ? 'positive' : 'negative'}">
              ${transaction.amount >= 0 ? '+' : ''}$${Math.abs(transaction.amount).toFixed(2)}
            </div>
          </div>
          `).join('') : `
          <div class="transaction-item">
            <div class="transaction-desc">No transactions available</div>
            <div class="transaction-date">-</div>
            <div class="transaction-amount">$0.00</div>
          </div>
          `}
        </div>

        ${display.additionalNotes ? `
        <div class="notes">
          <strong>Additional Notes:</strong><br>
          ${display.additionalNotes}
        </div>
        ` : ''}

        <div class="footer">
          <p>Generated by PostPay • ${new Date().toLocaleDateString()}</p>
          <p>Powered by <span class="powered-by">PostPay</span></p>
        </div>

        <div class="logout-btn">
          <a href="/display/${display.id}/logout">🚪 Logout</a>
        </div>
      </div>
    </div>
  </div>

  <script>
    let balanceVisible = false;

    function toggleBalance() {
      const balanceElement = document.getElementById('balanceAmount');
      const toggleIcon = document.getElementById('toggleIcon');
      const toggleText = document.getElementById('toggleText');
      
      balanceVisible = !balanceVisible;

      if (balanceVisible) {
        // Show balance
        balanceElement.style.filter = 'none';
        balanceElement.style.userSelect = 'auto';
        toggleIcon.textContent = '👁️';
        toggleText.textContent = 'Hide Balance';
      } else {
        // Hide balance
        balanceElement.style.filter = 'blur(12px)';
        balanceElement.style.userSelect = 'none';
        toggleIcon.textContent = '👁️‍🗨️';
        toggleText.textContent = 'Show Balance';
      }
    }
  </script>
</body>
</html>
  `);
});

// Display Authentication Handler
app.post('/display/:displayId/auth', (req, res) => {
  const { email, password } = req.body;
  const display = db.data.displays.find(d => d.id === req.params.displayId);

  if (!display) {
    return res.redirect('/');
  }

  // Find the owner of the display
  const owner = db.data.users.find(u => u.id === display.userId);

  if (!owner) {
    return res.redirect(`/display/${req.params.displayId}?error=invalid`);
  }

  // Verify credentials match the display owner
  if (email === owner.email && compare(password, owner.passwordHash)) {
    // Store authentication in session
    if (!req.session.displayAuth) {
      req.session.displayAuth = {};
    }
    req.session.displayAuth[display.id] = owner.id;

    console.log(`✅ Display authenticated for user: ${email}`);
    res.redirect(`/display/${req.params.displayId}`);
  } else {
    console.log(`❌ Failed display auth attempt for: ${email}`);
    res.redirect(`/display/${req.params.displayId}?error=invalid`);
  }
});

// Display Logout Handler
app.get('/display/:displayId/logout', (req, res) => {
  if (req.session.displayAuth) {
    delete req.session.displayAuth[req.params.displayId];
  }
  res.redirect(`/display/${req.params.displayId}`);
});

// Logout routes
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Health check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    redis: redisAvailable,
    email: emailConfigured,
    database: 'lowdb',
    users: db.data.users.length,
    activations: db.data.activations.length,
    displays: db.data.displays.length,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send('<p>Something went wrong! <a href="/">Go home</a></p>');
});

// 404 handler
app.use((req, res) => {
  res.status(404).send(`
    <html>
    <body style="font-family: Arial; text-align: center; padding: 50px;">
      <h2>Page Not Found</h2>
      <p>The page you're looking for doesn't exist.</p>
      <a href="/">Return to Home</a>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 POSTPAY SERVER STARTED SUCCESSFULLY
✅ Application running on: http://localhost:${PORT}
✅ Admin panel: http://localhost:${PORT}/admin/login
✅ Database initialized with ${db.data.users.length} users
✅ Email system: ${emailConfigured ? 'READY (SendGrid)' : 'NOT CONFIGURED'}
✅ Redis: ${redisAvailable ? 'CONNECTED' : 'UNAVAILABLE'}
📧 Email Configuration: ${SENDGRID_API_KEY ? 'SET' : 'NOT SET'}
🔑 Admin Login: ${process.env.ADMIN_EMAIL || 'techmagnet.pro@gmail.com'}
💡 Next Steps:
1. Visit http://localhost:${PORT} to test the application
2. Register a new user account
3. Test email functionality with SendGrid
4. Configure ngrok for public access
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down PostPay server...');
  if (redisClient) {
    redisClient.quit();
  }
  process.exit(0);
});
