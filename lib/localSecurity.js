const crypto = require('crypto');

const SESSION_COOKIE = 'sticker_dashboard_session';

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_) {
      // Ignore malformed cookie values.
    }
  }
  return cookies;
}

function isLoopbackHostHeader(value) {
  const host = String(value || '').trim().toLowerCase();
  return /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host);
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function isDashboardOrigin(value, allowedOrigins) {
  const normalized = normalizeOrigin(value);
  return Boolean(normalized && allowedOrigins.has(normalized));
}

function isExtensionOrigin(value) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(String(value || '').toLowerCase());
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

// Extension routes: path → allowed method and request headers.
const EXTENSION_ROUTES = Object.freeze({
  '/api/ingest': { method: 'POST', headers: ['authorization', 'content-type'] },
  '/api/extension/heartbeat': { method: 'POST', headers: ['authorization', 'content-type'] },
  '/api/status': { method: 'GET', headers: ['authorization'] }
});

// ingestToken may be a string or a function, so pairing can change it at runtime.
function createLocalSecurity({ ingestToken, dashboardOrigins }) {
  const dashboardToken = crypto.randomBytes(32).toString('base64url');
  const origins = new Set(Array.from(dashboardOrigins || []).map((value) => String(value)));
  const currentIngestToken = typeof ingestToken === 'function' ? ingestToken : () => ingestToken;

  function validDashboardSession(req) {
    const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    return timingSafeStringEqual(token, dashboardToken);
  }

  function validExtensionBearer(req) {
    const token = currentIngestToken();
    return Boolean(token) && timingSafeStringEqual(bearerToken(req), token);
  }

  function setDashboardCookie(res) {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(dashboardToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`
    );
  }

  function originMiddleware(req, res, next) {
    if (!isLoopbackHostHeader(req.headers.host)) {
      return res.status(400).json({ error: 'Loopback Host header required.' });
    }

    const origin = req.headers.origin;
    if (!origin) {
      if (req.method === 'OPTIONS') return res.status(403).json({ error: 'Origin required.' });
      return next();
    }

    if (isDashboardOrigin(origin, origins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.status(204).end();
      }
      return next();
    }

    if (isExtensionOrigin(origin)) {
      if (req.method === 'OPTIONS') {
        const requestedMethod = String(req.headers['access-control-request-method'] || '').toUpperCase();
        const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        const route = Object.prototype.hasOwnProperty.call(EXTENSION_ROUTES, req.path)
          ? EXTENSION_ROUTES[req.path]
          : null;
        const validPreflight =
          route &&
          requestedMethod === route.method &&
          requestedHeaders.every((header) => route.headers.includes(header));
        if (!validPreflight) {
          return res.status(403).json({ error: 'Extension preflight rejected.' });
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', route.method);
        res.setHeader(
          'Access-Control-Allow-Headers',
          route.headers.map((header) => header === 'authorization' ? 'Authorization' : 'Content-Type').join(', ')
        );
        res.setHeader('Access-Control-Max-Age', '600');
        res.setHeader('Vary', 'Origin');
        return res.status(204).end();
      }

      const route = Object.prototype.hasOwnProperty.call(EXTENSION_ROUTES, req.path)
        ? EXTENSION_ROUTES[req.path]
        : null;
      if (route && req.method === route.method) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        return next();
      }
    }
    return res.status(403).json({ error: 'Origin rejected.' });
  }

  function requireDashboard(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !isDashboardOrigin(origin, origins)) {
      return res.status(403).json({ error: 'Dashboard origin rejected.' });
    }
    if (!validDashboardSession(req)) {
      return res.status(401).json({ error: 'Dashboard session required.' });
    }
    req.authActor = 'dashboard';
    return next();
  }

  function requireExtension(req, res, next) {
    if (!isExtensionOrigin(req.headers.origin)) {
      return res.status(403).json({ error: 'Chrome extension origin required.' });
    }
    if (!validExtensionBearer(req)) {
      return res.status(401).json(currentIngestToken()
        ? { error: 'Invalid or missing bearer token.', code: 'TOKEN_REJECTED' }
        : {
            error: 'Extension capture is disabled until the extension is connected in the dashboard (Health → Capture extension) or INGEST_TOKEN is set.',
            code: 'INGEST_DISABLED'
          });
    }
    req.authActor = 'extension';
    return next();
  }

  function authorizeWebSocket(request) {
    return (
      isLoopbackHostHeader(request.headers.host) &&
      isDashboardOrigin(request.headers.origin, origins) &&
      validDashboardSession(request)
    );
  }

  return {
    dashboardOrigins: origins,
    originMiddleware,
    requireDashboard,
    requireExtension,
    authorizeWebSocket,
    setDashboardCookie,
    validDashboardSession,
    validExtensionBearer
  };
}

module.exports = {
  SESSION_COOKIE,
  timingSafeStringEqual,
  parseCookies,
  isLoopbackHostHeader,
  normalizeOrigin,
  isDashboardOrigin,
  isExtensionOrigin,
  bearerToken,
  createLocalSecurity
};