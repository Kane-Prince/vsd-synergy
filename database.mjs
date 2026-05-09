import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

const db = new Database('database.sqlite');

// Enable WAL mode for better concurrent read/write performance
// WAL mode allows readers to not block writers and vice versa
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ─── AUTOMATED BACKUPS ───
const BACKUP_DIR = path.join(process.cwd(), 'database-backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupDatabase() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `database-${timestamp}.sqlite`);
  try {
    db.backup(backupPath).then(() => {
      console.log(`[BACKUP] Database backed up to ${backupPath}`);
      // Keep only last 30 backups to prevent disk bloat
      cleanupOldBackups(30);
    }).catch(err => {
      console.error('[BACKUP] Backup failed:', err.message);
    });
  } catch (err) {
    console.error('[BACKUP] Backup error:', err.message);
  }
}

function cleanupOldBackups(keepCount) {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('database-') && f.endsWith('.sqlite'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > keepCount) {
      const toDelete = files.slice(keepCount);
      for (const file of toDelete) {
        fs.unlinkSync(file.path);
        console.log(`[BACKUP] Removed old backup: ${file.name}`);
      }
    }
  } catch (err) {
    console.error('[BACKUP] Cleanup error:', err.message);
  }
}

// Run backup daily (every 24 hours)
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(backupDatabase, BACKUP_INTERVAL_MS);
// Also run one backup at startup
backupDatabase();

function generateDriverCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let exists = true;
  while (exists) {
    let suffix = '';
    for (let i = 0; i < 6; i++) {
      suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code = `VSD-${suffix}`;
    const row = db.prepare('SELECT id FROM drivers WHERE driver_code = ?').get(code);
    exists = !!row;
  }
  return code;
}

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pricing_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    option_key TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    label TEXT NOT NULL,
    UNIQUE(category, option_key)
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    form_data TEXT NOT NULL,
    calculated_price REAL,
    hourly_rate REAL,
    hours REAL,
    distance_miles REAL,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    additional_notes TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    driver_code TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS driver_interests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL,
    driver_id INTEGER NOT NULL,
    driver_email TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(quote_id, driver_id)
  );
