import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import { Resend } from 'resend';
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
  updateQuoteStatus,
  listPublishedArticles,
  listArticles,
  getArticleBySlug,
  getArticleById,
  slugExists,
  createArticle,
  updateArticle,
  deleteArticle,
  createMedia,
  getMedia,
  importStaticArticles
} from './database.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Public logo URL for email receipts (base64 images are blocked by most email clients)
const WEBSITE_URL = process.env.WEBSITE_URL || 'https://manandvanvsdsynergy.uk';
const LOGO_URL = `${WEBSITE_URL}/brand_assets/bp.jpeg`;

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SEO & PERFORMANCE MIDDLEWARE ───
// Remove X-Powered-By header
app.disable('x-powered-by');

const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

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

// Resend email setup
const resendApiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.FROM_EMAIL || 'noreply@manandvanvsdsynergy.uk';
const resend = resendApiKey ? new Resend(resendApiKey) : null;

async function sendEmail(to, subject, html) {
  if (!resend) {
    console.log('[EMAIL FALLBACK] To:', to, 'Subject:', subject);
    console.log('[EMAIL FALLBACK] Body:', html.replace(/\s+/g, ' ').substring(0, 500));
    return { fallback: true };
  }
  try {
    const { data, error } = await resend.emails.send({
      from: `VSD Synergy <${fromEmail}>`,
      to,
      subject,
      html
    });
    if (error) {
      console.error('Email send failed:', error.message);
      return { error: error.message };
    }
    console.log('Email sent:', data?.id);
    return { success: true, messageId: data?.id };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { error: err.message };
  }
}

// Send quote data to n8n webhook for workflow automation (email, CRM, etc.)
async function sendN8nWebhook(event, payload) {
  if (!N8N_WEBHOOK_URL) return { skipped: true };
  try {
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload })
    });
    if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
    return { success: true };
  } catch (err) {
    console.error('n8n webhook failed:', err.message);
    return { error: err.message };
  }
}

// Middleware
// 15MB so CMS image uploads (base64 in JSON) fit — file uploads are still
// capped at 10MB by the media endpoint itself
app.use(express.json({ limit: '15mb' }));
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

// ─── CMS: ARTICLE MANAGER ───
// Private article editor at /cms. Stores articles in SQLite so changes go live
// without a redeploy. The homepage article list and article pages are rendered
// server-side from the database (SEO still sees full HTML).

