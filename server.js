const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const UPLOADS_DIR = path.join(FRONTEND_DIR, 'uploads');
const DATA_FILE = path.join(__dirname, 'data', 'content.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Admin credentials
const ADMIN_EMAIL = 'rpmhellisreal@gmail.com';
const ADMIN_PASS = 'hellisreal';

// Session persistence across restarts and serverless requests
function getValidSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      const valid = {};
      for (const [token, expiry] of Object.entries(data)) {
        if (expiry > now) valid[token] = expiry;
      }
      return valid;
    }
  } catch (e) {
    console.error('Error reading sessions:', e);
  }
  return {};
}

function saveSession(token) {
  const sessions = getValidSessions();
  // 30 days session expiry
  sessions[token] = Date.now() + (30 * 24 * 60 * 60 * 1000);
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving session:', e);
  }
}

function isSessionValid(token) {
  if (!token) return false;
  const sessions = getValidSessions();
  return !!sessions[token];
}

// Read content data
function getContentData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading data file:', e);
  }
  return { siteSettings: {}, blogs: [], videos: [] };
}

// Write content data
function saveContentData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Endpoints
  if (pathname === '/api/content') {
    if (req.method === 'GET') {
      const data = getContentData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    } else if (req.method === 'POST') {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!isSessionValid(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const updated = JSON.parse(body);
          saveContentData(updated);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Content saved successfully' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }
  }

  // API Upload Image (Base64 file upload)
  if (pathname === '/api/upload' && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!isSessionValid(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { filename, base64Data } = JSON.parse(body);
        if (!base64Data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing base64Data' }));
          return;
        }

        const ext = path.extname(filename || 'image.png') || '.png';
        const safeName = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        const targetPath = path.join(UPLOADS_DIR, safeName);
        
        // Strip data:image/...;base64, prefix if present
        const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(targetPath, Buffer.from(cleanBase64, 'base64'));

        const publicUrl = `/uploads/${safeName}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: publicUrl }));
      } catch (e) {
        console.error('Upload error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process upload' }));
      }
    });
    return;
  }

  // API Login
  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
          const token = crypto.randomBytes(24).toString('hex');
          saveSession(token);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // API Check Auth
  if (pathname === '/api/check-auth' && req.method === 'GET') {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const isAuthed = isSessionValid(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: isAuthed }));
    return;
  }

  // Static File Serving
  let filePath = path.join(FRONTEND_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!path.extname(filePath)) {
    if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    } else if (pathname === '/admin') {
      filePath = path.join(FRONTEND_DIR, 'admin.html');
    }
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (pathname === '/admin' || pathname === '/admin/') {
        const adminPath = path.join(FRONTEND_DIR, 'admin.html');
        fs.readFile(adminPath, (aErr, aContent) => {
          if (!aErr) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(aContent);
            return;
          }
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`RPM Server running at http://localhost:${PORT}`);
  console.log(`Admin Panel available at http://localhost:${PORT}/admin`);
});
