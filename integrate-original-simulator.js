'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(process.argv[2] || 'bot.js');
const apply = process.argv.includes('--apply');

if (!fs.existsSync(target)) {
  console.error('Cannot find bot.js.');
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');

if (source.includes('createSimulatorDashboardHandler(')) {
  console.error('Original-strategy simulator integration appears to be applied already.');
  process.exit(1);
}

function once(oldText, replacement, name) {
  const start = source.indexOf(oldText);
  if (start < 0 || source.indexOf(oldText, start + oldText.length) >= 0) {
    throw new Error(`Cannot safely locate unique ${name} anchor. No changes made.`);
  }
  source = source.slice(0, start) + replacement + source.slice(start + oldText.length);
}

try {
  const original = source;

  once(
    "const { createDashboardHandler } = require('./dashboard/server');",
    "const { createSimulatorDashboardHandler } = require('./dashboard/simulator-server');",
    'dashboard require'
  );

  once(
    "DERIV_API_TOKEN : process.env.DERIV_API_TOKEN,",
    "DERIV_API_TOKEN : process.env.DERIV_DEMO_API_TOKEN,",
    'demo token source'
  );

  once(
`if (process.env.DASHBOARD_TEST_ONLY !== 'true' || CONFIG.DEMO_MODE !== true) {
  throw new Error('Integration package requires DASHBOARD_TEST_ONLY=true and DEMO_MODE=true on an isolated test service.');
}`,
`if (
  process.env.SIMULATOR_ONLY !== 'true' ||
  process.env.DASHBOARD_TEST_ONLY !== 'true' ||
  CONFIG.DEMO_MODE !== true
) {
  throw new Error('Simulator integration requires SIMULATOR_ONLY=true, DASHBOARD_TEST_ONLY=true and DEMO_MODE=true.');
}
if (process.env.DERIV_API_TOKEN) {
  throw new Error('DERIV_API_TOKEN must not exist on the isolated simulator service.');
}
CONFIG.ALLOWED_INSTRUMENTS = ['BOOM500','BOOM1000','CRASH500','CRASH1000'];`,
    'isolated simulator gate'
  );

  once(
    "stopped:false, ticks:[], inTrade:false,",
    "stopped:true, manualStop:true, ticks:[], inTrade:false,",
    'paused startup state'
  );

  once(
    "S.consecutiveLoss=0; S.stopped=false;",
    "S.consecutiveLoss=0; S.stopped=Boolean(S.manualStop);",
    'midnight manual-stop preservation'
  );

  once(
`const server = http.createServer(createDashboardHandler({ state: S, config: CONFIG }));`,
`function simulatorControlError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function reconnectSimulatorFeed() {
  const old = S.ws;
  S.ws = null;
  S.pendingCbs = {};
  S.ticks = [];
  S.priceHistory = [];
  S.lastPrice = 0;
  S.currentSignal = null;

  if (old) {
    try { old.removeAllListeners('close'); } catch {}
    try { old.close(); } catch {}
  }

  setTimeout(startBot, 150);
}

const simulatorControls = {
  async apply(cmd) {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      throw simulatorControlError('Invalid control request.');
    }

    if (cmd.action === 'start') {
      S.manualStop = false;
      S.stopped = false;
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) reconnectSimulatorFeed();
      log.info('Simulator started from app');
      return { running:true };
    }

    if (cmd.action === 'stop') {
      S.manualStop = true;
      S.stopped = true;
      S.currentSignal = null;
      log.stop('Simulator stopped from app');
      return { running:false, inTrade:Boolean(S.inTrade) };
    }

    if (cmd.action === 'update-config') {
      if (S.inTrade) throw simulatorControlError('Wait for the current simulated trade to finish before changing settings.');

      const instrument = String(cmd.instrument || '').toUpperCase();
      const stake = Number(cmd.baseStake);
      const maxDD = Number(cmd.maxDD);
      const target = Number(cmd.dailyTarget);

      if (!CONFIG.ALLOWED_INSTRUMENTS.includes(instrument)) throw simulatorControlError('Unsupported instrument.');
      if (!Number.isFinite(stake) || stake < 0.35 || stake > 1000) throw simulatorControlError('Stake must be between $0.35 and $1000.');
      if (!Number.isFinite(maxDD) || maxDD < 0.1 || maxDD > 50) throw simulatorControlError('DD limit must be between 0.1% and 50%.');
      if (!Number.isFinite(target) || target < 0.1 || target > 100) throw simulatorControlError('Target profit must be between 0.1% and 100%.');

      const instrumentChanged = instrument !== CONFIG.INSTRUMENT;
      CONFIG.INSTRUMENT = instrument;
      CONFIG.BASE_STAKE = parseFloat(stake.toFixed(2));
      CONFIG.MAX_DAILY_DD = parseFloat(maxDD.toFixed(1));
      CONFIG.DAILY_TARGET = parseFloat(target.toFixed(1));

      log.info(
        'Simulator settings updated: ' +
        CONFIG.INSTRUMENT + ' | stake $' + CONFIG.BASE_STAKE +
        ' | DD ' + CONFIG.MAX_DAILY_DD + '% | target +' + CONFIG.DAILY_TARGET + '%'
      );

      if (instrumentChanged) reconnectSimulatorFeed();

      return {
        instrument:CONFIG.INSTRUMENT,
        baseStake:CONFIG.BASE_STAKE,
        maxDD:CONFIG.MAX_DAILY_DD,
        dailyTarget:CONFIG.DAILY_TARGET,
      };
    }

    throw simulatorControlError('Unsupported simulator action.');
  },
};

const server = http.createServer(createSimulatorDashboardHandler({
  state:S,
  config:CONFIG,
  controls:simulatorControls,
}));`,
    'dashboard server'
  );

  once(
`function placeTrade(signal){
  // Test-mode safety guard: never simulate or submit a buy order.
  if (process.env.DASHBOARD_TEST_ONLY === 'true') return;`,
`function placeTrade(signal){`,
    'old monitor-only trade guard'
  );

  // Strategy and simulator integrity checks: refuse to apply if these anchors changed.
  const required = [
    "if(sU&&R>65) return{dir:'down',strategy:'Spike Reversal'};",
    "if(sD&&R<35) return{dir:'up',  strategy:'Spike Reversal'};",
    "if(tr==='up'  &&p<=E8*1.001&&MH>0&&mc==='up')  return{dir:'up',  strategy:'EMA Pullback'};",
    "if(tr==='down'&&p>=E8*0.999&&MH<0&&mc==='down') return{dir:'down',strategy:'EMA Pullback'};",
    "if(SR<15&&R<35) return{dir:'up',  strategy:'Stoch RSI'};",
    "if(SR>85&&R>65) return{dir:'down',strategy:'Stoch RSI'};",
    "if(!CONFIG.MARTINGALE||S.consecutiveLoss<2) return CONFIG.BASE_STAKE;",
    "if(CONFIG.DEMO_MODE){simulateTrade(signal,stake);return;}",
    "const wP={'Spike Reversal':0.61,'EMA Pullback':0.57,'Stoch RSI':0.55}[signal.strategy]||0.57;",
    "duration:5,duration_unit:'t',basis:'stake',currency:'USD',",
  ];

  for (const anchor of required) {
    if (!source.includes(anchor)) {
      throw new Error('Original strategy/simulator anchor changed; refusing integration: ' + anchor);
    }
  }

  if (/\bMULTUP\b|\bMULTDOWN\b|multiplier=x|TEST_MULTIPLIER/.test(source)) {
    throw new Error('Multiplier execution code detected in bot.js; refusing integration.');
  }

  if (source === original) throw new Error('No changes prepared.');

  console.log('Preflight passed: app controls wired to original bot simulator; strategy/simulator anchors preserved; live execution fail-closed.');

  if (!apply) {
    console.log('Dry run only. Use --apply after reviewing this package.');
    process.exit(0);
  }

  const temp = `${target}.simulator-new`;
  if (fs.existsSync(temp)) throw new Error('Temporary patch file already exists.');

  try {
    fs.writeFileSync(temp, source, {mode:0o600, flag:'wx'});
    fs.renameSync(temp, target);
  } catch (error) {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    throw error;
  }

  console.log('bot.js updated on this branch only.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