const CMS_PASSWORD = process.env.CMS_PASSWORD || 'vsd-cms';
const CANONICAL_BASE = process.env.WEBSITE_URL || 'https://www.manandvanvsdsynergy.uk';
if (!process.env.CMS_PASSWORD) {
  console.warn('[CMS] CMS_PASSWORD is not set — using the default password "vsd-cms". Set CMS_PASSWORD in your environment before going live.');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function requireCmsAuth(req, res, next) {
  if (req.session && req.session.cmsAuth) return next();
  res.status(401).json({ error: 'Not signed in. Please sign in again.' });
}

// Article page shell — mirrors the markup and styles of the original article files
function renderArticlePage(article) {
  const title = escapeHtml(article.title);
  const description = escapeHtml(article.description || '');
  const hero = article.hero_image_url
    ? `<figure class="mb-10">
        <img src="${escapeHtml(article.hero_image_url)}" alt="${title}" class="article-hero" loading="lazy">
      </figure>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | VSD Synergy</title>
  <link rel="canonical" href="${CANONICAL_BASE}/articles/${escapeHtml(article.slug)}">
  <meta name="description" content="${description}">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --font-roboto: 'Roboto', sans-serif;
      --font-lato: 'Lato', sans-serif;
      --brand-primary: #3080E8;
      --brand-primary-light: #5a9aef;
      --brand-primary-dark: #1e5fb8;
      --brand-primary-darker: #0f4080;
      --accent-coral: #FF6B35;
      --accent-coral-dark: #E55A2B;
    }
    body { font-family: var(--font-lato); color: #1f2937; }
    .type-h1 { font-family: var(--font-roboto); font-size: clamp(2rem, 4vw, 2.8rem); font-weight: 500; line-height: 1.2; letter-spacing: -0.02em; }
    .type-body { font-family: var(--font-lato); font-size: 1.0625rem; font-weight: 400; line-height: 1.75; }
    .nav-link { position: relative; color: #374151; font-weight: 500; }
    .nav-link:hover { color: var(--brand-primary); }
    .btn-primary {
      background: linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%);
      color: white; font-family: var(--font-lato); font-weight: 700;
      padding: 0.6rem 1.4rem; border-radius: 9999px;
      box-shadow: 0 4px 14px rgba(48, 128, 232, 0.3);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(48, 128, 232, 0.4); }
    .article-prose p { margin-bottom: 1.25rem; }
    .article-prose p:last-child { margin-bottom: 0; }
    .article-prose h2 { margin-top: 2.5rem; margin-bottom: 1rem; color: #111827; }
    .article-prose h3 { margin-top: 2rem; margin-bottom: 0.75rem; color: #111827; }
    .article-prose ul { margin: 1.25rem 0 1.5rem 1.5rem; list-style: disc; }
    .article-prose li { margin-bottom: 0.5rem; }
    .article-hero {
      width: 100%; height: auto; max-height: 460px; object-fit: cover;
      border-radius: 1rem; box-shadow: 0 18px 40px -12px rgba(15, 64, 128, 0.25);
    }
  </style>
</head>
<body class="bg-white">

  <header class="bg-white/95 backdrop-blur-md shadow-sm sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between items-center py-4">
        <a href="/" class="flex items-center gap-2">
          <span class="text-2xl font-bold" style="font-family: var(--font-roboto); color: var(--brand-primary);">VSD Synergy</span>
        </a>
        <nav class="hidden md:flex items-center space-x-7">
          <a href="/#services" class="nav-link">Services</a>
          <a href="/#articles" class="nav-link" style="color: var(--brand-primary);">Articles</a>
          <a href="/#contact" class="nav-link">Contact</a>
          <a href="/#quote" class="btn-primary">Get a Quote</a>
        </nav>
      </div>
    </div>
  </header>

  <div class="bg-gray-50 border-b border-gray-100">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
      <nav class="text-sm text-gray-500" style="font-family: var(--font-lato);">
        <a href="/" class="hover:text-blue-600">Home</a>
        <span class="mx-2">/</span>
        <a href="/#articles" class="hover:text-blue-600">Useful Articles</a>
        <span class="mx-2">/</span>
        <span class="text-gray-700">${title}</span>
      </nav>
    </div>
  </div>

  <article class="py-16">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">

      <header class="mb-10">
        <div class="flex items-center gap-3 mb-5">
          <span class="inline-block px-3 py-1 rounded-full text-xs font-bold tracking-widest uppercase" style="background: rgba(48, 128, 232, 0.1); color: var(--brand-primary);">Useful Articles</span>
          <span class="text-sm text-gray-500" style="font-family: var(--font-lato);">VSD Synergy</span>
        </div>
        <h1 class="type-h1 text-gray-900 mb-5">${title}</h1>
        ${article.description
          ? `<p class="type-body text-gray-600 text-lg">${description}</p>`
          : ''}
      </header>

      ${hero}

      <div class="article-prose type-body text-gray-800">
${article.body_html || ''}
      </div>

      <div class="mt-16 pt-8 border-t border-gray-200">
        <a href="/#articles" class="inline-flex items-center gap-2 font-semibold" style="color: var(--brand-primary); font-family: var(--font-lato);">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
          Back to all articles
        </a>
      </div>

      <aside class="mt-12 rounded-2xl p-8 text-white" style="background: linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%);">
        <h3 class="text-2xl font-bold mb-3" style="font-family: var(--font-lato);">Planning a move?</h3>
        <p class="mb-6 opacity-95" style="font-family: var(--font-lato);">Get a quick, transparent quote for your removal or cleaning.</p>
        <a href="/#quote" class="inline-block bg-white px-6 py-3 rounded-full font-bold" style="color: var(--brand-primary); font-family: var(--font-lato);">Get a Quote</a>
      </aside>
    </div>
  </article>

  <footer class="bg-gray-900 text-gray-300 py-10 mt-12">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center text-sm" style="font-family: var(--font-lato);">
      &copy; 2026 VSD Synergy Limited. All rights reserved.
    </div>
  </footer>

</body>
</html>`;
}

// Basic sanitisation for authored body HTML (single trusted admin, but keeps
// the site safe from pasted blobs that happen to contain scripts or trackers)
function sanitizeArticleBody(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(script|iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

function slugify(text) {
  return String(text || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
}

function validateArticleInput(body) {
  const title = String(body.title || '').trim();
  const slug = slugify(body.slug || body.title);
  if (!title) return { error: 'Title is required.' };
  if (!slug) return { error: 'URL slug is required.' };
  if (title.length > 200) return { error: 'Title is too long (max 200 characters).' };
  const description = String(body.description || '').trim().slice(0, 500);
  const heroImageUrl = String(body.heroImageUrl || '').trim().slice(0, 2000);
  const bodyHtml = sanitizeArticleBody(body.bodyHtml);
  return { title, slug, description, heroImageUrl, bodyHtml };
}

// ─── CMS routes: live pages rendered from the database ───

// Must be registered BEFORE express.static so it takes precedence over index.html
app.get('/', (req, res) => {
  try {
    const fsMod = fs;
    let html = fsMod.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const articles = listPublishedArticles();
    const rows = articles.map(a => `
            <li class="article-row">
              <a href="/articles/${escapeHtml(a.slug)}" class="article-link group">
                <span class="article-title">${escapeHtml(a.title)}</span>
                <span class="article-arrow">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                </span>
              </a>
            </li>`).join('');
    html = html.replace(/(<ul id="articlesList"[^>]*>)[\s\S]*?(<\/ul>)/, `$1${rows}\n          $2`);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.send(html);
  } catch (err) {
    console.error('Homepage render error:', err);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/articles/:slug', (req, res, next) => {
  const article = getArticleBySlug(req.params.slug);
  if (article && article.body_html) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(renderArticlePage(article));
  }
  // Fall back to the original static file if the DB has no body for this slug
  next();
});

app.get('/cms', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'cms', 'index.html'));
});

app.get('/media/:id', (req, res) => {
  const media = getMedia(parseInt(req.params.id, 10) || 0);
  if (!media) return res.status(404).send('Not found');
  res.setHeader('Content-Type', media.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(media.data));
});

// ─── CMS API (all require the CMS password via a signed-in session) ───
// (request bodies are already parsed by the global 15MB JSON parser above)

app.post('/api/cms/login', rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `login-cms-${req.ip}`,
  message: 'Too many sign-in attempts. Please try again in a few minutes.'
}), (req, res) => {
  const password = String(req.body.password || '');
  if (safeEqual(password, CMS_PASSWORD)) {
    req.session.cmsAuth = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Incorrect password.' });
});

