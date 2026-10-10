'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = fs.readFileSync(path.join(__dirname,'../bot.js'),'utf8');
const server = fs.readFileSync(path.join(__dirname,'../dashboard/simulator-server.js'),'utf8');
const client = fs.readFileSync(path.join(__dirname,'../dashboard/simulator.js'),'utf8');

test('demo and live credentials are separated with explicit live gate', () => {
  assert.ok(bot.includes("DEMO_MODE ? process.env.DERIV_DEMO_API_TOKEN : process.env.DERIV_API_TOKEN"));
  assert.ok(bot.includes("LIVE_TRADING_ENABLED     : process.env.LIVE_TRADING_ENABLED === 'true'"));
  assert.ok(bot.includes("Live mode is locked. Set LIVE_TRADING_ENABLED=true only after explicit approval."));
  assert.ok(bot.includes("DERIV_API_TOKEN is required in live mode."));
  assert.doesNotMatch(bot,/pat_[A-Za-z0-9]{20,}/);
});

test('authorized real-account diagnostic exposes only account metadata needed for selection', () => {
  assert.ok(bot.includes("Authorized real Options accounts: "));
  assert.ok(bot.includes("accountIdOf(a)+' | balance:'"));
  assert.ok(bot.includes("' | currency:'"));
  assert.ok(bot.includes("' | status:'"));
});

test('live account selection refuses ambiguous real accounts', () => {
  assert.ok(bot.includes("DERIV_REAL_ACCOUNT_ID"));
  assert.ok(bot.includes("Multiple real accounts found. Set DERIV_REAL_ACCOUNT_ID before live trading."));
});

test('original signal rules remain present', () => {
  const anchors = [
    "if(sU&&R>65) return{dir:'down',strategy:'Spike Reversal'};",
    "if(sD&&R<35) return{dir:'up',  strategy:'Spike Reversal'};",
    "if(tr==='up'  &&p<=E8*1.001&&MH>0&&mc==='up')  return{dir:'up',  strategy:'EMA Pullback'};",
    "if(tr==='down'&&p>=E8*0.999&&MH<0&&mc==='down') return{dir:'down',strategy:'EMA Pullback'};",
    "if(SR<15&&R<35) return{dir:'up',  strategy:'Stoch RSI'};",
    "if(SR>85&&R>65) return{dir:'down',strategy:'Stoch RSI'};",
  ];
  anchors.forEach(anchor => assert.ok(bot.includes(anchor),anchor));
});

test('original martingale rule remains unchanged', () => {
  assert.ok(bot.includes("if(!CONFIG.MARTINGALE||S.consecutiveLoss<2) return CONFIG.BASE_STAKE;"));
  assert.ok(bot.includes("return Math.min(CONFIG.BASE_STAKE*Math.pow(CONFIG.MARTI_MULT,lv),S.balance*0.05);"));
});

test('daily reset keeps one timer and does not create duplicate tick subscriptions', () => {
  assert.ok(bot.includes('let dailyResetTimeout = null;'));
  assert.ok(bot.includes('let dailyResetCountdown = null;'));
  assert.ok(bot.includes('if(dailyResetCountdown){ clearInterval(dailyResetCountdown); dailyResetCountdown=null; }'));
  assert.ok(bot.includes('if(dailyResetTimeout){ clearTimeout(dailyResetTimeout); dailyResetTimeout=null; }'));
  const resetStart = bot.indexOf('function scheduleDailyReset(){');
  const resetEnd = bot.indexOf('// ─────────────────────────────────────────────────────────────\n//  REST HELPER', resetStart);
  const resetBody = bot.slice(resetStart, resetEnd);
  assert.doesNotMatch(resetBody,/subscribeTicks\(\)/);
});

test('pre-cooldown trade entry behavior is restored', () => {
  assert.ok(bot.includes('S.currentSignal=signal;\n  if(signal) placeTrade(signal);'));
  assert.doesNotMatch(bot,/ENTRY_RESET_TICKS/);
  assert.doesNotMatch(bot,/POST_SETTLEMENT_COOLDOWN_MS/);
  assert.doesNotMatch(bot,/entryArmed|neutralTicks|nextEntryAt|resetEntryGate/);
});

test('actual Boom Crash multiplier defaults respect Deriv minimums', () => {
  assert.ok(bot.includes("BASE_STAKE      : parseFloat(process.env.BASE_STAKE     || '1.00')"));
  assert.ok(bot.includes("MULTIPLIER      : parseInt(process.env.MULTIPLIER       || '100')"));
  assert.ok(bot.includes("BASE_STAKE must be at least $1.00"));
  assert.ok(bot.includes("MULTIPLIER must be at least 100"));
  assert.ok(bot.includes("stake < 1 || stake > 1000"));
  assert.ok(client.includes("data.baseStake.toFixed(2) : '1.00'"));
  const html = fs.readFileSync(path.join(__dirname,'../dashboard/simulator.html'),'utf8');
  assert.ok(html.includes('id="stake-input" type="number" min="1.00"'));
});

