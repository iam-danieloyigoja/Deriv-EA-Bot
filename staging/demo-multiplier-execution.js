'use strict';

const WebSocket = require('ws');
const https = require('node:https');
const http = require('node:http');
const { createDashboardHandler } = require('../dashboard/server');
const {
  MAX_DEMO_TRADES,
  TEST_STAKE,
  TEST_MULTIPLIER,
  STOP_LOSS,
  TAKE_PROFIT,
  MAX_SESSION_LOSS,
  ALLOWED_INSTRUMENTS,
  assertDemoWebSocketUrl,
  normalizeTestStake,
  selectMultiplierContracts,
  buildMultiplierProposal,
  assertAllowedDemoRequest,
} = require('./demo-multiplier-execution-safety');

if (process.env.STAGING_DASHBOARD_ONLY !== 'true') throw new Error('STAGING_DASHBOARD_ONLY=true is required.');
if (process.env.SAFE_DEMO_CONTROLS !== 'true') throw new Error('SAFE_DEMO_CONTROLS=true is required.');
if (process.env.FINAL_DEMO_EXECUTION !== 'true') throw new Error('FINAL_DEMO_EXECUTION=true is required.');
if (process.env.MULTIPLIER_EXECUTION_TEST !== 'true') throw new Error('MULTIPLIER_EXECUTION_TEST=true is required.');
if (process.env.MULTIPLIER_PROBE_ONLY === 'true') throw new Error('MULTIPLIER_PROBE_ONLY must be false for execution acceptance.');
if (!process.env.DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD.length < 16) throw new Error('DASHBOARD_PASSWORD must be at least 16 characters.');
if (!process.env.DERIV_DEMO_API_TOKEN) throw new Error('DERIV_DEMO_API_TOKEN is required.');
if (!process.env.DERIV_APP_ID) throw new Error('DERIV_APP_ID is required.');
if (process.env.DERIV_API_TOKEN) throw new Error('DERIV_API_TOKEN must not exist in multiplier demo staging.');

process.env.DASHBOARD_TEST_ONLY = 'true';
delete process.env.STAGING_FIXTURE_ONLY;

const TOKEN = process.env.DERIV_DEMO_API_TOKEN;
const APP_ID = process.env.DERIV_APP_ID;
const port = Number(process.env.PORT || 8787);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const config = {
  DEMO_MODE: true,
  EXECUTION_ENABLED: true,
  INSTRUMENT: ALLOWED_INSTRUMENTS.includes(process.env.INSTRUMENT) ? process.env.INSTRUMENT : 'BOOM500',
  BASE_STAKE: normalizeTestStake(envNumber('BASE_STAKE', TEST_STAKE)),
  MAX_DAILY_DD: envNumber('MAX_DAILY_DD', 8),
  DAILY_TARGET: envNumber('DAILY_TARGET', 12),
  ALLOWED_INSTRUMENTS,
  MAX_DEMO_TRADES,
  MAX_TEST_STAKE: TEST_STAKE,
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
  inTrade: false,
  activeContractId: null,
  ticks: [],
  lastPrice: null,
  priceHistory: [],
  equityHistory: [],
  indicators: { rsi: null, stochRsi: null, emaSignal: null, macd: null, squeeze: null, spike: null },
  recentTrades: [],
  currentSignal: null,
  reqId: 1,
  pending: new Map(),
  settledContracts: new Set(),
  symbol: null,
  directionalContracts: { up: null, down: null },
  contractsReady: false,
  executionFault: null,
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
  const demo = list.find(account => account && account.account_type === 'demo');

  if (!demo || !demo.account_id) {
    throw new Error('No Deriv demo Options account found. Live-account fallback is forbidden.');
  }
  return demo.account_id;
}

async function getDemoWebSocketUrl(accountId) {
  const result = await apiRequest('POST', '/trading/v1/options/accounts/' + encodeURIComponent(accountId) + '/otp');
  return assertDemoWebSocketUrl(result && result.data && result.data.url);
}

function sendDemo(payload, callback) {
  assertAllowedDemoRequest(payload);

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Deriv demo WebSocket is not connected.');
  }

  const reqId = state.reqId++;
  if (callback) state.pending.set(reqId, callback);
  state.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
  return reqId;
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
  sendDemo({ balance: 1, subscribe: 1 }, msg => {
    if (msg.error) throw new Error('Balance subscription rejected: ' + msg.error.message);
    onBalance(msg.balance);
  });
}

