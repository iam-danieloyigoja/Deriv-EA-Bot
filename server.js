'use strict';

// Read-only, authenticated same-origin bridge for the existing bot.js state.
// Never imports the Deriv API token and never sends trading commands.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'deriv_dashboard_session';
const SESSION_SECONDS = 6 * 60 * 60;
const COOKIE_SECRET = crypto.randomBytes(32);
const PASSWORD_SALT = crypto.randomBytes(16);
const MAX_BODY_BYTES = 2048;
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
};
const ROOT = path.resolve(__dirname);
const failures = new Map();

function sendJson(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendText(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(value);
}

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const row = cookies.find(c => c.trim().startsWith(`${name}=`));
  return row ? row.trim().slice(name.length + 1) : '';
}

function signature(text) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(text).digest('base64url');
}

function isAuthenticated(req) {
  const raw = cookieValue(req, COOKIE);
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0].length !== 20 || !/^\d{10,13}$/.test(parts[1])) return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + SESSION_SECONDS * 1000) return false;
  const expected = Buffer.from(signature(`${parts[0]}.${parts[1]}`));
  const actual = Buffer.from(parts[2]);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function secureCookie(req) {
  const isLocal = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '');
  // Railway terminates TLS at its proxy; production cookies are always Secure.
  return isLocal ? '' : '; Secure';
}

function sameOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!host || !origin) return false;
  try {
    const parsed = new URL(origin);
    const isLocal = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(host);
    return parsed.host === host && (parsed.protocol === 'https:' || (isLocal && parsed.protocol === 'http:'));
  } catch {
    return false;
  }
}

function safeNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function safeHistory(list, max) {
  if (!Array.isArray(list)) return [];
  return list.slice(-max).map(safeNumber).filter(n => n !== null);
}

function snapshot(state, config) {
  const simulation = config.DEMO_MODE === true;
  const connected = Boolean(state.ws && state.ws.readyState === 1);
  const value = {
    observedAt: new Date().toISOString(),
    testOnly: process.env.DASHBOARD_TEST_ONLY === 'true',
    accountType: simulation ? 'SIMULATION' : 'REAL - READ ONLY',
    balanceSource: process.env.DASHBOARD_TEST_ONLY === 'true' ? 'DERIV DEMO BALANCE (BOT REPORTED)' : simulation ? 'BOT-SIMULATED BALANCE' : 'BOT REPORTED BALANCE',
    tradeSource: process.env.DASHBOARD_TEST_ONLY === 'true' ? 'TRADING DISABLED' : simulation ? 'SIMULATED RESULTS' : 'BOT REPORTED RESULTS',
    connected,
    running: Boolean(connected && !state.stopped && process.env.DASHBOARD_TEST_ONLY !== 'true'),
    stopped: Boolean(state.stopped || process.env.DASHBOARD_TEST_ONLY === 'true'),
    instrument: typeof config.INSTRUMENT === 'string' ? config.INSTRUMENT : null,
    balance: safeNumber(state.balance),
    startBalance: safeNumber(state.startBalance),
    dailyPnl: safeNumber(state.dailyPnl),
    drawdown: safeNumber(state.startBalance) > 0 && Number.isFinite(state.lowestBalance)
      ? Math.max(0, (state.startBalance - state.lowestBalance) / state.startBalance * 100) : null,
    wins: Number.isSafeInteger(state.wins) ? state.wins : 0,
    losses: Number.isSafeInteger(state.losses) ? state.losses : 0,
    consecutiveLoss: Number.isSafeInteger(state.consecutiveLoss) ? state.consecutiveLoss : 0,
    trades: Number.isSafeInteger(state.trades) ? state.trades : 0,
    lastPrice: safeNumber(state.lastPrice),
    ticks: Array.isArray(state.ticks) ? state.ticks.length : 0,
    priceHistory: safeHistory(state.priceHistory, 80),
    equityHistory: safeHistory(state.equityHistory, 80),
    indicators: {
      rsi: safeNumber(state.indicators && state.indicators.rsi),
      stochRsi: safeNumber(state.indicators && state.indicators.stochRsi),
      emaSignal: ['up', 'down'].includes(state.indicators && state.indicators.emaSignal)
        ? state.indicators.emaSignal : null,
      macd: safeNumber(state.indicators && state.indicators.macd),
      squeeze: state.indicators && typeof state.indicators.squeeze === 'boolean' ? state.indicators.squeeze : null,
      spike: state.indicators && typeof state.indicators.spike === 'boolean' ? state.indicators.spike : null,
    },
    currentSignal: state.currentSignal ? {
      strategy: String(state.currentSignal.strategy || '').slice(0, 60),
      dir: ['up', 'down'].includes(state.currentSignal.dir) ? state.currentSignal.dir : 'unknown',
    } : null,
    baseStake: safeNumber(config.BASE_STAKE),
    maxDD: safeNumber(config.MAX_DAILY_DD),
    dailyTarget: safeNumber(config.DAILY_TARGET),
    recentTrades: (Array.isArray(state.recentTrades) ? state.recentTrades.slice(0, 12) : []).map(t => ({
      strategy: String(t.strategy || '—').slice(0, 70),
      dir: ['up', 'down'].includes(t.dir) ? t.dir : 'unknown',
      stake: safeNumber(t.stake),
      profit: safeNumber(t.profit),
    })),
  };
  // Never pass any other internal state through (token, account ID, OTP URL, WS, callbacks, logs).
  return value;
}