`);

// Seed admin if none exists
function seedAdmin() {
  const existing = db.prepare('SELECT * FROM admins WHERE username = ?').get(process.env.ADMIN_USERNAME);
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
  if (!existing) {
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(process.env.ADMIN_USERNAME, hash);
    console.log('Admin user seeded:', process.env.ADMIN_USERNAME);
  } else {
    db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(hash, process.env.ADMIN_USERNAME);
    console.log('Admin password synced:', process.env.ADMIN_USERNAME);
  }
}

// Seed default pricing if none exists
function seedPricing() {
  const count = db.prepare('SELECT COUNT(*) as count FROM pricing_config').get();
  const isFresh = count.count === 0;

  const defaults = [
    // Van sizes
    { category: 'van_size', option_key: 'small', price: 30, label: 'Small Van' },
    { category: 'van_size', option_key: 'medium', price: 45, label: 'Medium Van' },
    { category: 'van_size', option_key: 'large', price: 60, label: 'Large Van' },
    { category: 'van_size', option_key: 'luton', price: 75, label: '3.5t Luton Van' },

    // Helpers
    { category: 'helpers', option_key: 'self', price: 0, label: 'Self Load' },
    { category: 'helpers', option_key: '1', price: 15, label: 'One Man' },
    { category: 'helpers', option_key: '2', price: 30, label: 'Two Men' },
    { category: 'helpers', option_key: '3', price: 45, label: 'Three Men' },
    { category: 'helpers', option_key: 'custom', price: 60, label: 'Custom (4+)' },

    // Stairs (per floor range)
    { category: 'stairs', option_key: 'ground-2', price: 10, label: 'Ground - 2nd Floor' },
    { category: 'stairs', option_key: '3-4', price: 20, label: '3rd - 4th Floor' },
    { category: 'stairs', option_key: '5-10', price: 35, label: '5th - 10th Floor' },

    // Distance base rate
    { category: 'distance', option_key: '20-mile', price: 20, label: 'Per 20 Mile Radius' },

    // Box sizes
    { category: 'box_size', option_key: 'small', price: 5, label: 'Small Box' },
    { category: 'box_size', option_key: 'medium', price: 8, label: 'Medium Box' },
    { category: 'box_size', option_key: 'large', price: 12, label: 'Large Box' },

    // Assembly / Dismantling
    { category: 'assembly', option_key: 'dismantling', price: 25, label: 'Dismantling Service' },
    { category: 'assembly', option_key: 'assembling', price: 25, label: 'Assembling Service' },

    // Disposal items (per count)
    { category: 'disposal', option_key: '1', price: 20, label: '1 Item' },
    { category: 'disposal', option_key: '2', price: 30, label: '2 Items' },
    { category: 'disposal', option_key: '3', price: 40, label: '3 Items' },
    { category: 'disposal', option_key: '4', price: 50, label: '4 Items' },

    // Cleaning service types
    { category: 'cleaning_type', option_key: 'end-of-tenancy', price: 25, label: 'End of Tenancy Cleaning' },
    { category: 'cleaning_type', option_key: 'routine', price: 15, label: 'Routine House Cleaning' },

    // Travel fee
    { category: 'travel_fee', option_key: 'standard', price: 50, label: 'Standard Travel Fee' },

    // Property type
    { category: 'property_type', option_key: 'studio', price: 10, label: 'Studio Flat' },
    { category: 'property_type', option_key: '1-bed', price: 15, label: '1 Bedroom Flat' },
    { category: 'property_type', option_key: '2-bed', price: 25, label: '2 Bedroom Flat' },
    { category: 'property_type', option_key: '3-bed', price: 35, label: '3 Bedroom Flat' },

    // Weekend rate
    { category: 'weekend_rate', option_key: 'surcharge', price: 20, label: 'Weekend Surcharge' }
  ];

  const insert = db.prepare('INSERT INTO pricing_config (category, option_key, price, label) VALUES (?, ?, ?, ?)');
  const check = db.prepare('SELECT id FROM pricing_config WHERE category = ? AND option_key = ?');

  if (isFresh) {
    const insertMany = db.transaction((items) => {
      for (const item of items) insert.run(item.category, item.option_key, item.price, item.label);
    });
    insertMany(defaults);
    console.log('Default pricing seeded.');
  } else {
    // Seed any missing categories
    let added = 0;
    for (const item of defaults) {
      const existing = check.get(item.category, item.option_key);
      if (!existing) {
        insert.run(item.category, item.option_key, item.price, item.label);
        added++;
      }
    }
    if (added > 0) console.log(`Added ${added} new pricing options.`);
  }
}

// Run migrations
function runMigrations() {
  // Add additional_notes column to quotes if missing
  const columns = db.prepare("PRAGMA table_info(quotes)").all();
  const hasNotes = columns.some(c => c.name === 'additional_notes');
  if (!hasNotes) {
    db.exec('ALTER TABLE quotes ADD COLUMN additional_notes TEXT');
    console.log('Migration: added additional_notes column to quotes');
  }

  // Create driver_interests table if missing
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='driver_interests'").get();
  if (!tables) {
    db.exec(`
      CREATE TABLE driver_interests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quote_id INTEGER NOT NULL,
        driver_id INTEGER NOT NULL,
        driver_email TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(quote_id, driver_id)
      )
    `);
    console.log('Migration: created driver_interests table');
  }

  // Add driver_code column to drivers if missing
  const driverColumns = db.prepare("PRAGMA table_info(drivers)").all();
  const hasDriverCode = driverColumns.some(c => c.name === 'driver_code');
  if (!hasDriverCode) {
    db.exec('ALTER TABLE drivers ADD COLUMN driver_code TEXT');
    console.log('Migration: added driver_code column to drivers');
    // Generate codes for existing drivers without one
    const driversWithoutCode = db.prepare("SELECT id FROM drivers WHERE driver_code IS NULL").all();
    for (const d of driversWithoutCode) {
      const code = generateDriverCode();
      db.prepare('UPDATE drivers SET driver_code = ? WHERE id = ?').run(code, d.id);
      console.log('Assigned driver code', code, 'to driver id', d.id);
    }
    // Add unique index separately
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_code ON drivers(driver_code)');
  }

  // Remove deprecated 7.5t Lorry pricing option if present
  const lorryRow = db.prepare("SELECT id FROM pricing_config WHERE category = 'van_size' AND option_key = 'lorry'").get();
  if (lorryRow) {
    db.prepare("DELETE FROM pricing_config WHERE category = 'van_size' AND option_key = 'lorry'").run();
    console.log('Migration: removed deprecated 7.5t Lorry pricing option');
  }
}

runMigrations();

// Create performance indexes for dashboards and lookups
// These indexes dramatically speed up listing quotes, driver interests, and lookups
// as the data grows into thousands of rows
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_quotes_created_at ON quotes(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
  CREATE INDEX IF NOT EXISTS idx_driver_interests_quote_id ON driver_interests(quote_id);
  CREATE INDEX IF NOT EXISTS idx_driver_interests_driver_id ON driver_interests(driver_id);
  CREATE INDEX IF NOT EXISTS idx_driver_interests_status ON driver_interests(status);
  CREATE INDEX IF NOT EXISTS idx_pricing_category ON pricing_config(category);
`);
console.log('[DB] Performance indexes ensured');

