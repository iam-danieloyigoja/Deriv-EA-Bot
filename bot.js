/**
 * ============================================================
 *  DERIV BOOM & CRASH EA BOT — FRESH BUILD
 *  Strategies: Spike Reversal | EMA Pullback | Stoch RSI
 *  Dashboard:  Opens at your Railway URL automatically
 * ============================================================
 */

const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');
const chalk     = require('chalk');
const { createSimulatorDashboardHandler } = require('./dashboard/simulator-server');

// ─────────────────────────────────────────────────────────────
//  CONFIG — all values come from Railway → Variables tab
// ─────────────────────────────────────────────────────────────
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
const CONFIG = {
  DERIV_API_TOKEN : DEMO_MODE ? process.env.DERIV_DEMO_API_TOKEN : process.env.DERIV_API_TOKEN,
  DERIV_APP_ID    : process.env.DERIV_APP_ID    || '34p4exLBj1NDTx15WfqnE',
  DEMO_MODE,
  DEMO_CONTRACT_EXECUTION : DEMO_MODE && process.env.DEMO_CONTRACT_EXECUTION === 'true',
  DEMO_CONTRACT_MAX_TRADES: parseInt(process.env.DEMO_CONTRACT_MAX_TRADES || '3'),
  LIVE_TRADING_ENABLED     : process.env.LIVE_TRADING_ENABLED === 'true',
  LIVE_MAX_TRADES          : parseInt(process.env.LIVE_MAX_TRADES || '100'),
  DERIV_REAL_ACCOUNT_ID    : (process.env.DERIV_REAL_ACCOUNT_ID || '').trim(),
  INSTRUMENT      : process.env.INSTRUMENT      || 'BOOM500',
  BASE_STAKE      : parseFloat(process.env.BASE_STAKE     || '1.00'),
  MAX_DAILY_DD    : parseFloat(process.env.MAX_DAILY_DD   || '10'),
  DAILY_TARGET    : parseFloat(process.env.DAILY_TARGET   || '15'),
  MARTINGALE      : process.env.MARTINGALE !== 'false',
  MARTI_MULT      : parseFloat(process.env.MARTI_MULT     || '1.8'),
  MARTI_MAX_LEVEL : parseInt(process.env.MARTI_MAX_LEVEL  || '3'),
  MULTIPLIER      : parseInt(process.env.MULTIPLIER       || '100'),
  MULTIPLIER_EXIT_TICKS : parseInt(process.env.MULTIPLIER_EXIT_TICKS || '5'),
  PORT            : parseInt(process.env.PORT             || '8080'),
};

if (CONFIG.DEMO_MODE) {
  if (process.env.SIMULATOR_ONLY !== 'true' || process.env.DASHBOARD_TEST_ONLY !== 'true') {
    throw new Error('Demo staging requires SIMULATOR_ONLY=true and DASHBOARD_TEST_ONLY=true.');
  }
  if (!CONFIG.DERIV_API_TOKEN) {
    throw new Error('DERIV_DEMO_API_TOKEN is required in demo mode.');
  }
} else {
  if (!CONFIG.LIVE_TRADING_ENABLED) {
    throw new Error('Live mode is locked. Set LIVE_TRADING_ENABLED=true only after explicit approval.');
  }
  if (process.env.SIMULATOR_ONLY === 'true' || process.env.DASHBOARD_TEST_ONLY === 'true') {
    throw new Error('Live mode refuses simulator-only safety flags.');
  }
  if (!CONFIG.DERIV_API_TOKEN) {
    throw new Error('DERIV_API_TOKEN is required in live mode.');
  }
}
CONFIG.ALLOWED_INSTRUMENTS = ['BOOM500','BOOM1000','CRASH500','CRASH1000'];

if (!Number.isSafeInteger(CONFIG.MULTIPLIER) || CONFIG.MULTIPLIER < 100) {
  throw new Error('MULTIPLIER must be at least 100 for the actual Boom/Crash multiplier markets.');
}
if (!Number.isFinite(CONFIG.BASE_STAKE) || CONFIG.BASE_STAKE < 1) {
  throw new Error('BASE_STAKE must be at least $1.00 for actual Boom/Crash multiplier execution.');
}
if (!Number.isSafeInteger(CONFIG.MULTIPLIER_EXIT_TICKS) || CONFIG.MULTIPLIER_EXIT_TICKS < 1 || CONFIG.MULTIPLIER_EXIT_TICKS > 100) {
  throw new Error('MULTIPLIER_EXIT_TICKS must be an integer from 1 to 100.');
}

