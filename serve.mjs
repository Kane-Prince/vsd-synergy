import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject'
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0]; // Remove query string
  let filePath;

  // Handle routing for all pages (from public/ dir)
  const publicDir = path.join(__dirname, 'public');
  if (urlPath === '/quote/removal' || urlPath === '/quote/removal/') {
    filePath = path.join(publicDir, 'quote', 'removal', 'index.html');
  } else if (urlPath === '/quote/cleaning' || urlPath === '/quote/cleaning/') {
    filePath = path.join(publicDir, 'quote', 'cleaning', 'index.html');
  } else if (urlPath === '/van-calculator' || urlPath === '/van-calculator/') {
    filePath = path.join(publicDir, 'van-calculator', 'index.html');
  } else if (urlPath === '/admin' || urlPath === '/admin/') {
    filePath = path.join(publicDir, 'admin', 'index.html');
  } else if (urlPath === '/driver' || urlPath === '/driver/') {
    filePath = path.join(publicDir, 'driver', 'index.html');
  } else if (urlPath === '/' || urlPath === '/index.html') {
    filePath = path.join(publicDir, 'index.html');
  } else {
    filePath = path.join(publicDir, urlPath);
  }

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