function createDashboardHandler({ state, config }) {
  if (!state || !config) throw new Error('createDashboardHandler requires state and config');
  const password = process.env.DASHBOARD_PASSWORD || '';
  const passwordConfigured = password.length >= 16;
  const targetHash = passwordConfigured ? crypto.scryptSync(password, PASSWORD_SALT, 64) : null;
  if (!passwordConfigured) {
    console.warn('DASHBOARD_PASSWORD must be set to at least 16 characters; dashboard login is disabled.');
  }

  return function dashboardHandler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch { return sendText(res, 400, 'Bad request'); }
    const isPost = req.method === 'POST';
    const isGet = req.method === 'GET';

    // Deny legacy unauthenticated endpoints, even if an old client tries them.
    if (pathname === '/api/control' || pathname === '/api/state') {
      return sendJson(res, 410, { error: 'Legacy API disabled. Use the authenticated dashboard endpoint.' });
    }
    if (pathname === '/api/dashboard/control') {
      return sendJson(res, 423, { error: 'Controls are locked. This integration is read-only.' });
    }
    if (pathname === '/health' && isGet) return sendJson(res, 200, { ok: true });
    if (pathname === '/api/dashboard/session' && isGet) {
      return sendJson(res, 200, { authenticated: passwordConfigured && isAuthenticated(req) });
    }
    if (pathname === '/api/dashboard/login' && isPost) {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origin rejected' });
      if (!passwordConfigured) return sendJson(res, 503, { error: 'Dashboard password is not configured' });
      const peer = req.socket.remoteAddress || 'unknown';
      const prior = failures.get(peer) || { count: 0, until: 0 };
      if (prior.until > Date.now()) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) req.destroy();
      });
      return req.on('end', () => {
        let supplied;
        try { supplied = JSON.parse(body).password; }
        catch { return sendJson(res, 400, { error: 'Invalid request' }); }
        if (typeof supplied !== 'string' || supplied.length > 1024) return sendJson(res, 400, { error: 'Invalid request' });
        const digest = crypto.scryptSync(supplied, PASSWORD_SALT, 64);
        if (!crypto.timingSafeEqual(digest, targetHash)) {
          const count = prior.count + 1;
          failures.set(peer, { count, until: count >= 6 ? Date.now() + 15 * 60 * 1000 : 0 });
          return sendJson(res, 401, { error: 'Invalid password' });
        }
        failures.delete(peer);
        const id = crypto.randomBytes(15).toString('base64url');
        const until = Date.now() + SESSION_SECONDS * 1000;
        const token = `${id}.${until}.${signature(`${id}.${until}`)}`;
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secureCookie(req)}`);
        sendJson(res, 200, { authenticated: true });
      });
    }
    if (pathname === '/api/dashboard/logout' && isPost) {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origin rejected' });
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie(req)}`);
      return sendJson(res, 200, { authenticated: false });
    }
    if (pathname === '/login' || pathname === '/login.js' || pathname === '/dashboard.css') {
      if (!isGet) return sendText(res, 405, 'Method not allowed');
      const [filename, mime] = FILES[pathname];
      res.setHeader('Content-Type', mime);
      return res.end(fs.readFileSync(path.join(ROOT, filename)));
    }
    if (!passwordConfigured || !isAuthenticated(req)) {
      if (pathname === '/api/dashboard/state') return sendJson(res, 401, { error: 'Sign in required' });
      if (isGet && (pathname === '/' || pathname === '/dashboard.js')) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return sendText(res, 404, 'Not found');
    }
    if (pathname === '/api/dashboard/state' && isGet) {
      return sendJson(res, 200, snapshot(state, config));
    }
    if (isGet && FILES[pathname]) {
      const [filename, mime] = FILES[pathname];
      res.setHeader('Content-Type', mime);
      return res.end(fs.readFileSync(path.join(ROOT, filename)));
    }
    return sendText(res, 404, 'Not found');
  };
}

module.exports = { createDashboardHandler, snapshot };
