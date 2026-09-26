'use strict';

const WebSocket = require('ws');
const https = require('node:https');
const http = require('node:http');
const { createDashboardHandler } = require('../dashboard/server');

if (process.env.STAGING_DASHBOARD_ONLY !== 'true') throw new Error('STAGING_DASHBOARD_ONLY=true is required.');
if (process.env.READ_ONLY_DEMO !== 'true') throw new Error('READ_ONLY_DEMO=true is required.');
if (process.env.SAFE_DEMO_CONTROLS !== 'true') throw new Error('SAFE_DEMO_CONTROLS=true is required.');
if (!process.env.DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD.length < 16) throw new Error('DASHBOARD_PASSWORD must be at least 16 characters.');
if (!process.env.DERIV_DEMO_API_TOKEN) throw new Error('DERIV_DEMO_API_TOKEN is required.');
if (!process.env.DERIV_APP_ID) throw new Error('DERIV_APP_ID is required.');
if (process.env.DERIV_API_TOKEN) throw new Error('DERIV_API_TOKEN must not exist in this isolated staging service.');

process.env.DASHBOARD_TEST_ONLY = 'true';
delete process.env.STAGING_FIXTURE_ONLY;

const TOKEN = process.env.DERIV_DEMO_API_TOKEN;
const APP_ID = process.env.DERIV_APP_ID;
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const ALLOWED_INSTRUMENTS = Object.freeze(['BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000']);

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const config = {
  DEMO_MODE: true,
  INSTRUMENT: ALLOWED_INSTRUMENTS.includes(process.env.INSTRUMENT) ? process.env.INSTRUMENT : 'BOOM500',
  BASE_STAKE: envNumber('BASE_STAKE', 0.35),
  MAX_DAILY_DD: envNumber('MAX_DAILY_DD', 10),
  DAILY_TARGET: envNumber('DAILY_TARGET', 15),
  ALLOWED_INSTRUMENTS,
};

const state = {
  ws: null,
  stopped: true,
  balance: null,
  startBalance: null,
  lowestBalance: Infinity,
  dailyPnl: 0,
  wins: 0,
  losses: 0,
  consecutiveLoss: 0,
  trades: 0,
  ticks: [],
  lastPrice: null,
  priceHistory: [],
  equityHistory: [],
  indicators: { rsi: null, stochRsi: null, emaSignal: null, macd: null, squeeze: null, spike: null },
  recentTrades: [],
  currentSignal: null,
  reqId: 1,
  pending: new Map(),
};

function apiRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.derivws.com',
      path,
      method,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        'Deriv-App-ID': APP_ID,
        Accept: 'application/json',
      },
      timeout: 15000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        let parsed;
        try { parsed = body ? JSON.parse(body) : {}; }
        catch { return reject(new Error('Invalid JSON from Deriv REST API')); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = parsed && parsed.errors && parsed.errors[0] && parsed.errors[0].message;
          return reject(new Error('Deriv REST error ' + res.statusCode + (message ? ': ' + message : '')));
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Deriv REST timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function getDemoAccount() {
  const result = await apiRequest('GET', '/trading/v1/options/accounts');
  const list = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
  const demo = list.find(a => a && a.account_type === 'demo');
  if (!demo || !demo.account_id) throw new Error('No Deriv demo Options account found. Real-account connection refused.');
  return demo.account_id;
}

async function getDemoWebSocketUrl(accountId) {
  const result = await apiRequest('POST', '/trading/v1/options/accounts/' + encodeURIComponent(accountId) + '/otp');
  const url = result && result.data && result.data.url;
  if (typeof url !== 'string' || !/\/trading\/v1\/options\/ws\/demo\?otp=/.test(url)) {
    throw new Error('Deriv did not return a demo WebSocket URL. Connection refused.');
  }
  return url;
}

function sendReadOnly(payload, callback) {
  const forbidden = ['buy', 'sell', 'proposal', 'proposal_open_contract', 'contract_update', 'cancel', 'auto_start', 'auto_stop'];
  if (forbidden.some(key => Object.prototype.hasOwnProperty.call(payload, key))) throw new Error('Blocked non-read-only Deriv request');

  const allowedPrimary = ['balance', 'ticks', 'active_symbols', 'ping'];
  if (!allowedPrimary.some(key => Object.prototype.hasOwnProperty.call(payload, key))) throw new Error('Blocked unapproved Deriv request');

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const reqId = state.reqId++;
  const message = { ...payload, req_id: reqId };
  if (callback) state.pending.set(reqId, callback);
  state.ws.send(JSON.stringify(message));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveSymbolFromList(list) {
  const wanted = normalize(config.INSTRUMENT);
  for (const item of Array.isArray(list) ? list : []) {
    const name = item.underlying_symbol_name || item.display_name || '';
    const symbol = item.underlying_symbol || item.symbol || '';
    if (symbol && (normalize(name).includes(wanted) || normalize(symbol) === wanted)) return symbol;
  }
  throw new Error('Unable to resolve ' + config.INSTRUMENT + ' from active symbols.');
}

function subscribeBalance() {
  sendReadOnly({ balance: 1, subscribe: 1 }, msg => {
    if (msg.error) throw new Error('Balance subscription rejected: ' + msg.error.message);
    onBalance(msg.balance);
  });
}

function resolveAndSubscribeTicks() {
  sendReadOnly({ active_symbols: 'brief' }, msg => {
    if (msg.error) throw new Error('Active-symbol request rejected: ' + msg.error.message);
    subscribeTicks(resolveSymbolFromList(msg.active_symbols));
  });
}

function subscribeTicks(symbol) {
  sendReadOnly({ ticks: symbol, subscribe: 1 }, msg => {
    if (msg.error) throw new Error('Tick subscription rejected: ' + msg.error.message);
    console.log('SAFE DEMO stream:', config.INSTRUMENT, '(' + symbol + ')');
  });
}

function onBalance(balance) {
  if (!balance) return;
  const value = Number(balance.balance);
  if (!Number.isFinite(value)) return;

  state.balance = value;
  if (!Number.isFinite(state.startBalance)) {
    state.startBalance = value;
    state.lowestBalance = value;
    state.equityHistory = [value];
  } else {
    state.lowestBalance = Math.min(state.lowestBalance, value);
    state.dailyPnl = value - state.startBalance;
    state.equityHistory.push(value);
    if (state.equityHistory.length > 80) state.equityHistory.shift();
  }
}

function onTick(tick) {
  if (!tick) return;
  const price = Number(tick.quote);
  if (!Number.isFinite(price)) return;

  state.lastPrice = price;
  state.ticks.push(price);
  state.priceHistory.push(price);
  if (state.ticks.length > 200) state.ticks.shift();
  if (state.priceHistory.length > 80) state.priceHistory.shift();

  if (state.stopped) {
    state.currentSignal = null;
    return;
  }
  if (state.ticks.length >= 30) state.currentSignal = analyze(state.ticks);
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch { return; }

  if (msg.req_id && state.pending.has(msg.req_id)) {
    const cb = state.pending.get(msg.req_id);
    state.pending.delete(msg.req_id);
    try { cb(msg); } catch (error) { console.error('SAFE DEMO request error:', error.message); }
    return;
  }

  if (msg.msg_type === 'balance') return onBalance(msg.balance);
  if (msg.msg_type === 'tick') return onTick(msg.tick);
  if (msg.error) console.error('SAFE DEMO stream error:', msg.error.message || msg.error.code || 'unknown');
}

function ema(p,n){if(p.length<n)return null;const k=2/(n+1);let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<p.length;i++)e=p[i]*k+e*(1-k);return e;}
function rsi(p,n=14){if(p.length<n+1)return 50;const ch=p.slice(1).map((v,i)=>v-p[i]),rc=ch.slice(-n),g=rc.filter(c=>c>0).reduce((a,b)=>a+b,0)/n,l=rc.filter(c=>c<0).map(c=>Math.abs(c)).reduce((a,b)=>a+b,0)/n;if(l===0)return 100;return 100-(100/(1+g/l));}
function bollinger(p,n=20,m=2){if(p.length<n)return{bw:0};const sl=p.slice(-n),mn=sl.reduce((a,b)=>a+b,0)/n,sd=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/n);return{bw:mn===0?0:(2*m*sd)/mn};}
function avgBW(p,n=20,m=2,lb=20){if(p.length<n+lb)return Infinity;let t=0;for(let i=0;i<lb;i++){const sl=p.slice(-(n+i),p.length-i||undefined);t+=bollinger(sl,n,m).bw;}return t/lb;}
function stochRSI(p,n=14){if(p.length<n*2)return null;const a=[];for(let i=n;i<=p.length;i++)a.push(rsi(p.slice(0,i),n));if(a.length<n)return null;const w=a.slice(-n),mn=Math.min(...w),mx=Math.max(...w);if(mx===mn)return 50;return((a[a.length-1]-mn)/(mx-mn))*100;}
function macdHisto(p){const ef=ema(p,12),es=ema(p,26);if(ef===null||es===null)return 0;return ef-es;}
function avgDiff(p){if(p.length<2)return 0;let s=0;for(let i=1;i<p.length;i++)s+=Math.abs(p[i]-p[i-1]);return s/(p.length-1);}

