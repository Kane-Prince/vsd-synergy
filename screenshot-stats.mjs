import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const url = process.argv[2];
const label = process.argv[3] || null;

if (!url) {
  console.error('Usage: node screenshot-stats.mjs <url> [label]');
  process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'temporary screenshots');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const existingFiles = fs.readdirSync(screenshotsDir).filter(f => f.startsWith('screenshot-') && f.endsWith('.png'));
let nextNum = 1;
if (existingFiles.length > 0) {
  const numbers = existingFiles
    .map(f => f.match(/screenshot-(\d+)/))
    .filter(m => m)
    .map(m => parseInt(m[1]));
  if (numbers.length > 0) {
    nextNum = Math.max(...numbers) + 1;
  }
}

const labelSuffix = label ? `-${label}` : '';
const filename = `screenshot-${nextNum}${labelSuffix}.png`;
const outputPath = path.join(screenshotsDir, filename);

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Scroll to stats section to trigger counter animation
    await page.evaluate(() => {
      const statsSection = document.querySelector('.stat-number');
      if (statsSection) statsSection.scrollIntoView({ block: 'center' });
    });

    // Wait for animation to complete (2s duration)
    await new Promise(r => setTimeout(r, 2500));

    await page.screenshot({
      path: outputPath,
      fullPage: true
    });

    await browser.close();

    console.log(`Screenshot saved to: ${outputPath}`);
  } catch (error) {
    console.error('Error taking screenshot:', error.message);
    process.exit(1);
  }
})();
