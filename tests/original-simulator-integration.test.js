'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = fs.readFileSync(path.join(__dirname,'../bot.js'),'utf8');
const server = fs.readFileSync(path.join(__dirname,'../dashboard/simulator-server.js'),'utf8');

test('demo and live credentials are separated with explicit live gate', () => {
  assert.ok(bot.includes("DEMO_MODE ? process.env.DERIV_DEMO_API_TOKEN : process.env.DERIV_API_TOKEN"));
  assert.ok(bot.includes("LIVE_TRADING_ENABLED     : process.env.LIVE_TRADING_ENABLED === 'true'"));
  assert.ok(bot.includes("Live mode is locked. Set LIVE_TRADING_ENABLED=true only after explicit approval."));
  assert.ok(bot.includes("DERIV_API_TOKEN is required in live mode."));
  assert.doesNotMatch(bot,/pat_[A-Za-z0-9]{20,}/);
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

test('settlement-aware entry gate remains active', () => {
  assert.ok(bot.includes('const ENTRY_RESET_TICKS = 3;'));
  assert.ok(bot.includes('const POST_SETTLEMENT_COOLDOWN_MS = 3000;'));
  assert.ok(bot.includes('if(S.neutralTicks>=ENTRY_RESET_TICKS) S.entryArmed=true;'));
  assert.ok(bot.includes('if(!S.entryArmed) return;'));
  assert.ok(bot.includes('if(Date.now()<S.nextEntryAt) return;'));
});

test('CALL PUT 5-tick proposal-buy execution and original map remain', () => {
  assert.ok(bot.includes("BOOM500:'R_100'"));
  assert.ok(bot.includes("BOOM1000:'R_75'"));
  assert.ok(bot.includes("CRASH500:'R_50'"));
  assert.ok(bot.includes("CRASH1000:'R_25'"));
  assert.ok(bot.includes("proposal:1,"));
  assert.ok(bot.includes("amount:stake,"));
  assert.ok(bot.includes("basis:'stake',"));
  assert.ok(bot.includes("contract_type:signal.dir==='up'?'CALL':'PUT'"));
  assert.ok(bot.includes("duration:5,"));
  assert.ok(bot.includes("duration_unit:'t',"));
  assert.ok(bot.includes("send({buy:proposalId,price:askPrice}"));
});

test('real-contract preflight applies to demo-contract and live modes', () => {
  assert.ok(bot.includes("function validateContractOffering()"));
  assert.ok(bot.includes("if(CONFIG.DEMO_MODE&&!CONFIG.DEMO_CONTRACT_EXECUTION){ resolve(true); return; }"));
  assert.ok(bot.includes("CALL/PUT not offered for "));
});

test('initial live acceptance run auto-pauses', () => {
  assert.ok(bot.includes("LIVE_MAX_TRADES          : parseInt(process.env.LIVE_MAX_TRADES || '3')"));
  assert.ok(bot.includes("if(!CONFIG.DEMO_MODE&&CONFIG.LIVE_MAX_TRADES>0&&S.trades>=CONFIG.LIVE_MAX_TRADES)"));
});

test('authenticated dashboard controls support explicit live mode', () => {
  assert.match(server,/sameOrigin\(req\)/);
  assert.match(server,/isAuthenticated\(req\)/);
  assert.match(server,/config\.LIVE_TRADING_ENABLED === true/);
  assert.match(server,/\/api\/dashboard\/control/);
});