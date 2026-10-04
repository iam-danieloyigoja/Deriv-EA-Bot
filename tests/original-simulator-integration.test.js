'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = fs.readFileSync(path.join(__dirname,'../bot.js'),'utf8');
const server = fs.readFileSync(path.join(__dirname,'../dashboard/simulator-server.js'),'utf8');

test('simulator is hard-gated to isolated demo mode and demo token', () => {
  assert.match(bot,/SIMULATOR_ONLY/);
  assert.match(bot,/DASHBOARD_TEST_ONLY/);
  assert.match(bot,/CONFIG\.DEMO_MODE !== true/);
  assert.match(bot,/process\.env\.DERIV_DEMO_API_TOKEN/);
  assert.match(bot,/DERIV_API_TOKEN must not exist/);
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

test('original stake and simulator behavior remain present', () => {
  assert.ok(bot.includes("if(!CONFIG.MARTINGALE||S.consecutiveLoss<2) return CONFIG.BASE_STAKE;"));
  assert.ok(bot.includes("if(CONFIG.DEMO_MODE){simulateTrade(signal,stake);return;}"));
  assert.ok(bot.includes("const wP={'Spike Reversal':0.61,'EMA Pullback':0.57,'Stoch RSI':0.55}[signal.strategy]||0.57;"));
});

test('original live contract branch remains unchanged but is unreachable in simulator mode', () => {
  assert.ok(bot.includes("contract_type:signal.dir==='up'?'CALL':'PUT'"));
  assert.ok(bot.includes("duration:5,duration_unit:'t',basis:'stake',currency:'USD',"));
  assert.doesNotMatch(bot,/\bMULTUP\b|\bMULTDOWN\b|TEST_MULTIPLIER/);
});

test('app exposes authenticated same-origin simulator controls', () => {
  assert.match(server,/sameOrigin\(req\)/);
  assert.match(server,/isAuthenticated\(req\)/);
  assert.match(server,/SIMULATOR_ONLY === 'true'/);
  assert.match(server,/\/api\/dashboard\/control/);
  assert.match(server,/createSimulatorDashboardHandler/);
});