seedAdmin();
seedPricing();
seedDriver();
seedSettings();

function seedDriver() {
  const existing = db.prepare('SELECT * FROM drivers WHERE username = ?').get(process.env.DRIVER_USERNAME);
  const hash = bcrypt.hashSync(process.env.DRIVER_PASSWORD, 10);
  if (!existing) {
    const code = generateDriverCode();
    db.prepare('INSERT INTO drivers (username, password_hash, driver_code) VALUES (?, ?, ?)').run(process.env.DRIVER_USERNAME, hash, code);
    console.log('Driver user seeded:', process.env.DRIVER_USERNAME, 'Code:', code);
  } else {
    db.prepare('UPDATE drivers SET password_hash = ? WHERE username = ?').run(hash, process.env.DRIVER_USERNAME);
    console.log('Driver password synced:', process.env.DRIVER_USERNAME);
    if (!existing.driver_code) {
      const code = generateDriverCode();
      db.prepare('UPDATE drivers SET driver_code = ? WHERE id = ?').run(code, existing.id);
      console.log('Assigned driver code', code, 'to existing driver:', process.env.DRIVER_USERNAME);
    }
  }
}

function seedSettings() {
  const existing = db.prepare('SELECT * FROM settings WHERE key = ?').get('driver_commission_percentage');
  if (!existing) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('driver_commission_percentage', '30');
    console.log('Default driver commission percentage seeded: 30%');
  }

  const discountExists = db.prepare('SELECT * FROM settings WHERE key = ?').get('customer_discount_percentage');
  if (!discountExists) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('customer_discount_percentage', '0');
    console.log('Default customer discount percentage seeded: 0%');
  }
}

// Queries
export function getAdminByUsername(username) {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
}

export function getAllPricing() {
  return db.prepare('SELECT * FROM pricing_config ORDER BY category, id').all();
}

export function getPricingByCategory(category) {
  return db.prepare('SELECT * FROM pricing_config WHERE category = ?').all(category);
}

export function updatePricing(id, price) {
  return db.prepare('UPDATE pricing_config SET price = ? WHERE id = ?').run(price, id);
}