test('actual Boom Crash symbols use signal-directed multipliers with 5-tick market exit', () => {
  assert.ok(bot.includes("BOOM500:'BOOM500'"));
  assert.ok(bot.includes("BOOM1000:'BOOM1000'"));
  assert.ok(bot.includes("CRASH500:'CRASH500'"));
  assert.ok(bot.includes("CRASH1000:'CRASH1000'"));
  assert.doesNotMatch(bot,/BOOM500:'R_100'|BOOM1000:'R_75'|CRASH500:'R_50'|CRASH1000:'R_25'/);
  assert.ok(bot.includes("const contractType=signal.dir==='up'?'MULTUP':'MULTDOWN';"));
  assert.ok(bot.includes("multiplier:CONFIG.MULTIPLIER"));
  assert.ok(bot.includes("underlying_symbol:symbol"));
  assert.ok(bot.includes("send({buy:proposalId,price:askPrice}"));
  assert.ok(bot.includes("send({sell:contractId,price:0}"));
  assert.ok(bot.includes("S.tradeTicks>=CONFIG.MULTIPLIER_EXIT_TICKS"));
});


test('multiplier settlement logs entry exit and price telemetry', () => {
  assert.ok(bot.includes("activeTradeMeta:null"));
  assert.ok(bot.includes("proposalSpot=parseFloat(proposal.spot)"));
  assert.ok(bot.includes("entrySpot=parseFloat(c.entry_tick??c.entry_spot)"));
  assert.ok(bot.includes("exitSpot=parseFloat(c.exit_tick??c.exit_spot)"));
  assert.ok(bot.includes("'Trade telemetry | strategy:'"));
  assert.ok(bot.includes("' | buy_price:$'"));
  assert.ok(bot.includes("' | sell_price:$'"));
  assert.ok(bot.includes("' | pnl:$'"));
  assert.ok(bot.includes("CONFIG.MULTIPLIER_EXIT_TICKS+'-tick exit reached"));
});

test('real-contract preflight validates multiplier contracts without buying', () => {
  assert.ok(bot.includes("function validateContractOffering()"));
  assert.ok(bot.includes("if(CONFIG.DEMO_MODE&&!CONFIG.DEMO_CONTRACT_EXECUTION){ resolve(true); return; }"));
  assert.ok(bot.includes("contractTypes.includes('MULTUP')"));
  assert.ok(bot.includes("contractTypes.includes('MULTDOWN')"));
  assert.ok(bot.includes("Multiplier preflight passed: "));
  const start=bot.indexOf('function validateContractOffering(){');
  const end=bot.indexOf('function connectWebSocket',start);
  assert.doesNotMatch(bot.slice(start,end),/send\(\{buy:/);
});

test('multiplier execution preserves the original bidirectional signal rules', () => {
  assert.ok(bot.includes("if(sU&&R>65) return{dir:'down',strategy:'Spike Reversal'};"));
  assert.ok(bot.includes("if(sD&&R<35) return{dir:'up',  strategy:'Spike Reversal'};"));
  assert.ok(bot.includes("if(tr==='up'  &&p<=E8*1.001&&MH>0&&mc==='up')  return{dir:'up',  strategy:'EMA Pullback'};"));
  assert.ok(bot.includes("if(tr==='down'&&p>=E8*0.999&&MH<0&&mc==='down') return{dir:'down',strategy:'EMA Pullback'};"));
});

test('live trading uses a finite 100-trade batch counter', () => {
  assert.ok(bot.includes("LIVE_MAX_TRADES          : parseInt(process.env.LIVE_MAX_TRADES || '100')"));
  assert.ok(bot.includes("if(!CONFIG.DEMO_MODE) S.liveBatchTrades++;"));
  assert.ok(bot.includes("S.liveBatchTrades>=CONFIG.LIVE_MAX_TRADES"));
  assert.ok(bot.includes("Live batch limit reached: "));
});

test('live batch resets from RESET FORM and an instrument change', () => {
  assert.ok(bot.includes("cmd.action === 'reset-live-batch'"));
  assert.ok(bot.includes("resetLiveBatch('RESET FORM')"));
  assert.ok(bot.includes("resetLiveBatch('instrument changed to '+CONFIG.INSTRUMENT)"));
  assert.ok(server.includes("liveBatchTrades: Number.isSafeInteger(state.liveBatchTrades)"));
  assert.ok(server.includes("liveMaxTrades: Number.isSafeInteger(config.LIVE_MAX_TRADES)"));
  assert.ok(client.includes("postControl({action:'reset-live-batch'})"));
  assert.ok(client.includes("data.liveBatchTrades"));
  assert.ok(client.includes("data.liveMaxTrades"));
});

test('authenticated dashboard controls support explicit live mode', () => {
  assert.match(server,/sameOrigin\(req\)/);
  assert.match(server,/isAuthenticated\(req\)/);
  assert.match(server,/config\.LIVE_TRADING_ENABLED === true/);
  assert.match(server,/\/api\/dashboard\/control/);
});