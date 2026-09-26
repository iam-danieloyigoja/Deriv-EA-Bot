'use strict';
// Isolated OFFLINE staging entry point. NEVER import bot.js or any Deriv SDK.
// This process has no account, WebSocket, trading strategy, or order API.
if (process.env.STAGING_DASHBOARD_ONLY !== 'true') {
  throw new Error('Refusing to start: STAGING_DASHBOARD_ONLY=true is required.');
}
if (!process.env.DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD.length < 16) {
  throw new Error('Refusing to start: DASHBOARD_PASSWORD must be at least 16 characters.');
}
process.env.STAGING_FIXTURE_ONLY = 'true';
process.env.DASHBOARD_TEST_ONLY = 'true';
const http = require('node:http');
const { createDashboardHandler } = require('../dashboard/server');

// Deliberately blank fixture: NO Deriv balance, activity, market data, or credentials.
const state = Object.freeze({
  ws: null, stopped: true, balance: null, startBalance: null,
  lowestBalance: null, dailyPnl: null, wins: 0, losses: 0,
  consecutiveLoss: 0, trades: 0, lastPrice: null, ticks: [],
  priceHistory: [], equityHistory: [], indicators: {}, recentTrades: [],
  currentSignal: null,
});
const config = Object.freeze({ DEMO_MODE: true, INSTRUMENT: null });
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
http.createServer(createDashboardHandler({ state, config }))
  .listen(port, '0.0.0.0', () => {
    console.log(`OFFLINE staging dashboard only; no Deriv connection or trades; listening on ${port}`);
  });