export function getPricingMap() {
  const rows = getAllPricing();
  const map = {};
  for (const row of rows) {
    if (!map[row.category]) map[row.category] = {};
    map[row.category][row.option_key] = row.price;
  }
  return map;
}

export function createQuote({ serviceType, formData, calculatedPrice, hourlyRate, hours, distanceMiles, customerName, customerEmail, customerPhone, additionalNotes }) {
  const result = db.prepare(`
    INSERT INTO quotes (service_type, form_data, calculated_price, hourly_rate, hours, distance_miles, customer_name, customer_email, customer_phone, additional_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(serviceType, JSON.stringify(formData), calculatedPrice, hourlyRate, hours, distanceMiles, customerName, customerEmail, customerPhone, additionalNotes || null);
  return result.lastInsertRowid;
}

export function getAllQuotes() {
  return db.prepare('SELECT * FROM quotes ORDER BY created_at DESC').all();
}

export function getQuotesPaginated(page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  const quotes = db.prepare('SELECT * FROM quotes ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  const countResult = db.prepare('SELECT COUNT(*) as total FROM quotes').get();
  return { quotes, total: countResult.total, page, limit };
}

export function getDriverByUsername(username) {
  return db.prepare('SELECT * FROM drivers WHERE username = ?').get(username);
}

export function getAllDrivers() {
  return db.prepare('SELECT id, username, driver_code, created_at FROM drivers ORDER BY created_at DESC').all();
}

export function createDriver(username, password) {
  const hash = bcrypt.hashSync(password, 10);
  const code = generateDriverCode();
  const result = db.prepare('INSERT INTO drivers (username, password_hash, driver_code) VALUES (?, ?, ?)').run(username, hash, code);
  return { id: result.lastInsertRowid, username, driver_code: code };
}

export function getSetting(key) {
  return db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
}

export function updateSetting(key, value) {
  return db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

// Driver interests
export function createDriverInterest(quoteId, driverId, driverEmail) {
  return db.prepare(`
    INSERT INTO driver_interests (quote_id, driver_id, driver_email)
    VALUES (?, ?, ?)
  `).run(quoteId, driverId, driverEmail);
}

export function getDriverInterestsByDriver(driverId) {
  return db.prepare(`
    SELECT di.*, q.service_type, q.customer_name, q.calculated_price, q.form_data, q.created_at as quote_created_at
    FROM driver_interests di
    JOIN quotes q ON di.quote_id = q.id
    WHERE di.driver_id = ?
    ORDER BY di.created_at DESC
  `).all(driverId);
}

export function getPendingInterestsForAdmin() {
  return db.prepare(`
    SELECT di.*, q.service_type, q.customer_name, q.customer_email, q.customer_phone, q.calculated_price, q.form_data, q.created_at as quote_created_at,
           d.username as driver_username, d.driver_code
    FROM driver_interests di
    JOIN quotes q ON di.quote_id = q.id
    JOIN drivers d ON di.driver_id = d.id
    ORDER BY di.created_at DESC
  `).all();
}

export function getInterestById(id) {
  return db.prepare(`
    SELECT di.*, q.service_type, q.customer_name, q.customer_email, q.customer_phone, q.calculated_price, q.form_data, q.created_at as quote_created_at,
           d.username as driver_username, d.driver_code
    FROM driver_interests di
    JOIN quotes q ON di.quote_id = q.id
    JOIN drivers d ON di.driver_id = d.id
    WHERE di.id = ?
  `).get(id);
}

export function updateInterestStatus(id, status) {
  return db.prepare(`UPDATE driver_interests SET status = ? WHERE id = ?`).run(status, id);
}

export function getQuoteIdsWithInterests() {
  return db.prepare(`SELECT DISTINCT quote_id FROM driver_interests`).all();
}

export function getQuoteById(id) {
  return db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
}

export function updateQuoteStatus(id, status) {
  return db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, id);
}

export default db;
