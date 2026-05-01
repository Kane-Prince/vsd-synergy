import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const db = new Database('database.sqlite');

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
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed admin if none exists
function seedAdmin() {
  const existing = db.prepare('SELECT * FROM admins WHERE username = ?').get(process.env.ADMIN_USERNAME);
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(process.env.ADMIN_USERNAME, hash);
    console.log('Admin user seeded:', process.env.ADMIN_USERNAME);
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
    { category: 'disposal', option_key: '4', price: 50, label: '4 Items' }
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

seedAdmin();
seedPricing();

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

export function createQuote({ serviceType, formData, calculatedPrice, hourlyRate, hours, distanceMiles, customerName, customerEmail, customerPhone }) {
  const result = db.prepare(`
    INSERT INTO quotes (service_type, form_data, calculated_price, hourly_rate, hours, distance_miles, customer_name, customer_email, customer_phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(serviceType, JSON.stringify(formData), calculatedPrice, hourlyRate, hours, distanceMiles, customerName, customerEmail, customerPhone);
  return result.lastInsertRowid;
}

export function getAllQuotes() {
  return db.prepare('SELECT * FROM quotes ORDER BY created_at DESC').all();
}

export default db;