function discoverMultiplierContracts(symbol) {
  state.contractsReady = false;
  state.directionalContracts = { up: null, down: null };

  sendDemo({ contracts_for: symbol }, msg => {
    if (msg.error) {
      state.executionFault = 'Contract capability discovery failed: ' + (msg.error.message || msg.error.code || 'unknown');
      state.stopped = true;
      console.error('MULTIPLIER DEMO capability discovery failed:', state.executionFault);
      return;
    }

    const available = msg && msg.contracts_for && msg.contracts_for.available;
    const selection = selectMultiplierContracts(available);

    const observed = selection.observed
      .map(item => [item.type, item.sentiment || '-', item.category || '-'].join('/'))
      .join(', ');

    console.log('MULTIPLIER DEMO contracts_for observed:', observed || 'none');

    if (selection.up !== 'MULTUP' || selection.down !== 'MULTDOWN') {
      state.executionFault =
        'Required MULTUP/MULTDOWN pair is not offered for ' + config.INSTRUMENT + ' on this demo account.';
      state.stopped = true;
      console.error('MULTIPLIER DEMO capability gate:', state.executionFault);
      return;
    }

    state.directionalContracts = { up: selection.up, down: selection.down };
    state.contractsReady = true;
    state.executionFault = null;

    console.log('MULTIPLIER DEMO directional contracts: UP=MULTUP DOWN=MULTDOWN');
  });
}

function resolveAndSubscribeTicks() {
  sendDemo({ active_symbols: 'brief' }, msg => {
    if (msg.error) throw new Error('Active-symbol request rejected: ' + msg.error.message);
    state.symbol = resolveSymbolFromList(msg.active_symbols);
    discoverMultiplierContracts(state.symbol);
    subscribeTicks(state.symbol);
  });
}

function subscribeTicks(symbol) {
  sendDemo({ ticks: symbol, subscribe: 1 }, msg => {
    if (msg.error) throw new Error('Tick subscription rejected: ' + msg.error.message);
    console.log('MULTIPLIER DEMO stream:', config.INSTRUMENT, '(' + symbol + ')');
  });
}

function subscribeActiveContract() {
  if (!state.activeContractId) return;
  try {
    sendDemo({
      proposal_open_contract: 1,
      contract_id: state.activeContractId,
      subscribe: 1,
    });
    console.log('MULTIPLIER DEMO monitoring contract:', state.activeContractId);
  } catch (error) {
    state.stopped = true;
    console.error('MULTIPLIER DEMO contract monitoring unavailable:', error.message);
  }
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
    state.equityHistory.push(value);
    if (state.equityHistory.length > 80) state.equityHistory.shift();
  }
}

function drawdownPct() {
  if (!Number.isFinite(state.startBalance) || state.startBalance <= 0 || !Number.isFinite(state.lowestBalance)) return 0;
  return Math.max(0, (state.startBalance - state.lowestBalance) / state.startBalance * 100);
}

function pnlPct() {
  if (!Number.isFinite(state.startBalance) || state.startBalance <= 0 || !Number.isFinite(state.balance)) return 0;
  return (state.balance - state.startBalance) / state.startBalance * 100;
}

function acceptanceShouldStop() {
  if (state.trades >= MAX_DEMO_TRADES) return 'Maximum demo trades completed.';
  if (state.dailyPnl <= -MAX_SESSION_LOSS) return 'Maximum multiplier demo test session loss reached.';
  if (drawdownPct() >= config.MAX_DAILY_DD) return 'Configured drawdown limit reached.';
  if (pnlPct() >= config.DAILY_TARGET) return 'Configured target reached.';
  return '';
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

  if (state.stopped || state.inTrade || state.trades >= MAX_DEMO_TRADES) {
    if (!state.inTrade) state.currentSignal = null;
    return;
  }

  const stopReason = acceptanceShouldStop();
  if (stopReason) {
    console.log('MULTIPLIER DEMO auto-paused:', stopReason);
    state.stopped = true;
    state.currentSignal = null;
    return;
  }

  if (state.ticks.length < 30) return;

  const signal = analyze(state.ticks);
  state.currentSignal = signal;
  if (signal) placeDemoTrade(signal);
}

function failTradeClosed(stage, message) {
  if (!state.activeContractId) state.inTrade = false;
  state.currentSignal = null;
  state.stopped = true;
  console.error(`MULTIPLIER DEMO ${stage} failed; scanner auto-paused: ${message}`);
}

