import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import {
  getAdminByUsername,
  getAllPricing,
  getPricingMap,
  updatePricing,
  createQuote,
  getQuotesPaginated,
  getDriverByUsername,
  getSetting,
  updateSetting,
  createDriverInterest,
  getDriverInterestsByDriver,
  getPendingInterestsForAdmin,
  getInterestById,
  updateInterestStatus,
  getQuoteIdsWithInterests,
  getAllDrivers,
  createDriver,
  getQuoteById,
  updateQuoteStatus
} from './database.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;

// ─── SIMPLE IN-MEMORY RATE LIMITER ───
// Protects against spam/abuse. Limits are generous for normal use.
const rateLimitStore = new Map();

function rateLimit({ windowMs, max, keyGenerator, message }) {
  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let record = rateLimitStore.get(key);

    if (!record) {
      record = { count: 1, resetAt: now + windowMs };
      rateLimitStore.set(key, record);
    } else if (now > record.resetAt) {
      record.count = 1;
      record.resetAt = now + windowMs;
    } else {
      record.count++;
    }

    if (record.count > max) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: message || 'Too many requests. Please try again later.' });
    }

    next();
  };
}

// Clean up old rate limit entries every 10 minutes to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore) {
    if (now > record.resetAt + 60000) {
      rateLimitStore.delete(key);
    }
  }
}, 600000);
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey && stripeSecretKey !== 'your_stripe_restricted_key_here'
  ? new Stripe(stripeSecretKey)
  : null;

// Email transport (nodemailer)
const smtpHost = process.env.SMTP_HOST;
const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const fromEmail = process.env.FROM_EMAIL || 'noreply@vsdsynergy.co.uk';

const emailTransporter = (smtpHost && smtpUser && smtpPass)
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    })
  : null;

async function sendEmail(to, subject, html) {
  if (!emailTransporter) {
    console.log('[EMAIL FALLBACK] To:', to, 'Subject:', subject);
    console.log('[EMAIL FALLBACK] Body:', html.replace(/\s+/g, ' ').substring(0, 500));
    return { fallback: true };
  }
  try {
    const info = await emailTransporter.sendMail({ from: `"VSD Synergy" <${fromEmail}>`, to, subject, html });
    console.log('Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { error: err.message };
  }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set to true in production with HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Explicit routes for quote pages (so /quote/removal works without trailing slash)
app.get('/quote/removal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quote', 'removal', 'index.html'));
});
app.get('/quote/cleaning', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quote', 'cleaning', 'index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/driver', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'driver', 'index.html'));
});
app.get('/payment/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment-success.html'));
});
app.get('/payment/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment-cancel.html'));
});