const SYMBOL_MAP = {
  BOOM500:'BOOM500', BOOM1000:'BOOM1000', CRASH500:'CRASH500', CRASH1000:'CRASH1000',
};

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────
const S = {
  ws:null, accountId:null,
  balance:0, startBalance:0, lowestBalance:Infinity,
  wins:0, losses:0, trades:0, consecutiveLoss:0, liveBatchTrades:0,
  stopped:true, manualStop:true, ticks:[], inTrade:false,
  reqId:1, pendingCbs:{}, dailyPnl:0,
  sessionStart:new Date(), reconnects:0,
  recentLogs:[], recentTrades:[],
  lastPrice:0, priceHistory:[], equityHistory:[],
  currentSignal:null, dailyResets:0,
  activeContractId:null, tradeStartBalance:null,
  tradeTicks:0, exitRequested:false,
  indicators:{ rsi:50, stochRsi:50, emaSignal:'—', macd:0, squeeze:false, spike:false },
};

let nextResetIn = 0;
let dailyResetTimeout = null;
let dailyResetCountdown = null;

const tsISO = () => new Date().toISOString().replace('T',' ').slice(0,19);
const ts    = () => new Date().toTimeString().slice(0,8);

function pushLog(type, msg) {
  S.recentLogs.unshift({ time:ts(), type, msg });
  if (S.recentLogs.length > 100) S.recentLogs.pop();
}

const log = {
  info  : (...a) => { const m=a.join(' '); console.log(chalk.cyan(`[${tsISO()}]`),m);           pushLog('info',m);  },
  trade : (...a) => { const m=a.join(' '); console.log(chalk.yellow(`[${tsISO()}]`),m);          pushLog('trade',m); },
  win   : (...a) => { const m=a.join(' '); console.log(chalk.green(`[${tsISO()}] ✓`),m);         pushLog('win',m);   },
  loss  : (...a) => { const m=a.join(' '); console.log(chalk.red(`[${tsISO()}] ✗`),m);           pushLog('loss',m);  },
  warn  : (...a) => { const m=a.join(' '); console.log(chalk.magenta(`[${tsISO()}] ⚠`),m);       pushLog('warn',m);  },
  stop  : (...a) => { const m=a.join(' '); console.log(chalk.bgRed.white(`[${tsISO()}] ⛔`),m);  pushLog('stop',m);  },
};

// ─────────────────────────────────────────────────────────────
//  DASHBOARD HTML
// ─────────────────────────────────────────────────────────────
// Replacement dashboard is served from ./dashboard/ (authenticated + read-only).