function placeDemoTrade(signal) {
  if (state.stopped || state.inTrade || state.trades >= MAX_DEMO_TRADES) return;
  if (!state.symbol) return;

  const stopReason = acceptanceShouldStop();
  if (stopReason) {
    state.stopped = true;
    return;
  }

  if (!state.contractsReady) {
    failTradeClosed('capability gate', state.executionFault || 'Compatible multiplier contracts have not been discovered.');
    return;
  }

  const stake = normalizeTestStake(config.BASE_STAKE);
  const contractType = state.directionalContracts[signal.dir];

  if (!['MULTUP', 'MULTDOWN'].includes(contractType)) {
    failTradeClosed('capability gate', 'No compatible multiplier contract for signal direction ' + signal.dir + '.');
    return;
  }

  state.inTrade = true;
  state.currentSignal = signal;

  console.log(
    'MULTIPLIER DEMO signal:',
    signal.strategy,
    signal.dir.toUpperCase(),
    contractType,
    'stake', stake.toFixed(2),
    'x' + TEST_MULTIPLIER,
    'SL', STOP_LOSS.toFixed(2),
    'TP', TAKE_PROFIT.toFixed(2)
  );

  let proposalPayload;
  try {
    proposalPayload = buildMultiplierProposal({ symbol: state.symbol, contractType });
  } catch (error) {
    failTradeClosed('proposal construction', error.message);
    return;
  }

  try {
    sendDemo(proposalPayload, proposalMsg => {
      if (proposalMsg.error) {
        failTradeClosed('proposal', proposalMsg.error.message || proposalMsg.error.code || 'unknown');
        return;
      }

      const proposal = proposalMsg && proposalMsg.proposal;
      const proposalId = proposal && proposal.id;
      const askPrice = Number(proposal && proposal.ask_price);

      if (
        typeof proposalId !== 'string' ||
        !proposalId ||
        !Number.isFinite(askPrice) ||
        askPrice <= 0 ||
        askPrice > TEST_STAKE
      ) {
        failTradeClosed('proposal validation', 'Proposal was missing a safe proposal id/price.');
        return;
      }

      console.log(
        'MULTIPLIER DEMO proposal accepted:',
        proposalId,
        contractType,
        'x' + TEST_MULTIPLIER,
        'ask', askPrice.toFixed(2)
      );

      try {
        sendDemo({ buy: proposalId, price: askPrice }, buyMsg => {
          if (buyMsg.error) {
            failTradeClosed('buy', buyMsg.error.message || buyMsg.error.code || 'unknown');
            return;
          }

          const contractId = Number(buyMsg && buyMsg.buy && buyMsg.buy.contract_id);
          if (!Number.isSafeInteger(contractId) || contractId <= 0) {
            failTradeClosed('buy validation', 'Buy response missing a valid contract id.');
            return;
          }

          state.activeContractId = contractId;
          console.log(
            'MULTIPLIER DEMO contract opened:',
            contractId,
            contractType,
            'x' + TEST_MULTIPLIER,
            'stake', stake.toFixed(2)
          );

          subscribeActiveContract();
        });
      } catch (error) {
        failTradeClosed('buy', error.message);
      }
    });
  } catch (error) {
    failTradeClosed('proposal', error.message);
  }
}

