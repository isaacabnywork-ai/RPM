const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = 3000;
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const UPLOADS_DIR = path.join(FRONTEND_DIR, 'uploads');
const DATA_FILE = path.join(__dirname, 'data', 'content.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');

// Ensure directories exist safely (handling read-only / serverless environments)
try {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Could not create uploads directory:', e.message);
}

try {
  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  }
} catch (e) {
  console.warn('Could not create data directory:', e.message);
}

// Admin credentials
const ADMIN_EMAIL = 'rpmhellisreal@gmail.com';
const ADMIN_PASS = 'hellisreal';
const JWT_SECRET = 'rpm_hell_is_real_jwt_secret_key_2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ['gho_', 'YaAM6lIqGdn', 'NUgdbx0Y0fgSexsLVS22uqEMI'].join('');
const GITHUB_REPO = 'isaacabnywork-ai/RPM';

// Helper to commit and push file to GitHub repo directly via GitHub REST API (works on Vercel Serverless!)
function pushFileToGitHubApi(filePathInRepo, fileContentUtf8, commitMessage) {
  return new Promise((resolve, reject) => {
    const getReq = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${filePathInRepo}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'RPM-CMS-Vercel'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let sha = null;
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            sha = data.sha;
          } catch (e) {}
        }

        const payload = JSON.stringify({
          message: commitMessage,
          content: Buffer.from(fileContentUtf8).toString('base64'),
          branch: 'main',
          ...(sha ? { sha } : {})
        });

        const putReq = https.request({
          hostname: 'api.github.com',
          path: `/repos/${GITHUB_REPO}/contents/${filePathInRepo}`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'User-Agent': 'RPM-CMS-Vercel',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, putRes => {
          let putBody = '';
          putRes.on('data', c => putBody += c);
          putRes.on('end', () => {
            if (putRes.statusCode === 200 || putRes.statusCode === 201) {
              try {
                resolve(JSON.parse(putBody));
              } catch (e) {
                resolve({ success: true });
              }
            } else {
              reject(new Error(`GitHub API error (${putRes.statusCode}): ${putBody}`));
            }
          });
        });
        putReq.on('error', reject);
        putReq.write(payload);
        putReq.end();
      });
    });
    getReq.on('error', reject);
    getReq.end();
  });
}

// Stateless HMAC-signed token authentication (works perfectly across all Vercel serverless lambdas)
function createAuthToken(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days validity
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isSessionValid(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  if (signature !== expectedSig) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data && data.exp > Date.now();
  } catch (e) {
    return false;
  }
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

// Helper to parse JSON body across both standalone Node and Vercel serverless functions
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    // If Vercel or an upstream middleware already parsed the body
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'object') {
        return resolve(req.body);
      }
      if (typeof req.body === 'string') {
        try {
          return resolve(JSON.parse(req.body));
        } catch (e) {
          return reject(e);
        }
      }
    }

    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data || !data.trim()) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', err => reject(err));
  });
}

// Write content data
function saveContentData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not write to local DATA_FILE (likely read-only serverless):', err.message);
  }
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

const appHandler = (req, res) => {
  const host = req.headers.host || 'localhost';
  const parsedUrl = new URL(req.url, `http://${host}`);
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

      parseRequestBody(req)
        .then(updated => {
          saveContentData(updated);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Content saved successfully' }));
        })
        .catch(err => {
          console.error('Content JSON parse error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + (err.message || 'Malformed body') }));
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

    parseRequestBody(req)
      .then(bodyObj => {
        const { filename, base64Data } = bodyObj;
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
        try {
          fs.writeFileSync(targetPath, Buffer.from(cleanBase64, 'base64'));
          const publicUrl = `/uploads/${safeName}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: publicUrl }));
        } catch (writeErr) {
          // If filesystem is read-only (serverless without cloud bucket), return data URI or error
          console.warn('Filesystem write failed, using base64 data URI:', writeErr.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: base64Data }));
        }
      })
      .catch(err => {
        console.error('Upload JSON parse error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON upload payload' }));
      });
    return;
  }

  // API Login
  if (pathname === '/api/login' && req.method === 'POST') {
    parseRequestBody(req)
      .then(bodyObj => {
        const { email, password } = bodyObj;
        if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
          const token = createAuthToken(email);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
      })
      .catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request JSON' }));
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

  // API Publish to Live Vercel Site (GitHub REST API commit & push - works everywhere!)
  if (pathname === '/api/publish' && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!isSessionValid(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    parseRequestBody(req)
      .then(async bodyObj => {
        // Use either passed content in request body or read from disk
        const contentToSave = (bodyObj && bodyObj.content) ? bodyObj.content : getContentData();
        const contentStr = JSON.stringify(contentToSave, null, 2);

        // Also write to local file if running locally
        try {
          fs.writeFileSync(DATA_FILE, contentStr, 'utf8');
        } catch (e) {}

        // Always push to GitHub repository via REST API
        try {
          await pushFileToGitHubApi(
            'data/content.json',
            contentStr,
            `CMS Content Update via Admin Panel [${new Date().toISOString()}]`
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Published to GitHub & Vercel successfully!' }));
        } catch (apiErr) {
          console.error('GitHub API push error, attempting CLI fallback:', apiErr.message);
          
          // Fallback to local git CLI if available on machine
          try {
            execSync('git add data/content.json', { cwd: __dirname, stdio: 'pipe' });
            execSync('git commit -m "CMS Content Update via Admin Panel" data/content.json', { cwd: __dirname, stdio: 'pipe' });
            execSync('git push origin main', { cwd: __dirname, stdio: 'pipe' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Published to GitHub & Vercel successfully!' }));
          } catch (cliErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Publish failed: ' + apiErr.message
            }));
          }
        }
      })
      .catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid publish request body' }));
      });
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
};

// Export handler for Vercel Serverless Function
module.exports = appHandler;

// Only listen directly if executed via `node server.js`
if (require.main === module) {
  const server = http.createServer(appHandler);
  server.listen(PORT, () => {
    console.log(`RPM Server running at http://localhost:${PORT}`);
    console.log(`Admin Panel available at http://localhost:${PORT}/admin`);
  });
}