app.post('/api/cms/logout', (req, res) => {
  req.session.cmsAuth = false;
  res.json({ success: true });
});

app.get('/api/cms/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.cmsAuth) });
});

app.get('/api/cms/articles', requireCmsAuth, (req, res) => {
  res.json({ articles: listArticles() });
});

app.get('/api/cms/articles/:id', requireCmsAuth, (req, res) => {
  const article = getArticleById(parseInt(req.params.id, 10) || 0);
  if (!article) return res.status(404).json({ error: 'Article not found.' });
  res.json({ article });
});

app.post('/api/cms/articles', requireCmsAuth, (req, res) => {
  const parsed = validateArticleInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (slugExists(parsed.slug)) return res.status(409).json({ error: 'That URL slug is already used by another article.' });
  const article = createArticle(parsed);
  res.status(201).json({ article, url: `/articles/${article.slug}` });
});

app.put('/api/cms/articles/:id', requireCmsAuth, (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const existing = getArticleById(id);
  if (!existing) return res.status(404).json({ error: 'Article not found.' });
  const parsed = validateArticleInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (slugExists(parsed.slug, id)) return res.status(409).json({ error: 'That URL slug is already used by another article.' });
  const article = updateArticle(id, parsed);
  res.json({ article, url: `/articles/${article.slug}` });
});

