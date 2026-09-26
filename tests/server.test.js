'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDashboardHandler, snapshot } = require('../dashboard/server');

const state = {
  ws: { readyState: 1 }, stopped: true, balance: 100, startBalance: 100,
  lowestBalance: 100, dailyPnl: 0, wins: 0, losses: 0, trades: 0,
  lastPrice: 123.45, ticks: [123.4, 123.45], priceHistory: [123.4, 123.45],
  equityHistory: [100], indicators: { rsi: 50, stochRsi: 55, emaSignal: 'up', macd: .02, squeeze: false, spike: false },
  recentTrades: [], accountId: 'DO_NOT_LEAK_ACCOUNT', pendingCbs: { DERIV_API_TOKEN: 'DO_NOT_LEAK_TOKEN' },
};
const config = { DEMO_MODE: true, INSTRUMENT: 'BOOM500', BASE_STAKE: .35, MAX_DAILY_DD: 10, DAILY_TARGET: 15, DERIV_API_TOKEN: 'DO_NOT_LEAK_TOKEN' };

function request(port, pathname, method = 'GET', payload = null, cookie = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { Host: `127.0.0.1:${port}`, ...(method === 'POST' ? { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
}

test('adapter: authenticated status, blocked legacy controls, demo test-only view', async () => {
  process.env.DASHBOARD_PASSWORD = 'Example-Strong-Local-Test-Password';
  process.env.DASHBOARD_TEST_ONLY = 'true';
  const server = http.createServer(createDashboardHandler({ state, config }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    let response = await request(port, '/api/dashboard/state');
    assert.equal(response.code, 401);
    response = await request(port, '/api/control', 'POST', { action: 'restart' });
    assert.equal(response.code, 410);
    response = await request(port, '/api/dashboard/control', 'POST', { action: 'restart' });
    assert.equal(response.code, 423);
    response = await request(port, '/api/dashboard/login', 'POST', { password: 'wrong' });
    assert.equal(response.code, 401);
    response = await request(port, '/api/dashboard/login', 'POST', { password: process.env.DASHBOARD_PASSWORD });
    assert.equal(response.code, 200);
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    assert.match(response.headers['set-cookie'][0], /HttpOnly/);
    assert.match(response.headers['set-cookie'][0], /SameSite=Strict/);
    response = await request(port, '/api/dashboard/state', 'GET', null, cookie);
    assert.equal(response.code, 200);
    const d = JSON.parse(response.body);
    assert.equal(d.testOnly, true);
    assert.equal(d.stopped, true);
    assert.equal(d.tradeSource, 'TRADING DISABLED');
    assert.equal(d.balance, 100);
    assert.equal(d.indicators.rsi, 50);
    assert.equal(d.priceHistory.length, 2);
    assert.ok(!response.body.includes('DO_NOT_LEAK_ACCOUNT'));
    assert.ok(!response.body.includes('DO_NOT_LEAK_TOKEN'));
    response = await request(port, '/');
    assert.equal(response.code, 302);
    response = await request(port, '/', 'GET', null, cookie);
    assert.equal(response.code, 200);
    assert.match(response.body, /DERIV EA BOT/);
    response = await request(port, '/api/dashboard/logout', 'POST', {}, cookie);
    assert.equal(response.code, 200);
    assert.match(response.headers['set-cookie'][0], /Max-Age=0/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.DASHBOARD_TEST_ONLY;
  }
});

test('snapshot excludes sensitive internal state and nonfinite numbers', () => {
  const data = snapshot({ ...state, balance: Infinity, priceHistory: [1, NaN, 3] }, config);
  assert.equal(data.balance, null);
  assert.deepEqual(data.priceHistory, [1, 3]);
  assert.equal(data.accountId, undefined);
  assert.equal(data.DERIV_API_TOKEN, undefined);
});