function analyze(prices) {
  const n=prices.length, ar=avgDiff(prices.slice(-30));
  const sU=prices[n-1]-prices[n-2]>ar*3, sD=prices[n-2]-prices[n-1]>ar*3;
  const R=rsi(prices,14), E8=ema(prices,8), E21=ema(prices,21);
  const E200=prices.length>=200?ema(prices,200):null;
  const bb=bollinger(prices,20,2), abw=avgBW(prices,20,2,20);
  const sq=bb.bw<abw*0.85, SR=stochRSI(prices,14), MH=macdHisto(prices), p=prices[n-1];

  state.indicators={rsi:R,stochRsi:SR===null?50:SR,emaSignal:E8&&E21?(E8>E21?'up':'down'):null,macd:MH,squeeze:sq,spike:sU||sD};

  if((sU||sD)&&sq){if(sU&&R>65)return{dir:'down',strategy:'Spike Reversal'};if(sD&&R<35)return{dir:'up',strategy:'Spike Reversal'};}
  if(E8&&E21){const tr=E8>E21?'up':'down',mc=E200?(p>E200?'up':'down'):tr;if(tr==='up'&&p<=E8*1.001&&MH>0&&mc==='up')return{dir:'up',strategy:'EMA Pullback'};if(tr==='down'&&p>=E8*0.999&&MH<0&&mc==='down')return{dir:'down',strategy:'EMA Pullback'};}
  if(SR!==null){if(SR<15&&R<35)return{dir:'up',strategy:'Stoch RSI'};if(SR>85&&R>65)return{dir:'down',strategy:'Stoch RSI'};}
  return null;
}

let reconnectTimer = null;
let reconnectAttempt = 0;
let connectionGeneration = 0;

function resetMarketState() {
  state.ticks = [];
  state.priceHistory = [];
  state.lastPrice = null;
  state.currentSignal = null;
  state.indicators = { rsi: null, stochRsi: null, emaSignal: null, macd: null, squeeze: null, spike: null };
}

function reconnectForInstrumentChange() {
  connectionGeneration += 1;
  clearTimeout(reconnectTimer);
  const ws = state.ws;
  state.ws = null;
  state.pending.clear();
  resetMarketState();

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.close(); } catch {}
  }
  setTimeout(connectDemoSafe, 150);
}

async function connectDemoSafe() {
  clearTimeout(reconnectTimer);
  const generation = ++connectionGeneration;

  try {
    const accountId = await getDemoAccount();
    const wsUrl = await getDemoWebSocketUrl(accountId);
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.on('open', () => {
      if (generation !== connectionGeneration) {
        try { ws.close(); } catch {}
        return;
      }
      reconnectAttempt = 0;
      console.log('DERIV DEMO SAFE CONTROLS connected; order execution is not implemented.');
      subscribeBalance();
      resolveAndSubscribeTicks();
    });

    ws.on('message', handleMessage);
    ws.on('error', error => console.error('SAFE DEMO WebSocket error:', error.message));
    ws.on('close', () => {
      if (generation !== connectionGeneration) return;
      state.ws = null;
      reconnectAttempt += 1;
      const delay = Math.min(5000 * reconnectAttempt, 30000);
      reconnectTimer = setTimeout(connectDemoSafe, delay);
    });
  } catch (error) {
    if (generation !== connectionGeneration) return;
    state.ws = null;
    reconnectAttempt += 1;
    console.error('SAFE DEMO connection failed:', error.message);
    reconnectTimer = setTimeout(connectDemoSafe, Math.min(5000 * reconnectAttempt, 30000));
  }
}

function controlError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function boundedNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw controlError(`${name} must be between ${min} and ${max}.`);
  }
  return number;
}

const controls = {
  async apply(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw controlError('Invalid control request.');

    if (body.action === 'start') {
      state.stopped = false;
      state.currentSignal = state.ticks.length >= 30 ? analyze(state.ticks) : null;
      return { monitoringActive: true, executionEnabled: false };
    }

    if (body.action === 'stop') {
      state.stopped = true;
      state.currentSignal = null;
      return { monitoringActive: false, executionEnabled: false };
    }

    if (body.action === 'update-config') {
      const instrument = String(body.instrument || '').toUpperCase();
      if (!ALLOWED_INSTRUMENTS.includes(instrument)) throw controlError('Unsupported demo instrument.');

      const baseStake = boundedNumber(body.baseStake, 'Stake', 0.35, 100);
      const maxDD = boundedNumber(body.maxDD, 'Drawdown limit', 1, 50);
      const dailyTarget = boundedNumber(body.dailyTarget, 'Target profit', 1, 100);

      const instrumentChanged = instrument !== config.INSTRUMENT;
      config.INSTRUMENT = instrument;
      config.BASE_STAKE = Math.round(baseStake * 100) / 100;
      config.MAX_DAILY_DD = Math.round(maxDD * 10) / 10;
      config.DAILY_TARGET = Math.round(dailyTarget * 10) / 10;

      if (instrumentChanged) reconnectForInstrumentChange();

      return {
        instrument: config.INSTRUMENT,
        baseStake: config.BASE_STAKE,
        maxDD: config.MAX_DAILY_DD,
        dailyTarget: config.DAILY_TARGET,
        executionEnabled: false,
      };
    }

    throw controlError('Unsupported demo control action.');
  },
};

http.createServer(createDashboardHandler({ state, config, controls }))
  .listen(port, '0.0.0.0', () => {
    console.log('DERIV DEMO SAFE CONTROLS dashboard listening on ' + port);
    console.log('Order execution disabled. Controls affect scanning and in-memory demo settings only.');
    connectDemoSafe();
  });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
