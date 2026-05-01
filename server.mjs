import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getAdminByUsername,
  getAllPricing,
  getPricingMap,
  updatePricing,
  createQuote,
  getAllQuotes
} from './database.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;

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

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─── AUTH ROUTES ───

app.post('/api/auth/login', async (req, res) => {
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
    res.json({ authenticated: true, username: req.session.username });
  } else {
    res.json({ authenticated: false });
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

async function calculateRemovalQuote(formData) {
  const pricing = getPricingMap();

  // Van size
  const vanPrice = (pricing.van_size && pricing.van_size[formData.vanType]) || 0;

  // Helpers
  const helperPrice = (pricing.helpers && pricing.helpers[formData.helperType]) || 0;

  // Stairs
  let stairsPrice = 0;
  if (formData.verticalTransport === 'stairs') {
    const pickupRange = formData.pickupFloorRange;
    const dropoffRange = formData.dropoffFloorRange;
    if (pickupRange && pricing.stairs) {
      stairsPrice += pricing.stairs[pickupRange] || 0;
    }
    if (dropoffRange && pricing.stairs) {
      stairsPrice += pricing.stairs[dropoffRange] || 0;
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

  // Box supply
  let boxPrice = 0;
  if (formData.materialSupply === 'yes' && formData.boxSize && pricing.box_size) {
    boxPrice = pricing.box_size[formData.boxSize] || 0;
  }

  // Assembly / Dismantling
  let assemblyPrice = 0;
  if (formData.assemblyService && formData.assemblyService !== 'none' && pricing.assembly) {
    assemblyPrice = pricing.assembly[formData.assemblyService] || 0;
  }

  // Disposal items
  let disposalPrice = 0;
  let disposalCount = 0;
  if (formData.disposalItems && formData.disposalItems !== '0' && pricing.disposal) {
    const countStr = formData.disposalItems;
    if (countStr === 'custom') {
      disposalCount = parseInt(formData.customDisposalCount || '0', 10);
    } else {
      disposalCount = parseInt(countStr, 10);
    }

    if (disposalCount > 0) {
      if (disposalCount <= 4) {
        disposalPrice = pricing.disposal[String(disposalCount)] || 0;
      } else {
        // Extrapolate from 1-4 pricing
        const p1 = pricing.disposal['1'] || 0;
        const p4 = pricing.disposal['4'] || 0;
        if (p1 > 0 && p4 > 0) {
          const increment = (p4 - p1) / 3;
          disposalPrice = p4 + (disposalCount - 4) * increment;
        } else {
          disposalPrice = pricing.disposal['4'] || 0;
        }
      }
    }
  }

  // Totals
  const hourlyRate = vanPrice + helperPrice + stairsPrice + distancePrice + boxPrice + assemblyPrice + disposalPrice;
  const total = hourlyRate * hours;

  return {
    total: Math.round(total * 100) / 100,
    hourlyRate: Math.round(hourlyRate * 100) / 100,
    hours,
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    breakdown: {
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

app.post('/api/quote/calculate', async (req, res) => {
  try {
    const { serviceType, formData } = req.body;
    if (serviceType !== 'removal') {
      return res.status(400).json({ error: 'Only removal quotes supported currently' });
    }
    const result = await calculateRemovalQuote(formData);
    res.json(result);
  } catch (err) {
    console.error('Calculate error:', err);
    res.status(500).json({ error: 'Failed to calculate quote' });
  }
});

app.post('/api/quote', async (req, res) => {
  try {
    const { serviceType, formData } = req.body;
    if (serviceType !== 'removal') {
      return res.status(400).json({ error: 'Only removal quotes supported currently' });
    }

    const calc = await calculateRemovalQuote(formData);
    const quoteId = createQuote({
      serviceType,
      formData,
      calculatedPrice: calc.total,
      hourlyRate: calc.hourlyRate,
      hours: calc.hours,
      distanceMiles: calc.distanceMiles,
      customerName: formData.fullName || null,
      customerEmail: formData.email || null,
      customerPhone: formData.phone || null
    });

    res.json({ success: true, quoteId, ...calc });
  } catch (err) {
    console.error('Quote submission error:', err);
    res.status(500).json({ error: 'Failed to submit quote' });
  }
});

// Admin-only: list all quotes
app.get('/api/quotes', requireAuth, (req, res) => {
  const quotes = getAllQuotes();
  res.json(quotes);
});

// Start server
app.listen(PORT, () => {
  console.log(`VSD Synergy server running on http://localhost:${PORT}`);
});