app.delete('/api/cms/articles/:id', requireCmsAuth, (req, res) => {
  const result = deleteArticle(parseInt(req.params.id, 10) || 0);
  res.json({ deleted: result.changes > 0 });
});

app.post('/api/cms/media', requireCmsAuth, (req, res) => {
  const dataUrl = String(req.body.dataUrl || '');
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return res.status(400).json({ error: 'Please upload a PNG, JPEG, WebP, GIF or AVIF image.' });
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image is larger than 10MB. Please upload a smaller file.' });
  }
  const id = createMedia({ filename: String(req.body.filename || 'image'), mime: match[1], data: buffer });
  res.status(201).json({ url: `/media/${id}` });
});

// One-time import of the existing static article files into the database.
// Position follows the current curated order shown on the homepage.
function seedArticles() {
  try {
    const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const listMatch = indexHtml.match(/<ul id="articlesList"[\s\S]*?<\/ul>/);
    const orderedSlugs = listMatch
      ? [...listMatch[0].matchAll(/\/articles\/([a-z0-9-]+)\.html/g)].map(m => m[1])
      : [];
    importStaticArticles(path.join(__dirname, 'public', 'articles'), orderedSlugs);
  } catch (err) {
    console.error('[ARTICLES] Seed import failed:', err.message);
  }
}
seedArticles();

// Static files with caching headers for performance
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

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

// Build a concise Stripe line-item description from form data
function buildStripeDescription(serviceType, formData, calc) {
  const parts = [];
  if (serviceType === 'removal') {
    parts.push(`${calc.hours} hour${calc.hours !== 1 ? 's' : ''}`);
    const vanLabels = { small: 'Small Van', medium: 'Medium Van', large: 'Large Van', luton: '3.5t Luton' };
    if (formData.vanType && vanLabels[formData.vanType]) parts.push(vanLabels[formData.vanType]);
    const helperLabels = { self: 'Customer loading', '1': 'Driver help', '2': '2 Men', '3': '3 Men' };
    if (formData.helperType && helperLabels[formData.helperType]) parts.push(helperLabels[formData.helperType]);
    if (formData.pickupAddress) parts.push(`Pickup: ${formData.pickupAddress}`);
    if (formData.dropoffAddress) parts.push(`Dropoff: ${formData.dropoffAddress}`);
  } else {
    parts.push(`${calc.hours} hour${calc.hours !== 1 ? 's' : ''}`);
    if (formData.cleaningType) parts.push(formData.cleaningType.replace(/-/g, ' '));
    if (formData.flatType) parts.push(formData.flatType);
  }
  return parts.join(' | ').substring(0, 500);
}