function onContractUpdate(contract) {
  if (!contract) return;

  const id = Number(contract.contract_id);
  if (Number.isSafeInteger(id) && state.settledContracts.has(id)) return;

  const status = String(contract.status || '').toLowerCase();
  const isSold = Number(contract.is_sold) === 1;
  const settledStatus = ['sold', 'won', 'lost'].includes(status);

  if (!isSold && !settledStatus) return;

  let profit = Number(contract.profit);
  if (!Number.isFinite(profit)) {
    const sellPrice = Number(contract.sell_price);
    const buyPrice = Number(contract.buy_price);
    if (Number.isFinite(sellPrice) && Number.isFinite(buyPrice)) profit = sellPrice - buyPrice;
  }

  if (!Number.isFinite(profit)) {
    if (Number.isSafeInteger(id)) state.settledContracts.add(id);
    state.inTrade = false;
    state.activeContractId = null;
    state.currentSignal = null;
    state.stopped = true;
    console.error('MULTIPLIER DEMO settlement validation failed: settled contract has no finite profit value.');
    return;
  }

  if (Number.isSafeInteger(id)) state.settledContracts.add(id);

  const balanceAfter = Number(contract.balance_after);
  const won = profit > 0;
  const signal = state.currentSignal || { strategy: 'Unknown', dir: 'unknown' };

  state.trades += 1;
  state.dailyPnl = Math.round((state.dailyPnl + profit) * 100) / 100;

  if (Number.isFinite(balanceAfter)) state.balance = balanceAfter;
  if (Number.isFinite(state.balance)) {
    state.lowestBalance = Math.min(state.lowestBalance, state.balance);
    state.equityHistory.push(state.balance);
    if (state.equityHistory.length > 80) state.equityHistory.shift();
  }

  if (won) {
    state.wins += 1;
    state.consecutiveLoss = 0;
  } else {
    state.losses += 1;
    state.consecutiveLoss += 1;
  }

  state.recentTrades.unshift({
    strategy: signal.strategy || 'Unknown',
    dir: signal.dir || 'unknown',
    stake: TEST_STAKE,
    profit,
  });
  if (state.recentTrades.length > 12) state.recentTrades.pop();

  state.inTrade = false;
  state.activeContractId = null;
  state.currentSignal = null;

  console.log(
    'MULTIPLIER DEMO contract settled:',
    Number.isSafeInteger(id) ? id : 'unknown',
    status || 'sold',
    profit >= 0 ? '+' + profit.toFixed(2) : profit.toFixed(2),
    'session', state.dailyPnl >= 0 ? '+' + state.dailyPnl.toFixed(2) : state.dailyPnl.toFixed(2)
  );

  const stopReason = acceptanceShouldStop();
  if (stopReason) {
    state.stopped = true;
    console.log('MULTIPLIER DEMO auto-paused:', stopReason);
  }

  // If the WebSocket reconnected while this contract was open, market subscriptions
  // were intentionally withheld. Restore them after settlement while remaining paused.
  if (state.ws && state.ws.readyState === WebSocket.OPEN && !state.symbol) {
    try { resolveAndSubscribeTicks(); }
    catch (error) {
      state.stopped = true;
      console.error('MULTIPLIER DEMO market restore failed:', error.message);
    }
  }
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch { return; }

  if (msg.req_id && state.pending.has(msg.req_id)) {
    const cb = state.pending.get(msg.req_id);
    state.pending.delete(msg.req_id);
    try { cb(msg); } catch (error) { console.error('MULTIPLIER DEMO request error:', error.message); }
    return;
  }

  if (msg.msg_type === 'balance') return onBalance(msg.balance);
  if (msg.msg_type === 'tick') return onTick(msg.tick);
  if (msg.msg_type === 'proposal_open_contract') return onContractUpdate(msg.proposal_open_contract);

  if (msg.error) {
    console.error('MULTIPLIER DEMO stream error:', msg.error.message || msg.error.code || 'unknown');
    if (state.inTrade) state.stopped = true;
  }
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

  state.indicators={
    rsi:R,
    stochRsi:SR===null?50:SR,
    emaSignal:E8&&E21?(E8>E21?'up':'down'):null,
    macd:MH,
    squeeze:sq,
    spike:sU||sD
  };

  if((sU||sD)&&sq){
    if(sU&&R>65)return{dir:'down',strategy:'Spike Reversal'};
    if(sD&&R<35)return{dir:'up',strategy:'Spike Reversal'};
  }

  if(E8&&E21){
    const tr=E8>E21?'up':'down',mc=E200?(p>E200?'up':'down'):tr;
    if(tr==='up'&&p<=E8*1.001&&MH>0&&mc==='up')return{dir:'up',strategy:'EMA Pullback'};
    if(tr==='down'&&p>=E8*0.999&&MH<0&&mc==='down')return{dir:'down',strategy:'EMA Pullback'};
  }

  if(SR!==null){
    if(SR<15&&R<35)return{dir:'up',strategy:'Stoch RSI'};
    if(SR>85&&R>65)return{dir:'down',strategy:'Stoch RSI'};
  }

  return null;
}

let reconnectTimer = null;
let reconnectAttempt = 0;
let connectionGeneration = 0;

function resetMarketState() {
  state.ticks = [];
  state.priceHistory = [];
  state.lastPrice = null;
  state.symbol = null;
  state.directionalContracts = { up: null, down: null };
  state.contractsReady = false;
  state.executionFault = null;
  if (!state.inTrade) state.currentSignal = null;
  state.indicators = { rsi: null, stochRsi: null, emaSignal: null, macd: null, squeeze: null, spike: null };
}

function reconnectForInstrumentChange() {
  connectionGeneration += 1;
  clearTimeout(reconnectTimer);

  const ws = state.ws;
  state.ws = null;
  state.pending.clear();
  resetMarketState();
  state.stopped = true;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.close(); } catch {}
  }

  setTimeout(connectFinalDemo, 150);
}