function simulatorControlError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function resetLiveBatch(reason) {
  if (CONFIG.DEMO_MODE) return;
  S.liveBatchTrades = 0;
  log.info('Live batch counter reset to 0/'+CONFIG.LIVE_MAX_TRADES+' ('+reason+')');
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
      if (!CONFIG.DEMO_MODE && CONFIG.LIVE_MAX_TRADES > 0 && S.liveBatchTrades >= CONFIG.LIVE_MAX_TRADES) {
        throw simulatorControlError('Live batch limit reached. Use RESET FORM or change instrument before starting another batch.');
      }
      S.manualStop = false;
      S.stopped = false;
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) reconnectSimulatorFeed();
      log.info('Bot started from app');
      return { running:true };
    }

    if (cmd.action === 'reset-live-batch') {
      if (S.inTrade) throw simulatorControlError('Wait for the current trade to finish before resetting the live batch.');
      resetLiveBatch('RESET FORM');
      return { liveBatchTrades:S.liveBatchTrades, liveMaxTrades:CONFIG.LIVE_MAX_TRADES };
    }

    if (cmd.action === 'stop') {
      S.manualStop = true;
      S.stopped = true;
      S.currentSignal = null;
      log.stop('Bot stopped from app');
      return { running:false, inTrade:Boolean(S.inTrade) };
    }

    if (cmd.action === 'update-config') {
      if (S.inTrade) throw simulatorControlError('Wait for the current trade to finish before changing settings.');

      const instrument = String(cmd.instrument || '').toUpperCase();
      const stake = Number(cmd.baseStake);
      const maxDD = Number(cmd.maxDD);
      const target = Number(cmd.dailyTarget);

      if (!CONFIG.ALLOWED_INSTRUMENTS.includes(instrument)) throw simulatorControlError('Unsupported instrument.');
      if (!Number.isFinite(stake) || stake < 1 || stake > 1000) throw simulatorControlError('Stake must be between $1.00 and $1000 for actual Boom/Crash multipliers.');
      if (!Number.isFinite(maxDD) || maxDD < 0.1 || maxDD > 50) throw simulatorControlError('DD limit must be between 0.1% and 50%.');
      if (!Number.isFinite(target) || target < 0.1 || target > 100) throw simulatorControlError('Target profit must be between 0.1% and 100%.');

      const instrumentChanged = instrument !== CONFIG.INSTRUMENT;
      CONFIG.INSTRUMENT = instrument;
      CONFIG.BASE_STAKE = parseFloat(stake.toFixed(2));
      CONFIG.MAX_DAILY_DD = parseFloat(maxDD.toFixed(1));
      CONFIG.DAILY_TARGET = parseFloat(target.toFixed(1));

      log.info(
        'Bot settings updated: ' +
        CONFIG.INSTRUMENT + ' | stake $' + CONFIG.BASE_STAKE +
        ' | DD ' + CONFIG.MAX_DAILY_DD + '% | target +' + CONFIG.DAILY_TARGET + '%'
      );

      if (instrumentChanged) {
        resetLiveBatch('instrument changed to '+CONFIG.INSTRUMENT);
        reconnectSimulatorFeed();
      }

      return {
        instrument:CONFIG.INSTRUMENT,
        baseStake:CONFIG.BASE_STAKE,
        maxDD:CONFIG.MAX_DAILY_DD,
        dailyTarget:CONFIG.DAILY_TARGET,
      };
    }

    throw simulatorControlError('Unsupported bot action.');
  },
};

const server = http.createServer(createSimulatorDashboardHandler({
  state:S,
  config:CONFIG,
  controls:simulatorControls,
}));

server.listen(CONFIG.PORT, () => {
  log.info('Dashboard running on port '+CONFIG.PORT);
});

// ─────────────────────────────────────────────────────────────
//  MIDNIGHT RESET
// ─────────────────────────────────────────────────────────────
function scheduleDailyReset(){
  if(dailyResetCountdown){ clearInterval(dailyResetCountdown); dailyResetCountdown=null; }
  if(dailyResetTimeout){ clearTimeout(dailyResetTimeout); dailyResetTimeout=null; }

  const now=new Date();
  const next=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1));
  const delay=next-now;
  nextResetIn=Math.floor(delay/1000);

  dailyResetCountdown=setInterval(()=>{ nextResetIn=Math.max(0,nextResetIn-1); },1000);
  dailyResetTimeout=setTimeout(()=>{
    clearInterval(dailyResetCountdown);
    dailyResetCountdown=null;
    dailyResetTimeout=null;

    log.info('--- Midnight reset: counters cleared ---');
    S.startBalance=S.balance; S.lowestBalance=S.balance;
    S.dailyPnl=0; S.wins=0; S.losses=0; S.trades=0;
    S.consecutiveLoss=0; S.stopped=Boolean(S.manualStop);
    S.equityHistory=[S.balance]; S.dailyResets++;
      scheduleDailyReset();
  }, delay);

  log.info('Next daily reset in '+Math.floor(delay/3600000)+'h '+Math.floor((delay%3600000)/60000)+'m');
}