// Build HTML receipt for customer email
function buildReceiptHtml(quote, calc) {
  const formData = JSON.parse(quote.form_data || '{}');
  const isRemoval = quote.service_type === 'removal';
  const b = calc ? calc.breakdown : null;

  const formatDate = (str) => {
    if (!str) return 'N/A';
    const d = new Date(str + 'T00:00:00');
    return isNaN(d) ? str : d.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };

  const formatTime = (str) => {
    if (!str || !str.includes(':')) return str || 'N/A';
    const [h, m] = str.split(':').map(Number);
    const p = h >= 12 ? 'PM' : 'AM';
    const dh = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return `${dh}:${m.toString().padStart(2, '0')} ${p}`;
  };

  const formatFloorRange = (range) => {
    if (!range || range === 'ground') return 'Ground Floor';
    if (range === '1-2') return '1st - 2nd Floor';
    if (range === '3-5') return '3rd - 5th Floor';
    if (range === '6-10') return '6th - 10th Floor';
    return range;
  };

  let detailRows = '';
  const addRow = (label, value) => {
    detailRows += `<tr><td style="padding:10px 8px;border-bottom:1px solid #eee;font-weight:600;color:#334155;width:40%;">${label}</td><td style="padding:10px 8px;border-bottom:1px solid #eee;color:#334155;">${value}</td></tr>`;
  };

  if (isRemoval) {
    addRow('Pickup Address', formData.pickupAddress || 'N/A');
    addRow('Dropoff Address', formData.dropoffAddress || 'N/A');
  } else {
    addRow('Address', formData.houseAddress || 'N/A');
  }

  addRow('Service Date', formatDate(isRemoval ? formData.moveDate : formData.cleaningDate));
  addRow('Time Slot', formatTime(formData.selectedTimeSlot));
  addRow('Duration', `${formData.hours || calc?.hours || 'N/A'} hours`);

  if (isRemoval) {
    addRow('Van Size', formData.vanType || 'N/A');
    addRow('Helpers', formData.helperType || 'N/A');

    const vt = formData.verticalTransport;
    if (vt === 'lift') {
      addRow('Vertical Transport', 'Lift (No stairs)');
    } else if (vt === 'stairs') {
      let stairsText = 'Stairs';
      const sd = formData.stairsDetails;
      if (sd && typeof sd === 'object') {
        const parts = [];
        if (sd.pickup && sd.pickup.floorRange) parts.push(`Pickup: ${formatFloorRange(sd.pickup.floorRange)}`);
        if (sd.dropoff && sd.dropoff.floorRange) parts.push(`Dropoff: ${formatFloorRange(sd.dropoff.floorRange)}`);
        if (parts.length) stairsText += ` (${parts.join(', ')})`;
      }
      addRow('Vertical Transport', stairsText);
    } else {
      addRow('Vertical Transport', formData.verticalTransport || 'N/A');
    }

    if (formData.materialSupply === 'yes') {
      const box = formData.boxSize || {};
      const boxParts = [];
      if (box.small && parseInt(box.small, 10) > 0) boxParts.push(`${box.small} Small`);
      if (box.medium && parseInt(box.medium, 10) > 0) boxParts.push(`${box.medium} Medium`);
      if (box.large && parseInt(box.large, 10) > 0) boxParts.push(`${box.large} Large`);
      addRow('Box Supply', boxParts.length ? boxParts.join(', ') + ' Box(es)' : 'Yes');
    } else {
      addRow('Box Supply', 'None');
    }

    if (formData.assemblyService === 'yes') {
      const count = parseInt(formData.assemblyItemCount, 10) || 1;
      addRow('Dismantling / Assembling', `${count} Item${count > 1 ? 's' : ''}`);
    } else {
      addRow('Dismantling / Assembling', 'None');
    }

    if (formData.disposalItems === 'yes') {
      const count = parseInt(formData.customDisposalCount, 10) || 1;
      addRow('Disposal', `${count} Item${count > 1 ? 's' : ''}`);
    } else {
      addRow('Disposal', 'None');
    }

    if (formData.additionalNotes) {
      addRow('Additional Notes', formData.additionalNotes);
    }
  }

  addRow('Customer Name', quote.customer_name || formData.name || 'N/A');
  addRow('Email', quote.customer_email || formData.email || 'N/A');
  addRow('Phone', quote.customer_phone || formData.phone || 'N/A');

  let rows = '';
  if (b) {
    rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">Base Hourly Rate</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${(b.baseHourlyRate || 0).toFixed(2)}</td></tr>`;
    if ((b.vanPrice || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">+ Van Size</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${b.vanPrice.toFixed(2)}</td></tr>`;
    if ((b.helperPrice || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">+ Helpers</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${b.helperPrice.toFixed(2)}</td></tr>`;
    if ((b.stairsPrice || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">+ Stairs</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${b.stairsPrice.toFixed(2)}</td></tr>`;
    if ((b.distancePrice || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">+ Distance</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${b.distancePrice.toFixed(2)}</td></tr>`;
    if ((b.boxPrice || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">+ Box Supply</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${b.boxPrice.toFixed(2)}</td></tr>`;
    if ((b.assemblyPrice || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">+ Dismantling / Assembling</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${b.assemblyPrice.toFixed(2)}</td></tr>`;
    if ((b.disposalPrice || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">+ Disposal</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">£${b.disposalPrice.toFixed(2)}</td></tr>`;
    rows += `<tr><td style="padding:10px;border-bottom:2px solid #ddd;font-weight:700;">Time Cost (Base × ${calc.hours} hours)</td><td style="padding:10px;border-bottom:2px solid #ddd;text-align:right;font-weight:700;">£${(calc.timeCost || 0).toFixed(2)}</td></tr>`;
    if ((calc.flatExtras || 0) > 0) rows += `<tr><td style="padding:10px;border-bottom:2px solid #ddd;font-weight:700;">Flat Extras</td><td style="padding:10px;border-bottom:2px solid #ddd;text-align:right;font-weight:700;">£${calc.flatExtras.toFixed(2)}</td></tr>`;
  }

  let discountRow = '';
  if ((calc?.discountPercentage || 0) > 0) {
    discountRow = `<tr><td style="padding:10px;color:#16a34a;font-weight:600;">Promo Discount</td><td style="padding:10px;text-align:right;color:#16a34a;font-weight:700;">-${calc.discountPercentage}%</td></tr>`;
  }

  const total = calc ? calc.total : (quote.calculated_price || 0);
  const logoHtml = `<img src="${LOGO_URL}" alt="VSD Synergy" style="max-width:140px;height:auto;border-radius:8px;margin-bottom:12px;">`;

  return `<html><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#334155;background:#f8fafc;margin:0;padding:20px 0;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <!-- Header with Logo -->
      <div style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);padding:28px 24px;text-align:center;">
        ${logoHtml}
        <h2 style="color:#fff;margin:8px 0 0;font-size:22px;letter-spacing:-0.02em;">Booking Receipt</h2>
        <p style="color:rgba(255,255,255,0.75);margin:4px 0 0;font-size:14px;">VSD Synergy Limited</p>
      </div>

      <!-- Payment Confirmed Banner -->
      <div style="background:linear-gradient(90deg,#10b981 0%,#059669 100%);padding:14px 24px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:15px;font-weight:600;">Payment Confirmed</p>
      </div>

      <div style="padding:28px 24px;">
        <p style="margin:0 0 16px;font-size:15px;">Hi ${quote.customer_name || 'there'},</p>
        <p style="margin:0 0 24px;font-size:15px;color:#475569;">Thank you for your booking. Here is your receipt with full details:</p>

        <h3 style="color:#0f172a;font-size:16px;margin:0 0 12px;font-weight:700;">Booking Details</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
          <tr><td style="padding:10px 8px;border-bottom:1px solid #eee;font-weight:600;color:#334155;width:40%;">Reference</td><td style="padding:10px 8px;border-bottom:1px solid #eee;color:#334155;">#${quote.id}</td></tr>
          <tr><td style="padding:10px 8px;border-bottom:1px solid #eee;font-weight:600;color:#334155;width:40%;">Service</td><td style="padding:10px 8px;border-bottom:1px solid #eee;color:#334155;">${isRemoval ? 'House/Office Removal' : 'Cleaning Service'}</td></tr>
          ${detailRows}
        </table>

        <h3 style="color:#0f172a;font-size:16px;margin:0 0 12px;font-weight:700;">Price Breakdown</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
          ${rows}
          ${discountRow}
          <tr><td style="padding:12px 8px;font-size:18px;font-weight:700;background:#f1f5f9;color:#0f172a;">Total Paid</td><td style="padding:12px 8px;font-size:18px;font-weight:700;text-align:right;background:#f1f5f9;color:#0f172a;">£${total.toFixed(2)}</td></tr>
        </table>

        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <p style="margin:0 0 8px;font-size:13px;color:#64748b;">
            If you have any questions, contact us at <a href="mailto:info@vsdsynergy.com" style="color:#3080E8;text-decoration:none;">info@vsdsynergy.com</a> or call <strong>+44 2033557811</strong>.
          </p>
          <p style="margin:0;font-size:12px;color:#94a3b8;">VSD Synergy Limited · 33 Hungerdown Chingford, London, E4 6QJ</p>
        </div>
      </div>
    </div>
  </body></html>`;
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

  // Totals — base rate is multiplied by hours; everything else is a flat add-on
  const timeCost = baseHourlyRate * hours;
  const flatExtras = vanPrice + helperPrice + stairsPrice + distancePrice + boxPrice + assemblyPrice + disposalPrice;
  const total = timeCost + flatExtras;

  return {
    total: Math.round(total * 100) / 100,
    timeCost: Math.round(timeCost * 100) / 100,
    flatExtras: Math.round(flatExtras * 100) / 100,
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
      originalPrice: calc.originalTotal || calc.total,
      hourlyRate: calc.hourlyRate,
      hours: calc.hours,
      distanceMiles: calc.distanceMiles || null,
      customerName: formData.fullName || null,
      customerEmail: formData.email || null,
      customerPhone: formData.phone || null,
      additionalNotes: formData.additionalNotes || null,
      breakdown: calc.breakdown || null
    });

    const stripeDesc = buildStripeDescription(serviceType, formData, calc);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: serviceType === 'removal' ? 'House/Office Removal' : 'Cleaning Service',
            description: stripeDesc
          },
          unit_amount: Math.round(calc.total * 100)
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

      // Send receipt email to customer
      const quote = getQuoteById(quoteId);
      if (quote && quote.customer_email) {
        try {
          // Re-calculate breakdown for the email (pricing may have changed)
          const formData = JSON.parse(quote.form_data || '{}');
          let calc;
          if (quote.service_type === 'removal') {
            calc = await calculateRemovalQuote(formData);
          } else {
            calc = await calculateCleaningQuote(formData);
          }
          calc = applyCustomerDiscount(calc);

          const receiptHtml = buildReceiptHtml(quote, calc);
          const emailResult = await sendEmail(quote.customer_email, `Booking Receipt - VSD Synergy #${quoteId}`, receiptHtml);
          if (emailResult.success) {
            console.log(`Receipt email sent to ${quote.customer_email} for quote #${quoteId}`);
          } else {
            console.error(`Receipt email failed for quote #${quoteId}:`, emailResult.error);
          }

          // Also push to n8n webhook for workflow automation (CRM, Slack, custom email templates)
          const webhookPayload = {
            quote: {
              id: quote.id,
              service_type: quote.service_type,
              customer_name: quote.customer_name,
              customer_email: quote.customer_email,
              customer_phone: quote.customer_phone,
              calculated_price: quote.calculated_price,
              original_price: quote.original_price,
              hourly_rate: quote.hourly_rate,
              hours: quote.hours,
              distance_miles: quote.distance_miles,
              status: quote.status,
              created_at: quote.created_at
            },
            form_data: formData,
            breakdown: calc.breakdown || null,
            time_cost: calc.timeCost || null,
            flat_extras: calc.flatExtras || null,
            discount_percentage: calc.discountPercentage || 0,
            total: calc.total,
            original_total: calc.originalTotal || calc.total
          };
          const n8nResult = await sendN8nWebhook('payment.success', webhookPayload);
          if (n8nResult.success) console.log(`n8n webhook sent for quote #${quoteId}`);
        } catch (emailErr) {
          console.error('Failed to send receipt email:', emailErr.message);
        }
      }

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