// ─── GEOCODE AUTOCOMPLETE PROXY ───
// Proxies address autocomplete requests to Geoapify so the API key stays hidden
app.get('/api/geocode/autocomplete',
  rateLimit({
    windowMs: 60000,
    max: 30,
    keyGenerator: (req) => `geocode-${req.ip}`,
    message: 'Too many address searches. Please try again in a minute.'
  }),
  async (req, res) => {
    const query = req.query.query;
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    try {
      const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(query)}&apiKey=${GEOAPIFY_API_KEY}&limit=10&filter=countrycode:gb`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Geoapify API error');
      const data = await response.json();

      // Filter for England only (same logic as frontend)
      const features = data.features || [];
      const englandResults = features.filter(feature => {
        const props = feature.properties || {};
        const state = (props.state || '').toLowerCase();
        const stateCode = (props.state_code || '').toLowerCase();
        if (state === 'england' || stateCode === 'eng') return true;
        if (state === 'scotland' || stateCode === 'sct') return false;
        if (state === 'wales' || stateCode === 'wls') return false;
        if (state === 'northern ireland' || stateCode === 'nir') return false;
        const formatted = (props.formatted || '').toLowerCase();
        if (formatted.includes('scotland') || formatted.includes('wales') || formatted.includes('northern ireland')) return false;
        return true;
      });

      res.json({ features: englandResults.slice(0, 5) });
    } catch (err) {
      console.error('Geocode autocomplete error:', err.message);
      res.status(500).json({ error: 'Failed to fetch address suggestions' });
    }
  }
);

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireDriverAuth(req, res, next) {
  if (req.session && req.session.driverId) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─── AUTH ROUTES ───

app.post('/api/auth/login',
  rateLimit({
    windowMs: 60000,
    max: 5,
    keyGenerator: (req) => `login-admin-${req.ip}`,
    message: 'Too many login attempts. Please try again in a minute.'
  }),
  async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const admin = getAdminByUsername(username);
  if (!admin) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.adminId = admin.id;
  req.session.username = admin.username;
  res.json({ success: true, username: admin.username });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session.adminId) {
    res.json({ authenticated: true, username: req.session.username, role: 'admin' });
  } else {
    res.json({ authenticated: false });
  }
});

// ─── DRIVER AUTH ROUTES ───

app.post('/api/driver/auth/login',
  rateLimit({
    windowMs: 60000,
    max: 5,
    keyGenerator: (req) => `login-driver-${req.ip}`,
    message: 'Too many login attempts. Please try again in a minute.'
  }),
  async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const driver = getDriverByUsername(username);
  if (!driver) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, driver.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.driverId = driver.id;
  req.session.driverUsername = driver.username;
  res.json({ success: true, username: driver.username });
});

app.post('/api/driver/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/driver/auth/me', (req, res) => {
  if (req.session.driverId) {
    const driver = getDriverByUsername(req.session.driverUsername);
    res.json({ authenticated: true, username: req.session.driverUsername, role: 'driver', driver_code: driver?.driver_code || null });
  } else {
    res.json({ authenticated: false });
  }
});

// ─── SETTINGS ROUTES ───

app.get('/api/settings/:key', requireAuth, (req, res) => {
  const setting = getSetting(req.params.key);
  if (!setting) {
    return res.status(404).json({ error: 'Setting not found' });
  }
  res.json(setting);
});

app.put('/api/settings/:key', requireAuth, (req, res) => {
  const { value } = req.body;
  if (value === undefined) {
    return res.status(400).json({ error: 'Value required' });
  }
  updateSetting(req.params.key, String(value));
  res.json({ success: true, key: req.params.key, value: String(value) });
});

// ─── DRIVER QUOTES ROUTES ───

app.get('/api/driver/quotes', requireDriverAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const result = getQuotesPaginated(page, limit);

  // Get commission percentage from settings
  const setting = getSetting('driver_commission_percentage');
  const percentage = setting ? parseFloat(setting.value) : 30;

  // Apply reduction to each quote
  const quotes = result.quotes.map(q => {
    const reducedPrice = q.calculated_price * (1 - percentage / 100);
    return {
      ...q,
      driver_price: Math.round(reducedPrice * 100) / 100,
      commission_percentage: percentage
    };
  });

  res.json({ quotes, total: result.total, page: result.page, limit: result.limit, commission_percentage: percentage });
});

// ─── DRIVER INTEREST ROUTES ───

app.post('/api/driver/interests',
  rateLimit({
    windowMs: 60000, // 1 minute
    max: 10,
    keyGenerator: (req) => `interest-driver-${req.session.driverId}`,
    message: 'Too many interest submissions. Please try again in a minute.'
  }),
  requireDriverAuth,
  (req, res) => {
  const { quoteId, email } = req.body;
  if (!quoteId || !email) {
    return res.status(400).json({ error: 'Quote ID and email are required' });
  }
  try {
    const result = createDriverInterest(quoteId, req.session.driverId, email);
    res.json({ success: true, interestId: result.lastInsertRowid });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'You have already expressed interest in this quote' });
    }
    console.error('Create interest error:', err);
    res.status(500).json({ error: 'Failed to submit interest' });
  }
});

app.get('/api/driver/interests', requireDriverAuth, (req, res) => {
  try {
    const interests = getDriverInterestsByDriver(req.session.driverId);
    res.json({ interests });
  } catch (err) {
    console.error('Get driver interests error:', err);
    res.status(500).json({ error: 'Failed to load interests' });
  }
});

app.get('/api/driver/taken-quotes', requireDriverAuth, (req, res) => {
  try {
    const rows = getQuoteIdsWithInterests();
    res.json({ quoteIds: rows.map(r => r.quote_id) });
  } catch (err) {
    console.error('Get taken quotes error:', err);
    res.status(500).json({ error: 'Failed to load taken quotes' });
  }
});

// ─── ADMIN INTEREST ROUTES ───

app.get('/api/admin/interests', requireAuth, (req, res) => {
  try {
    const interests = getPendingInterestsForAdmin();
    res.json({ interests });
  } catch (err) {
    console.error('Get admin interests error:', err);
    res.status(500).json({ error: 'Failed to load interests' });
  }
});

app.put('/api/admin/interests/:id/accept', requireAuth, async (req, res) => {
  try {
    const interest = getInterestById(req.params.id);
    if (!interest) {
      return res.status(404).json({ error: 'Interest not found' });
    }
    if (interest.status !== 'pending') {
      return res.status(400).json({ error: 'Interest is not pending' });
    }

    updateInterestStatus(req.params.id, 'accepted');

    // Parse form data for job details
    const formData = JSON.parse(interest.form_data || '{}');
    const dateValue = interest.service_type === 'removal' ? formData.moveDateValue : formData.cleaningDateValue;
    const timeValue = formData.selectedTimeSlot || 'N/A';
    const addresses = interest.service_type === 'removal'
      ? `\nPickup: ${formData.pickupAddress || 'N/A'}\nDropoff: ${formData.dropoffAddress || 'N/A'}`
      : `\nAddress: ${formData.houseAddress || 'N/A'}`;

    // Send acceptance email to driver
    const emailResult = await sendEmail(
      interest.driver_email,
      'Job Application Accepted - VSD Synergy',
      `<html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #3080E8;">Congratulations, your application has been accepted!</h2>
        <p>Hi ${interest.driver_username},</p>
        <p>You have been assigned to the following job:</p>
        <table style="border-collapse: collapse; width: 100%; max-width: 500px;">
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Your Driver ID</td><td style="padding: 8px; border-bottom: 1px solid #eee; color: #3080E8; font-weight: bold;">${interest.driver_code || 'N/A'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Quote #</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${interest.quote_id}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Customer</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${interest.customer_name || 'N/A'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Service</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${interest.service_type}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Date</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${dateValue || 'N/A'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Time</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${timeValue}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Location(s)</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${addresses.replace(/\n/g, '<br>')}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Your Price</td><td style="padding: 8px; border-bottom: 1px solid #eee;">£${interest.calculated_price?.toFixed(2) || '0.00'}</td></tr>
        </table>
        <p>Please contact the customer to confirm arrangements.</p>
        <p style="margin-top: 24px; color: #666; font-size: 12px;">VSD Synergy Limited</p>
      </body>
      </html>`
    );

    res.json({ success: true, interest, email: emailResult });
  } catch (err) {
    console.error('Accept interest error:', err);
    res.status(500).json({ error: 'Failed to accept interest' });
  }
});

app.put('/api/admin/interests/:id/reject', requireAuth, async (req, res) => {
  try {
    const interest = getInterestById(req.params.id);
    if (!interest) {
      return res.status(404).json({ error: 'Interest not found' });
    }
    if (interest.status !== 'pending') {
      return res.status(400).json({ error: 'Interest is not pending' });
    }

    updateInterestStatus(req.params.id, 'rejected');

    // Send rejection email to driver
    const emailResult = await sendEmail(
      interest.driver_email,
      'Job Application Update - VSD Synergy',
      `<html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #E55A2B;">Job Application Update</h2>
        <p>Hi ${interest.driver_username},</p>
        <p>Thank you for your interest in Quote #${interest.quote_id}. Unfortunately, this job has been assigned to another driver.</p>
        <p>Please keep an eye on the driver dashboard for new opportunities.</p>
        <p style="margin-top: 24px; color: #666; font-size: 12px;">VSD Synergy Limited</p>
      </body>
      </html>`
    );

    res.json({ success: true, interest, email: emailResult });
  } catch (err) {
    console.error('Reject interest error:', err);
    res.status(500).json({ error: 'Failed to reject interest' });
  }
});

// ─── ADMIN DRIVER ROUTES ───

app.get('/api/admin/drivers', requireAuth, (req, res) => {
  try {
    const drivers = getAllDrivers();
    res.json({ drivers });
  } catch (err) {
    console.error('Get drivers error:', err);
    res.status(500).json({ error: 'Failed to load drivers' });
  }
});

app.post('/api/admin/drivers', requireAuth, (req, res) => {
  const { username } = req.body;
  if (!username || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  const existing = getDriverByUsername(username.trim());
  if (existing) {
    return res.status(409).json({ error: 'A driver with this username already exists' });
  }

  // Generate a random temporary password
  const tempPassword = Math.random().toString(36).slice(2, 10).toUpperCase();

  try {
    const driver = createDriver(username.trim(), tempPassword);
    res.json({ success: true, driver, tempPassword });
  } catch (err) {
    console.error('Create driver error:', err);
    res.status(500).json({ error: 'Failed to create driver' });
  }
});

// ─── PRICING ROUTES ───

app.get('/api/pricing', (req, res) => {
  const pricing = getAllPricing();
  res.json(pricing);
});

app.put('/api/pricing', requireAuth, (req, res) => {
  const updates = req.body; // Array of { id, price }
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: 'Expected array of updates' });
  }

  for (const update of updates) {
    if (typeof update.id !== 'number' || typeof update.price !== 'number') {
      return res.status(400).json({ error: 'Each update must have id and price as numbers' });
    }
    updatePricing(update.id, update.price);
  }

  res.json({ success: true, pricing: getAllPricing() });
});

// ─── QUOTE CALCULATION ───

async function getDrivingDistanceMiles(lat1, lon1, lat2, lon2) {
  try {
    const url = `https://api.geoapify.com/v1/routing?waypoints=${lat1},${lon1}|${lat2},${lon2}&mode=drive&apiKey=${GEOAPIFY_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Routing API error');
    const data = await response.json();
    // Distance in meters → miles
    const meters = data.features?.[0]?.properties?.distance;
    if (typeof meters !== 'number') throw new Error('No distance in response');
    return meters * 0.000621371;
  } catch (err) {
    console.error('Distance calculation error:', err.message);
    // Fallback: straight-line Haversine distance
    return haversineMiles(lat1, lon1, lat2, lon2);
  }
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

function parseHours(hoursValue) {
  const parsed = parseFloat(hoursValue);
  if (!isNaN(parsed) && parsed >= 2 && parsed <= 12) {
    return parsed;
  }
  // Fallback for old format
  const map = {
    '1-2': 2,
    '3-4': 4,
    '5-10': 5
  };
  return map[hoursValue] || 2;
}

// Apply customer discount to calculated quote result
function applyCustomerDiscount(calc) {
  const setting = getSetting('customer_discount_percentage');
  const discountPercentage = setting ? parseFloat(setting.value) : 0;
  const discountedTotal = calc.total * (1 - discountPercentage / 100);
  return {
    ...calc,
    originalTotal: calc.total,
    discountPercentage,
    total: Math.round(discountedTotal * 100) / 100
  };
}

async function calculateRemovalQuote(formData) {
  const pricing = getPricingMap();

  // Base hourly rate
  const baseHourlyRate = (pricing.base_hourly && pricing.base_hourly.rate) || 0;

  // Van size
  const vanPrice = (pricing.van_size && pricing.van_size[formData.vanType]) || 0;

  // Helpers
  const helperPrice = (pricing.helpers && pricing.helpers[formData.helperType]) || 0;

  // Stairs (map individual floor to group key)
  function mapFloorToGroup(floor) {
    if (floor === 'ground') return 'ground';
    if (['1', '2'].includes(floor)) return '1-2';
    if (['3', '4', '5'].includes(floor)) return '3-5';
    if (['6', '7', '8', '9', '10'].includes(floor)) return '6-10';
    return floor;
  }

  let stairsPrice = 0;
  if (formData.verticalTransport === 'stairs') {
    const pickupRange = formData.pickupFloorRange;
    const dropoffRange = formData.dropoffFloorRange;
    if (pickupRange && pricing.stairs) {
      stairsPrice += pricing.stairs[mapFloorToGroup(pickupRange)] || 0;
    }
    if (dropoffRange && pricing.stairs) {
      stairsPrice += pricing.stairs[mapFloorToGroup(dropoffRange)] || 0;
    }
  }

  // Distance
  let distancePrice = 0;
  let distanceMiles = 0;
  if (formData.pickupLat && formData.dropoffLat) {
    distanceMiles = await getDrivingDistanceMiles(
      parseFloat(formData.pickupLat),
      parseFloat(formData.pickupLon),
      parseFloat(formData.dropoffLat),
      parseFloat(formData.dropoffLon)
    );

    if (distanceMiles >= 20) {
      const baseRate = (pricing.distance && pricing.distance['20-mile']) || 0;
      distancePrice = distanceMiles * (baseRate / 20);
    }
  }

  // Hours
  const hours = parseHours(formData.hours);

  // ─── NEW: Additional Services ───

  // Box supply (multiple sizes with quantities)
  let boxPrice = 0;
  if (formData.materialSupply === 'yes' && formData.boxQuantities && pricing.box_size) {
    const boxQty = formData.boxQuantities;
    for (const size of ['small', 'medium', 'large']) {
      if (boxQty[size]) {
        const qty = parseInt(boxQty[size], 10) || 0;
        const unitPrice = pricing.box_size[size] || 0;
        boxPrice += unitPrice * qty;
      }
    }
  }

  // Assembly / Dismantling (per item)
  let assemblyPrice = 0;
  if (formData.assemblyService === 'yes' && pricing.assembly) {
    const itemCount = parseInt(formData.assemblyItemCount || '1', 10);
    const unitPrice = pricing.assembly['per-item'] || pricing.assembly['dismantling'] || 25;
    assemblyPrice = unitPrice * itemCount;
  }

  // Disposal items (tiered pricing in groups of 5)
  let disposalPrice = 0;
  let disposalCount = 0;
  if (formData.disposalItems === 'yes' && pricing.disposal) {
    disposalCount = parseInt(formData.customDisposalCount || '1', 10);
    if (disposalCount > 0) {
      // Map count to tier key (groups of 5)
      const tierStart = Math.floor((disposalCount - 1) / 5) * 5 + 1;
      const tierEnd = tierStart + 4;
      const tierKey = `${tierStart}-${tierEnd}`;
      disposalPrice = pricing.disposal[tierKey] || 0;
    }
  }

  // Totals
  const hourlyRate = baseHourlyRate + vanPrice + helperPrice + stairsPrice + distancePrice + boxPrice + assemblyPrice + disposalPrice;
  const total = hourlyRate * hours;

  return {
    total: Math.round(total * 100) / 100,
    hourlyRate: Math.round(hourlyRate * 100) / 100,
    hours,
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    breakdown: {
      baseHourlyRate,
      vanPrice,
      helperPrice,
      stairsPrice,
      distancePrice: Math.round(distancePrice * 100) / 100,
      boxPrice,
      assemblyPrice,
      disposalPrice: Math.round(disposalPrice * 100) / 100
    }
  };
}

async function calculateCleaningQuote(formData) {
  const pricing = getPricingMap();

  // Cleaning type
  const cleaningTypePrice = (pricing.cleaning_type && pricing.cleaning_type[formData.cleaningType]) || 0;

  // Property type
  let propertyTypePrice = 0;
  let bedroomCount = 0;

  if (formData.flatType === 'studio') {
    propertyTypePrice = pricing.property_type?.studio || 0;
    bedroomCount = 0;
  } else if (formData.flatType === '1-bed') {
    propertyTypePrice = pricing.property_type?.['1-bed'] || 0;
    bedroomCount = 1;
  } else if (formData.flatType === '2-bed') {
    propertyTypePrice = pricing.property_type?.['2-bed'] || 0;
    bedroomCount = 2;
  } else if (formData.flatType === '3-bed') {
    propertyTypePrice = pricing.property_type?.['3-bed'] || 0;
    bedroomCount = 3;
  } else if (formData.flatType === 'other') {
    bedroomCount = parseInt(formData.customBedroomCount || '4', 10);
    const p1 = pricing.property_type?.['1-bed'] || 0;
    const p2 = pricing.property_type?.['2-bed'] || 0;
    const p3 = pricing.property_type?.['3-bed'] || 0;

    if (p1 > 0 && p2 > 0 && p3 > 0) {
      const increment1 = p2 - p1;
      const increment2 = p3 - p2;
      const avgIncrement = (increment1 + increment2) / 2;
      propertyTypePrice = p3 + (bedroomCount - 3) * avgIncrement;
    } else if (p3 > 0) {
      propertyTypePrice = p3 + (bedroomCount - 3) * 10;
    }
  }

  // Hours
  const hours = parseHours(formData.hours);

  // Travel fee (flat)
  const travelFee = pricing.travel_fee?.standard || 0;

  // Weekend surcharge
  let weekendSurcharge = 0;
  if (formData.cleaningDate) {
    const date = new Date(formData.cleaningDate + 'T00:00:00');
    const dayOfWeek = date.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      weekendSurcharge = pricing.weekend_rate?.surcharge || 0;
    }
  }

  const hourlyRate = cleaningTypePrice + propertyTypePrice;
  const total = (hourlyRate * hours) + travelFee + weekendSurcharge;

  return {
    total: Math.round(total * 100) / 100,
    hourlyRate: Math.round(hourlyRate * 100) / 100,
    hours,
    breakdown: {
      cleaningTypePrice,
      propertyTypePrice: Math.round(propertyTypePrice * 100) / 100,
      travelFee,
      weekendSurcharge
    }
  };
}

app.post('/api/quote/calculate', async (req, res) => {
  try {
    const { serviceType, formData } = req.body;
    if (serviceType !== 'removal') {
      return res.status(400).json({ error: 'Only removal quotes supported currently' });
    }
    const result = await calculateRemovalQuote(formData);
    res.json(applyCustomerDiscount(result));
  } catch (err) {
    console.error('Calculate error:', err);
    res.status(500).json({ error: 'Failed to calculate quote' });
  }
});

app.post('/api/quote/calculate-cleaning', async (req, res) => {
  try {
    const { serviceType, formData } = req.body;
    if (serviceType !== 'cleaning') {
      return res.status(400).json({ error: 'Only cleaning quotes supported' });
    }
    const result = await calculateCleaningQuote(formData);
    res.json(applyCustomerDiscount(result));
  } catch (err) {
    console.error('Calculate cleaning error:', err);
    res.status(500).json({ error: 'Failed to calculate quote' });
  }
});

app.post('/api/quote',
  rateLimit({
    windowMs: 60000,
    max: 10,
    keyGenerator: (req) => `quote-${req.ip}`,
    message: 'Too many quote requests from this device. Please try again in a minute.'
  }),
  async (req, res) => {
  try {
    const { serviceType, formData } = req.body;
    let calc;

    if (serviceType === 'removal') {
      calc = await calculateRemovalQuote(formData);
    } else if (serviceType === 'cleaning') {
      calc = await calculateCleaningQuote(formData);
    } else {
      return res.status(400).json({ error: 'Unsupported service type' });
    }

    calc = applyCustomerDiscount(calc);

    const quoteId = createQuote({
      serviceType,
      formData,
      calculatedPrice: calc.total,
      hourlyRate: calc.hourlyRate,
      hours: calc.hours,
      distanceMiles: calc.distanceMiles || null,
      customerName: formData.fullName || null,
      customerEmail: formData.email || null,
      customerPhone: formData.phone || null,
      additionalNotes: formData.additionalNotes || null
    });

    res.json({ success: true, quoteId, ...calc });
  } catch (err) {
    console.error('Quote submission error:', err);
    res.status(500).json({ error: 'Failed to submit quote' });
  }
});

app.post('/api/quote/pay',
  rateLimit({
    windowMs: 60000,
    max: 10,
    keyGenerator: (req) => `quote-pay-${req.ip}`,
    message: 'Too many payment requests from this device. Please try again in a minute.'
  }),
  async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const { serviceType, formData } = req.body;
    let calc;

    if (serviceType === 'removal') {
      calc = await calculateRemovalQuote(formData);
    } else if (serviceType === 'cleaning') {
      calc = await calculateCleaningQuote(formData);
    } else {
      return res.status(400).json({ error: 'Unsupported service type' });
    }

    calc = applyCustomerDiscount(calc);

    const quoteId = createQuote({
      serviceType,
      formData,
      calculatedPrice: calc.total,
      hourlyRate: calc.hourlyRate,
      hours: calc.hours,
      distanceMiles: calc.distanceMiles || null,
      customerName: formData.fullName || null,
      customerEmail: formData.email || null,
      customerPhone: formData.phone || null,
      additionalNotes: formData.additionalNotes || null
    });

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: serviceType === 'removal' ? 'House/Office Removal' : 'Cleaning Service',
            description: `Quote #${quoteId}`
          },
          unit_amount: Math.round(calc.total * 100) // pence
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/payment/success?session_id={CHECKOUT_SESSION_ID}&quote_id=${quoteId}`,
      cancel_url: `${req.protocol}://${req.get('host')}/payment/cancel?quote_id=${quoteId}`,
      metadata: {
        quote_id: String(quoteId),
        service_type: serviceType
      }
    });

    res.json({ success: true, quoteId, checkoutUrl: session.url, ...calc });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create payment session' });
  }
});

// Verify Stripe payment and update quote status
app.post('/api/quote/verify-payment', async (req, res) => {
  try {
    const { session_id, quote_id } = req.body;
    if (!session_id || !quote_id) {
      return res.status(400).json({ error: 'session_id and quote_id required' });
    }

    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    const quoteId = parseInt(quote_id, 10);

    if (session.metadata && parseInt(session.metadata.quote_id, 10) !== quoteId) {
      return res.status(400).json({ error: 'Quote ID mismatch' });
    }

    if (session.payment_status === 'paid') {
      updateQuoteStatus(quoteId, 'paid');
      res.json({ success: true, status: 'paid' });
    } else {
      res.json({ success: false, status: session.payment_status });
    }
  } catch (err) {
    console.error('Payment verification error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Admin-only: list quotes with pagination
app.get('/api/quotes', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const result = getQuotesPaginated(page, limit);
  res.json(result);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VSD Synergy server running on http://0.0.0.0:${PORT}`);
});