// ─────────────────────────────────────────────────────────────
//  REST HELPER
// ─────────────────────────────────────────────────────────────
function restCall(method, path, body){
  return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null;
    const req=https.request({
      hostname:'api.derivws.com', path, method,
      headers:{
        'Content-Type':'application/json',
        'Authorization':'Bearer '+CONFIG.DERIV_API_TOKEN,
        'Deriv-App-ID':CONFIG.DERIV_APP_ID,
        ...(data?{'Content-Length':Buffer.byteLength(data)}:{}),
      }
    },res=>{
      let raw='';
      res.on('data',c=>raw+=c);
      res.on('end',()=>{
        try{
          const p=JSON.parse(raw);
          if(res.statusCode>=200&&res.statusCode<300) resolve(p);
          else reject(new Error('HTTP '+res.statusCode+': '+raw));
        }catch(e){reject(new Error('Parse error: '+raw));}
      });
    });
    req.on('error',reject);
    if(data) req.write(data);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
//  DERIV API FLOW
// ─────────────────────────────────────────────────────────────
async function getAccountId(){
  log.info('Fetching account list...');
  const res=await restCall('GET','/trading/v1/options/accounts');
  const list=Array.isArray(res.data||res)?(res.data||res):[res.data||res];
  const accountIdOf=a=>String((a&&(a.account_id||a.id||a.loginid))||'');
  let account;
  if(CONFIG.DEMO_MODE){
    account=list.find(a=>a.account_type==='demo'||a.is_virtual||a.type==='demo');
    if(!account) throw new Error('A Deriv demo account was not found.');
  }else{
    const realAccounts=list.filter(a=>a.account_type==='real'||(!a.is_virtual&&a.type!=='demo'));
    const accountSummary=realAccounts.map(a=>{
      const bal=Number(a.balance);
      return accountIdOf(a)+' | balance:'+(Number.isFinite(bal)?'$'+bal.toFixed(2):'n/a')+' | currency:'+(a.currency||'n/a')+' | status:'+(a.status||'n/a');
    });
    log.info('Authorized real Options accounts: '+(accountSummary.join(' ; ')||'none'));
    if(CONFIG.DERIV_REAL_ACCOUNT_ID){
      account=realAccounts.find(a=>accountIdOf(a)===CONFIG.DERIV_REAL_ACCOUNT_ID);
      if(!account) throw new Error('DERIV_REAL_ACCOUNT_ID was not found in the authorized real accounts.');
    }else if(realAccounts.length===1){
      account=realAccounts[0];
    }else if(realAccounts.length===0){
      throw new Error('A Deriv real account was not found.');
    }else{
      throw new Error('Multiple real accounts found. Set DERIV_REAL_ACCOUNT_ID before live trading.');
    }
  }
  const id=accountIdOf(account);
  log.info('Account: '+id+' ['+(CONFIG.DEMO_MODE?'DEMO':'LIVE')+']');
  return id;
}

async function getOTP(accountId){
  log.info('Getting OTP for '+accountId+'...');
  const res=await restCall('POST','/trading/v1/options/accounts/'+accountId+'/otp');
  const wsUrl=(res.data&&res.data.url)||res.url;
  if(!wsUrl) throw new Error('No WebSocket URL in response: '+JSON.stringify(res));
  log.info('OTP received');
  return wsUrl;
}

function validateContractOffering(){
  return new Promise(resolve=>{
    if(CONFIG.DEMO_MODE&&!CONFIG.DEMO_CONTRACT_EXECUTION){ resolve(true); return; }

    const symbol=SYMBOL_MAP[CONFIG.INSTRUMENT];
    send({contracts_for:symbol},msg=>{
      if(msg.error){
        log.stop('Contract preflight failed: '+msg.error.message);
        S.stopped=true; S.manualStop=true; resolve(false); return;
      }

      const available=((msg.contracts_for||{}).available)||[];
      const contractTypes=[...new Set(available.map(c=>c.contract_type).filter(Boolean))].sort();
      const hasUp=contractTypes.includes('MULTUP');
      const hasDown=contractTypes.includes('MULTDOWN');

      log.info('Available contract types for '+CONFIG.INSTRUMENT+' ['+symbol+']: '+(contractTypes.join(', ')||'none'));

      if(!hasUp||!hasDown){
        log.stop('MULTUP/MULTDOWN not both offered for '+CONFIG.INSTRUMENT+' on this Deriv account.');
        S.stopped=true; S.manualStop=true; resolve(false); return;
      }

      const probe=contractType=>new Promise(done=>{
        send({
          proposal:1,
          amount:CONFIG.BASE_STAKE,
          basis:'stake',
          contract_type:contractType,
          currency:'USD',
          duration_unit:'s',
          multiplier:CONFIG.MULTIPLIER,
          underlying_symbol:symbol,
        },proposalMsg=>{
          if(proposalMsg.error){
            done({ok:false,type:contractType,error:proposalMsg.error.message});
            return;
          }
          const proposal=proposalMsg.proposal||{};
          done({ok:Boolean(proposal.id),type:contractType,error:proposal.id?'':'missing proposal ID'});
        });
      });

      Promise.all([probe('MULTUP'),probe('MULTDOWN')]).then(results=>{
        const failed=results.find(r=>!r.ok);
        if(failed){
          log.stop('Multiplier preflight failed for '+failed.type+' x'+CONFIG.MULTIPLIER+': '+failed.error);
          S.stopped=true; S.manualStop=true; resolve(false); return;
        }
        log.info('Multiplier preflight passed: '+CONFIG.INSTRUMENT+' actual symbol '+symbol+
          ' | MULTUP/MULTDOWN | x'+CONFIG.MULTIPLIER+
          ' | market exit after '+CONFIG.MULTIPLIER_EXIT_TICKS+' ticks.');
        resolve(true);
      }).catch(error=>{
        log.stop('Multiplier preflight failed: '+error.message);
        S.stopped=true; S.manualStop=true; resolve(false);
      });
    });
  });
}

function connectWebSocket(wsUrl){
  log.info('Connecting to Deriv...');
  S.ws=new WebSocket(wsUrl);
  S.ws.on('open',async()=>{
    log.info('Connected!');
    getBalance();
    const ok=await validateContractOffering();
    if(ok) subscribeTicks();
  });
  S.ws.on('message',raw=>{ try{handleMessage(JSON.parse(raw));}catch(e){} });
  S.ws.on('close',()=>{
    if(!S.stopped){
      S.reconnects++;
      const delay=Math.min(5000*S.reconnects,30000);
      log.warn('Disconnected. Reconnecting in '+(delay/1000)+'s...');
      setTimeout(startBot,delay);
    }
  });
  S.ws.on('error',e=>log.warn('WS error: '+e.message));
}

function send(payload,cb){
  const id=S.reqId++; payload.req_id=id;
  if(cb) S.pendingCbs[id]=cb;
  if(S.ws&&S.ws.readyState===WebSocket.OPEN) S.ws.send(JSON.stringify(payload));
  return id;
}

function handleMessage(msg){
  if(msg.req_id&&S.pendingCbs[msg.req_id]){
    const cb=S.pendingCbs[msg.req_id]; delete S.pendingCbs[msg.req_id]; cb(msg); return;
  }
  if(msg.msg_type==='tick')                   return onTick(msg.tick);
  if(msg.msg_type==='proposal_open_contract') return onContractUpdate(msg.proposal_open_contract);
  if(msg.msg_type==='balance')                return onBalance(msg.balance);
  if(msg.error) log.warn('API ['+msg.error.code+']: '+msg.error.message);
}

function getBalance(){
  send({balance:1,subscribe:1},msg=>{
    if(msg.error){log.warn('Balance error: '+msg.error.message);return;}
    S.balance=parseFloat(msg.balance.balance);
    S.startBalance=S.balance; S.lowestBalance=S.balance;
    S.equityHistory=[S.balance];
    log.info('Balance: $'+S.balance.toFixed(2)+' | '+CONFIG.INSTRUMENT+' | Target +'+CONFIG.DAILY_TARGET+'% | Max DD '+CONFIG.MAX_DAILY_DD+'%');
    scheduleDailyReset();
  });
}

function onBalance(d){
  S.balance=parseFloat(d.balance);
  if(!S.inTrade&&S.balance<S.lowestBalance) S.lowestBalance=S.balance;
}

function subscribeTicks(){
  send({ticks:SYMBOL_MAP[CONFIG.INSTRUMENT],subscribe:1},()=>
    log.info('Subscribed to '+CONFIG.INSTRUMENT+'. Bot scanning for signals...')
  );
}

function onTick(tick){
  if(!tick) return;

  const price=parseFloat(tick.quote);
  if(!Number.isFinite(price)) return;

  S.lastPrice=price;
  S.priceHistory.push(price);
  if(S.priceHistory.length>200) S.priceHistory.shift();

  // An already-open multiplier contract must still count market ticks even if
  // the user presses STOP. STOP prevents new entries; it does not strand an
  // existing multiplier position.
  if(S.inTrade){
    if(S.activeContractId&&!S.exitRequested){
      S.tradeTicks++;
      if(S.tradeTicks>=CONFIG.MULTIPLIER_EXIT_TICKS) closeActiveMultiplierAtMarket();
    }
    return;
  }

  if(S.stopped) return;

  S.ticks.push(price);
  if(S.ticks.length>200) S.ticks.shift();
  if(S.ticks.length<30) return;

  const signal=analyze(S.ticks);
  S.currentSignal=signal;
  if(signal) placeTrade(signal);
}

// ─────────────────────────────────────────────────────────────
//  STRATEGY ENGINE
// ─────────────────────────────────────────────────────────────
function analyze(prices){
  const n=prices.length, ar=avgDiff(prices.slice(-30));
  const sU=prices[n-1]-prices[n-2]>ar*3, sD=prices[n-2]-prices[n-1]>ar*3;
  const R=rsi(prices,14), E8=ema(prices,8), E21=ema(prices,21);
  const E200=prices.length>=200?ema(prices,200):null;
  const bb=bollinger(prices,20,2), abw=avgBW(prices,20,2,20);
  const sq=bb.bw<abw*0.85, SR=stochRSI(prices,14), MH=macdHisto(prices), p=prices[n-1];
  S.indicators={rsi:R,stochRsi:SR||50,emaSignal:E8&&E21?(E8>E21?'up':'down'):'—',macd:MH,squeeze:sq,spike:sU||sD};
  if((sU||sD)&&sq){
    if(sU&&R>65) return{dir:'down',strategy:'Spike Reversal'};
    if(sD&&R<35) return{dir:'up',  strategy:'Spike Reversal'};
  }
  if(E8&&E21){
    const tr=E8>E21?'up':'down', mc=E200?(p>E200?'up':'down'):tr;
    if(tr==='up'  &&p<=E8*1.001&&MH>0&&mc==='up')  return{dir:'up',  strategy:'EMA Pullback'};
    if(tr==='down'&&p>=E8*0.999&&MH<0&&mc==='down') return{dir:'down',strategy:'EMA Pullback'};
  }
  if(SR!==null){
    if(SR<15&&R<35) return{dir:'up',  strategy:'Stoch RSI'};
    if(SR>85&&R>65) return{dir:'down',strategy:'Stoch RSI'};
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  TRADE EXECUTION
// ─────────────────────────────────────────────────────────────
function getStake(){
  if(!CONFIG.MARTINGALE||S.consecutiveLoss<2) return CONFIG.BASE_STAKE;
  const lv=Math.min(S.consecutiveLoss-1,CONFIG.MARTI_MAX_LEVEL);
  return Math.min(CONFIG.BASE_STAKE*Math.pow(CONFIG.MARTI_MULT,lv),S.balance*0.05);
}

function closeActiveMultiplierAtMarket(){
  if(!S.inTrade||!S.activeContractId||S.exitRequested) return;
  S.exitRequested=true;
  const contractId=S.activeContractId;
  log.trade('5-tick exit reached | Selling multiplier contract '+contractId+' at market');
  send({sell:contractId,price:0},msg=>{
    if(msg.error){
      S.exitRequested=false;
      log.warn('Market exit failed: '+msg.error.message);
      return;
    }
    log.trade('Market exit accepted | ID: '+contractId);
  });
}

function placeTrade(signal){
  const dd=drawdownPct(), pp=pnlPct();
  if(dd>=CONFIG.MAX_DAILY_DD) {log.stop('DD limit hit — paused until midnight');S.stopped=true;return;}
  if(pp>=CONFIG.DAILY_TARGET) {log.win('Daily target hit — paused until midnight');S.stopped=true;return;}
  const stake=parseFloat(getStake().toFixed(2));
  if(stake<1){log.warn('Stake below actual Boom/Crash multiplier minimum of $1.00. Skipping.');return;}

  const contractType=signal.dir==='up'?'MULTUP':'MULTDOWN';
  const symbol=SYMBOL_MAP[CONFIG.INSTRUMENT];

  S.inTrade=true;
  S.currentSignal=signal;
  S.tradeStartBalance=S.balance;
  S.tradeTicks=0;
  S.exitRequested=false;

  log.trade('Signal: '+signal.strategy+' | '+signal.dir.toUpperCase()+
    ' | '+contractType+' x'+CONFIG.MULTIPLIER+
    ' | '+symbol+' | $'+stake+' | DD:'+dd.toFixed(1)+'%');

  if(CONFIG.DEMO_MODE&&!CONFIG.DEMO_CONTRACT_EXECUTION){simulateTrade(signal,stake);return;}

  send({
    proposal:1,
    amount:stake,
    basis:'stake',
    contract_type:contractType,
    currency:'USD',
    duration_unit:'s',
    multiplier:CONFIG.MULTIPLIER,
    underlying_symbol:symbol,
  },proposalMsg=>{
    if(proposalMsg.error){
      log.warn('Proposal failed: '+proposalMsg.error.message);
      S.inTrade=false; S.activeContractId=null; S.tradeStartBalance=null;
      S.tradeTicks=0; S.exitRequested=false;
      return;
    }

    const proposal=proposalMsg.proposal||{};
    const proposalId=proposal.id;
    const askPrice=parseFloat(proposal.ask_price);

    if(!proposalId||!Number.isFinite(askPrice)){
      log.warn('Proposal failed: missing proposal ID or ask price.');
      S.inTrade=false; S.activeContractId=null; S.tradeStartBalance=null;
      S.tradeTicks=0; S.exitRequested=false;
      return;
    }

    log.trade('Multiplier proposal accepted | ID: '+proposalId+' | Price:$'+askPrice.toFixed(2));

    send({buy:proposalId,price:askPrice},msg=>{
      if(msg.error){
        log.warn('Order failed: '+msg.error.message);
        S.inTrade=false; S.activeContractId=null; S.tradeStartBalance=null;
        S.tradeTicks=0; S.exitRequested=false;
        return;
      }

      S.activeContractId=msg.buy.contract_id;
      S.tradeTicks=0;
      S.exitRequested=false;
      log.trade('Multiplier order placed | ID: '+msg.buy.contract_id+
        ' | exit after '+CONFIG.MULTIPLIER_EXIT_TICKS+' market ticks');
      send({proposal_open_contract:1,contract_id:msg.buy.contract_id,subscribe:1});
    });
  });
}

function onContractUpdate(c){
  if(!c||!S.inTrade||!S.activeContractId) return;
  if(String(c.contract_id)!==String(S.activeContractId)) return;
  const closed=Boolean(c.is_sold)||(c.status&&c.status!=='open');
  if(!closed) return;
  const profit=parseFloat(c.profit);
  if(!Number.isFinite(profit)) return;
  const rawBal=parseFloat(c.balance_after);
  const balAfter=Number.isFinite(rawBal)?rawBal:null;
  S.activeContractId=null;
  S.tradeTicks=0;
  S.exitRequested=false;
  recordResult(profit>0,profit,balAfter,S.currentSignal);
}

function simulateTrade(signal,stake){
  const wP={'Spike Reversal':0.61,'EMA Pullback':0.57,'Stoch RSI':0.55}[signal.strategy]||0.57;
  const won=Math.random()<wP, profit=won?parseFloat((stake*(1.4+Math.random()*0.4)).toFixed(2)):-stake;
  setTimeout(()=>recordResult(won,profit,null,signal),900+Math.random()*1200);
}

function recordResult(won,profit,balAfter,signal){
  S.trades++;
  if(!CONFIG.DEMO_MODE) S.liveBatchTrades++;
  const synthetic=CONFIG.DEMO_MODE&&!CONFIG.DEMO_CONTRACT_EXECUTION;
  if(synthetic){
    S.balance=balAfter??parseFloat((S.balance+profit).toFixed(2));
  }else if(Number.isFinite(balAfter)){
    S.balance=balAfter;
  }else if(Number.isFinite(S.tradeStartBalance)){
    S.balance=parseFloat((S.tradeStartBalance+profit).toFixed(2));
  }
  S.dailyPnl+=profit;
  if(S.balance<S.lowestBalance) S.lowestBalance=S.balance;
  S.equityHistory.push(S.balance);
  if(S.equityHistory.length>150) S.equityHistory.shift();
  S.recentTrades.unshift({strategy:(signal||{}).strategy||'—',dir:(signal||{}).dir||'—',stake:parseFloat(getStake().toFixed(2)),profit});
  if(S.recentTrades.length>50) S.recentTrades.pop();
  if(won){S.wins++;S.consecutiveLoss=0;log.win('WIN +$'+Math.abs(profit).toFixed(2)+' | Bal:$'+S.balance.toFixed(2)+' | WR:'+wr()+'% | #'+S.trades);}
  else{S.losses++;S.consecutiveLoss++;log.loss('LOSS -$'+Math.abs(profit).toFixed(2)+' | Bal:$'+S.balance.toFixed(2)+' | Streak:'+S.consecutiveLoss);}
  S.inTrade=false; S.currentSignal=null; S.tradeStartBalance=null;
  S.tradeTicks=0; S.exitRequested=false;
  if(CONFIG.DEMO_CONTRACT_EXECUTION&&CONFIG.DEMO_CONTRACT_MAX_TRADES>0&&S.trades>=CONFIG.DEMO_CONTRACT_MAX_TRADES){
    S.stopped=true; S.manualStop=true;
    log.stop('Demo contract acceptance limit reached: '+S.trades+' trades. Paused.');
  }
  if(!CONFIG.DEMO_MODE&&CONFIG.LIVE_MAX_TRADES>0&&S.liveBatchTrades>=CONFIG.LIVE_MAX_TRADES){
    S.stopped=true; S.manualStop=true;
    log.stop('Live batch limit reached: '+S.liveBatchTrades+'/'+CONFIG.LIVE_MAX_TRADES+' completed trades. Paused.');
  }
}

// ─────────────────────────────────────────────────────────────
//  INDICATORS
// ─────────────────────────────────────────────────────────────
function ema(p,n){if(p.length<n)return null;const k=2/(n+1);let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<p.length;i++)e=p[i]*k+e*(1-k);return e;}
function rsi(p,n=14){if(p.length<n+1)return 50;const ch=p.slice(1).map((v,i)=>v-p[i]),rc=ch.slice(-n),g=rc.filter(c=>c>0).reduce((a,b)=>a+b,0)/n,l=rc.filter(c=>c<0).map(c=>Math.abs(c)).reduce((a,b)=>a+b,0)/n;if(l===0)return 100;return 100-(100/(1+g/l));}
function bollinger(p,n=20,m=2){if(p.length<n)return{bw:0};const sl=p.slice(-n),mn=sl.reduce((a,b)=>a+b,0)/n,sd=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/n);return{bw:(2*m*sd)/mn};}
function avgBW(p,n=20,m=2,lb=20){if(p.length<n+lb)return Infinity;let t=0;for(let i=0;i<lb;i++){const sl=p.slice(-(n+i),p.length-i||undefined);t+=bollinger(sl,n,m).bw;}return t/lb;}
function stochRSI(p,n=14){if(p.length<n*2)return null;const a=[];for(let i=n;i<=p.length;i++)a.push(rsi(p.slice(0,i),n));if(a.length<n)return null;const w=a.slice(-n),mn=Math.min(...w),mx=Math.max(...w);if(mx===mn)return 50;return((a[a.length-1]-mn)/(mx-mn))*100;}
function macdHisto(p){const ef=ema(p,12),es=ema(p,26);if(!ef||!es)return 0;return ef-es;}
function avgDiff(p){if(p.length<2)return 0;let s=0;for(let i=1;i<p.length;i++)s+=Math.abs(p[i]-p[i-1]);return s/(p.length-1);}
function drawdownPct(){return Math.max(0,((S.startBalance-S.lowestBalance)/S.startBalance)*100);}
function pnlPct(){return((S.balance-S.startBalance)/S.startBalance)*100;}
function wr(){return S.trades?Math.round(S.wins/S.trades*100):0;}

process.on('SIGINT', ()=>process.exit(0));
process.on('SIGTERM',()=>process.exit(0));

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
async function startBot(){
  if(!CONFIG.DERIV_API_TOKEN){ log.stop((CONFIG.DEMO_MODE?'DERIV_DEMO_API_TOKEN':'DERIV_API_TOKEN')+' not set in Railway Variables!'); return; }
  if(!CONFIG.DERIV_APP_ID)   { log.stop('DERIV_APP_ID not set in Railway Variables!');    return; }
  try{
    const id=await getAccountId();
    S.accountId=id;
    const wsUrl=await getOTP(id);
    connectWebSocket(wsUrl);
  }catch(e){
    log.stop('Startup error: '+e.message);
    if(e.message.includes('401')||e.message.includes('403')){
      log.stop('Token rejected - check the active Deriv token and DERIV_APP_ID in Railway Variables');
      return;
    }
    log.warn('Retrying in 15s...');
    setTimeout(startBot,15000);
  }
}

console.log(chalk.green('\n  ⚡ DERIV BOOM & CRASH EA BOT — FRESH BUILD'));
console.log(chalk.gray('  ─────────────────────────────────────────'));
console.log(chalk.yellow('  Mode  : '+(CONFIG.DEMO_MODE?'DEMO':'🔴 LIVE')));
console.log(chalk.cyan( '  Index : '+CONFIG.INSTRUMENT+' | Stake: $'+CONFIG.BASE_STAKE));
console.log(chalk.cyan( '  Target: +'+CONFIG.DAILY_TARGET+'% | Max DD: '+CONFIG.MAX_DAILY_DD+'%'));
console.log(chalk.cyan( '  Port  : '+CONFIG.PORT+'\n'));

startBot(); // Starts connected but paused; trading begins only after authenticated dashboard Start.