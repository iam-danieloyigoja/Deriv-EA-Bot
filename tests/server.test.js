'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDashboardHandler, snapshot } = require('../dashboard/server');

const state = {
  ws: { readyState: 1 }, stopped: true, inTrade: false, balance: 100, startBalance: 100,
  lowestBalance: 100, dailyPnl: 0, wins: 0, losses: 0, trades: 0,
  lastPrice: 123.45, ticks: [123.4, 123.45], priceHistory: [123.4, 123.45],
  equityHistory: [100], indicators: { rsi: 50, stochRsi: 55, emaSignal: 'up', macd: .02, squeeze: false, spike: false },
  recentTrades: [], accountId: 'DO_NOT_LEAK_ACCOUNT', pendingCbs: { DERIV_API_TOKEN: 'DO_NOT_LEAK_TOKEN' },
};

const config = {
  DEMO_MODE: true, EXECUTION_ENABLED: true, INSTRUMENT: 'BOOM500',
  BASE_STAKE: .35, MAX_DAILY_DD: 8, DAILY_TARGET: 12,
  ALLOWED_INSTRUMENTS: ['BOOM500', 'CRASH500'], MAX_DEMO_TRADES: 3, MAX_TEST_STAKE: .5,
  DERIV_API_TOKEN: 'DO_NOT_LEAK_TOKEN'
};

function request(port, pathname, method = 'GET', payload = null, cookie = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(method === 'POST' ? { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
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

async function login(port) {
  const response = await request(port, '/api/dashboard/login', 'POST', { password: process.env.DASHBOARD_PASSWORD });
  assert.equal(response.code, 200);
  return response.headers['set-cookie'][0].split(';')[0];
}

test('final demo controls are locked unless all test-only gates are present', async () => {
  process.env.DASHBOARD_PASSWORD = 'Example-Strong-Local-Test-Password';
  process.env.DASHBOARD_TEST_ONLY = 'true';
  process.env.SAFE_DEMO_CONTROLS = 'true';
  delete process.env.FINAL_DEMO_EXECUTION;

  const controls = { async apply() { return { ok: true }; } };
  const server = http.createServer(createDashboardHandler({ state, config, controls }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const cookie = await login(port);
    const response = await request(port, '/api/dashboard/control', 'POST', { action: 'start' }, cookie);
    assert.equal(response.code, 423);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.DASHBOARD_TEST_ONLY;
    delete process.env.SAFE_DEMO_CONTROLS;
  }
});

test('final demo snapshot exposes execution state but never sensitive internals', async () => {
  process.env.DASHBOARD_PASSWORD = 'Example-Strong-Local-Test-Password';
  process.env.DASHBOARD_TEST_ONLY = 'true';
  process.env.SAFE_DEMO_CONTROLS = 'true';
  process.env.FINAL_DEMO_EXECUTION = 'true';

  const calls = [];
  const controls = { async apply(body) { calls.push(body); return { accepted: true }; } };
  const server = http.createServer(createDashboardHandler({ state, config, controls }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const cookie = await login(port);

    let response = await request(port, '/api/dashboard/state', 'GET', null, cookie);
    assert.equal(response.code, 200);
    const d = JSON.parse(response.body);

    assert.equal(d.executionEnabled, true);
    assert.equal(d.controlsEnabled, true);
    assert.equal(d.maxDemoTrades, 3);
    assert.equal(d.maxTestStake, .5);
    assert.equal(d.accountType, 'DERIV DEMO - FINAL TEST');
    assert.equal(d.tradeSource, 'DERIV DEMO CONTRACTS');
    assert.ok(!response.body.includes('DO_NOT_LEAK_ACCOUNT'));
    assert.ok(!response.body.includes('DO_NOT_LEAK_TOKEN'));

    response = await request(port, '/api/dashboard/control', 'POST', { action: 'start' }, cookie);
    assert.equal(response.code, 200);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.DASHBOARD_TEST_ONLY;
    delete process.env.SAFE_DEMO_CONTROLS;
    delete process.env.FINAL_DEMO_EXECUTION;
  }
});

test('snapshot filters nonfinite values', () => {
  const data = snapshot({ ...state, balance: Infinity, priceHistory: [1, NaN, 3] }, config);
  assert.equal(data.balance, null);
  assert.deepEqual(data.priceHistory, [1, 3]);
  assert.equal(data.accountId, undefined);
  assert.equal(data.DERIV_API_TOKEN, undefined);
});