async function connectFinalDemo() {
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
      console.log('DERIV MULTIPLIER DEMO connected; real-account execution is blocked.');
      subscribeBalance();

      if (state.inTrade && state.activeContractId) {
        state.stopped = true;
        subscribeActiveContract();
      } else {
        resolveAndSubscribeTicks();
      }
    });

    ws.on('message', handleMessage);
    ws.on('error', error => console.error('MULTIPLIER DEMO WebSocket error:', error.message));
    ws.on('close', () => {
      if (generation !== connectionGeneration) return;
      state.ws = null;

      if (state.inTrade) {
        console.error('MULTIPLIER DEMO disconnected while contract was open. Scanner remains paused; contract monitoring will resume after reconnect.');
        state.stopped = true;
      }

      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connectFinalDemo, Math.min(5000 * reconnectAttempt, 30000));
    });
  } catch (error) {
    if (generation !== connectionGeneration) return;
    state.ws = null;
    state.stopped = true;
    reconnectAttempt += 1;
    console.error('MULTIPLIER DEMO connection failed:', error.message);
    reconnectTimer = setTimeout(connectFinalDemo, Math.min(5000 * reconnectAttempt, 30000));
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
      if (state.inTrade) throw controlError('A demo multiplier contract is already open.');
      if (state.trades >= MAX_DEMO_TRADES) throw controlError('Final multiplier demo acceptance run is already complete.');
      if (state.executionFault) throw controlError(state.executionFault);
      if (!state.contractsReady) throw controlError('Multiplier contract capability discovery is not ready yet.');
      state.stopped = false;
      state.currentSignal = state.ticks.length >= 30 ? analyze(state.ticks) : null;
      return {
        monitoringActive: true,
        executionEnabled: true,
        stake: TEST_STAKE,
        multiplier: TEST_MULTIPLIER,
        stopLoss: STOP_LOSS,
        takeProfit: TAKE_PROFIT,
      };
    }

    if (body.action === 'stop') {
      if (state.inTrade) throw controlError('Cannot stop while a demo multiplier contract is open. It must settle first.');
      state.stopped = true;
      state.currentSignal = null;
      return { monitoringActive: false, executionEnabled: true };
    }

    if (body.action === 'update-config') {
      if (state.inTrade) throw controlError('Cannot change settings while a demo multiplier contract is open.');

      const instrument = String(body.instrument || '').toUpperCase();
      if (!ALLOWED_INSTRUMENTS.includes(instrument)) throw controlError('Unsupported demo instrument.');

      const baseStake = normalizeTestStake(body.baseStake);
      const maxDD = boundedNumber(body.maxDD, 'Drawdown limit', 1, 50);
      const dailyTarget = boundedNumber(body.dailyTarget, 'Target profit', 1, 100);

      const instrumentChanged = instrument !== config.INSTRUMENT;

      config.INSTRUMENT = instrument;
      config.BASE_STAKE = baseStake;
      config.MAX_DAILY_DD = Math.round(maxDD * 10) / 10;
      config.DAILY_TARGET = Math.round(dailyTarget * 10) / 10;

      if (instrumentChanged) reconnectForInstrumentChange();

      return {
        instrument: config.INSTRUMENT,
        baseStake: config.BASE_STAKE,
        maxDD: config.MAX_DAILY_DD,
        dailyTarget: config.DAILY_TARGET,
        executionEnabled: true,
        maxDemoTrades: MAX_DEMO_TRADES,
        multiplier: TEST_MULTIPLIER,
        stopLoss: STOP_LOSS,
        takeProfit: TAKE_PROFIT,
      };
    }

    throw controlError('Unsupported demo control action.');
  },
};

http.createServer(createDashboardHandler({ state, config, controls }))
  .listen(port, '0.0.0.0', () => {
    console.log('DERIV MULTIPLIER DEMO acceptance dashboard listening on ' + port);
    console.log(
      'Multiplier demo execution hard limits: max trades=' + MAX_DEMO_TRADES +
      ', stake=$' + TEST_STAKE.toFixed(2) +
      ', multiplier=x' + TEST_MULTIPLIER +
      ', SL=$' + STOP_LOSS.toFixed(2) +
      ', TP=$' + TAKE_PROFIT.toFixed(2) +
      ', max session loss=$' + MAX_SESSION_LOSS.toFixed(2)
    );
    console.log('Live-account execution is blocked. DERIV_API_TOKEN is forbidden in this service.');
    console.log('Scanner starts PAUSED. No martingale or recovery sizing is enabled.');
    connectFinalDemo();
  });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
