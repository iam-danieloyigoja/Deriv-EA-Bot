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
const { createDashboardHandler } = require('./dashboard/server');

// ─────────────────────────────────────────────────────────────
//  CONFIG — all values come from Railway → Variables tab
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  DERIV_API_TOKEN : process.env.DERIV_API_TOKEN,
  DERIV_APP_ID    : process.env.DERIV_APP_ID    || '34p4exLBj1NDTx15WfqnE',
  DEMO_MODE       : process.env.DEMO_MODE !== 'false',
  INSTRUMENT      : process.env.INSTRUMENT      || 'BOOM500',
  BASE_STAKE      : parseFloat(process.env.BASE_STAKE     || '0.35'),
  MAX_DAILY_DD    : parseFloat(process.env.MAX_DAILY_DD   || '10'),
  DAILY_TARGET    : parseFloat(process.env.DAILY_TARGET   || '15'),
  MARTINGALE      : process.env.MARTINGALE !== 'false',
  MARTI_MULT      : parseFloat(process.env.MARTI_MULT     || '1.8'),
  MARTI_MAX_LEVEL : parseInt(process.env.MARTI_MAX_LEVEL  || '3'),
  PORT            : parseInt(process.env.PORT             || '8080'),
};

if (process.env.DASHBOARD_TEST_ONLY !== 'true' || CONFIG.DEMO_MODE !== true) {
  throw new Error('Integration package requires DASHBOARD_TEST_ONLY=true and DEMO_MODE=true on an isolated test service.');
}

const SYMBOL_MAP = {
  BOOM500:'R_100', BOOM1000:'R_75', CRASH500:'R_50', CRASH1000:'R_25',
};

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────
const S = {
  ws:null, accountId:null,
  balance:0, startBalance:0, lowestBalance:Infinity,
  wins:0, losses:0, trades:0, consecutiveLoss:0,
  stopped:false, ticks:[], inTrade:false,
  reqId:1, pendingCbs:{}, dailyPnl:0,
  sessionStart:new Date(), reconnects:0,
  recentLogs:[], recentTrades:[],
  lastPrice:0, priceHistory:[], equityHistory:[],
  currentSignal:null, dailyResets:0,
  indicators:{ rsi:50, stochRsi:50, emaSignal:'—', macd:0, squeeze:false, spike:false },
};

let nextResetIn = 0;

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

const server = http.createServer(createDashboardHandler({ state: S, config: CONFIG }));

server.listen(CONFIG.PORT, () => {
  log.info('Dashboard running on port '+CONFIG.PORT);
});

// ─────────────────────────────────────────────────────────────
//  MIDNIGHT RESET
// ─────────────────────────────────────────────────────────────
function scheduleDailyReset(){
  const now=new Date();
  const next=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1));
  const delay=next-now;
  nextResetIn=Math.floor(delay/1000);
  const countdown=setInterval(()=>{ nextResetIn=Math.max(0,nextResetIn-1); },1000);
  setTimeout(()=>{
    clearInterval(countdown);
    log.info('--- Midnight reset: counters cleared ---');
    S.startBalance=S.balance; S.lowestBalance=S.balance;
    S.dailyPnl=0; S.wins=0; S.losses=0; S.trades=0;
    S.consecutiveLoss=0; S.stopped=false;
    S.equityHistory=[S.balance]; S.dailyResets++;
    scheduleDailyReset();
    if(!S.inTrade) subscribeTicks();
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
  const account=CONFIG.DEMO_MODE
    ? list.find(a=>a.account_type==='demo'||a.is_virtual||a.type==='demo')||list[0]
    : list.find(a=>a.account_type==='real'||(!a.is_virtual&&a.type!=='demo'))||list[0];
  if (process.env.DASHBOARD_TEST_ONLY === 'true' &&
      (!account || !(account.account_type==='demo' || account.is_virtual || account.type==='demo'))) {
    throw new Error('A Deriv demo account was not found. Monitor-only connection refused.');
  }
  const id=account.account_id||account.id||account.loginid;
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

function connectWebSocket(wsUrl){
  log.info('Connecting to Deriv...');
  S.ws=new WebSocket(wsUrl);
  S.ws.on('open',()=>{ log.info('Connected!'); getBalance(); subscribeTicks(); });
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
  if(S.balance<S.lowestBalance) S.lowestBalance=S.balance;
}

function subscribeTicks(){
  send({ticks:SYMBOL_MAP[CONFIG.INSTRUMENT],subscribe:1},()=>
    log.info('Subscribed to '+CONFIG.INSTRUMENT+'. Bot scanning for signals...')
  );
}

function onTick(tick){
  if(!tick||S.stopped||S.inTrade) return;
  const price=parseFloat(tick.quote);
  S.ticks.push(price); S.lastPrice=price;
  S.priceHistory.push(price);
  if(S.ticks.length>200) S.ticks.shift();
  if(S.priceHistory.length>200) S.priceHistory.shift();
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

function placeTrade(signal){
  // Test-mode safety guard: never simulate or submit a buy order.
  if (process.env.DASHBOARD_TEST_ONLY === 'true') return;
  const dd=drawdownPct(), pp=pnlPct();
  if(dd>=CONFIG.MAX_DAILY_DD) {log.stop('DD limit hit — paused until midnight');S.stopped=true;return;}
  if(pp>=CONFIG.DAILY_TARGET) {log.win('Daily target hit — paused until midnight');S.stopped=true;return;}
  const stake=parseFloat(getStake().toFixed(2));
  if(stake<0.35){log.warn('Stake below minimum. Skipping.');return;}
  S.inTrade=true; S.currentSignal=signal;
  log.trade('Signal: '+signal.strategy+' | '+signal.dir.toUpperCase()+' | $'+stake+' | DD:'+dd.toFixed(1)+'%');
  if(CONFIG.DEMO_MODE){simulateTrade(signal,stake);return;}
  send({buy:1,price:stake,parameters:{
    contract_type:signal.dir==='up'?'CALL':'PUT',
    underlying_symbol:SYMBOL_MAP[CONFIG.INSTRUMENT],
    duration:5,duration_unit:'t',basis:'stake',currency:'USD',
  }},msg=>{
    if(msg.error){log.warn('Order failed: '+msg.error.message);S.inTrade=false;return;}
    log.trade('Order placed | ID: '+msg.buy.contract_id);
    send({proposal_open_contract:1,contract_id:msg.buy.contract_id,subscribe:1});
  });
}

function onContractUpdate(c){
  if(!c||c.status==='open') return;
  recordResult(parseFloat(c.profit)>0,parseFloat(c.profit),parseFloat(c.balance_after),S.currentSignal);
}

function simulateTrade(signal,stake){
  const wP={'Spike Reversal':0.61,'EMA Pullback':0.57,'Stoch RSI':0.55}[signal.strategy]||0.57;
  const won=Math.random()<wP, profit=won?parseFloat((stake*(1.4+Math.random()*0.4)).toFixed(2)):-stake;
  setTimeout(()=>recordResult(won,profit,null,signal),900+Math.random()*1200);
}

function recordResult(won,profit,balAfter,signal){
  S.trades++; S.balance=balAfter??parseFloat((S.balance+profit).toFixed(2)); S.dailyPnl+=profit;
  if(S.balance<S.lowestBalance) S.lowestBalance=S.balance;
  S.equityHistory.push(S.balance);
  if(S.equityHistory.length>150) S.equityHistory.shift();
  S.recentTrades.unshift({strategy:(signal||{}).strategy||'—',dir:(signal||{}).dir||'—',stake:parseFloat(getStake().toFixed(2)),profit});
  if(S.recentTrades.length>50) S.recentTrades.pop();
  if(won){S.wins++;S.consecutiveLoss=0;log.win('WIN +$'+Math.abs(profit).toFixed(2)+' | Bal:$'+S.balance.toFixed(2)+' | WR:'+wr()+'% | #'+S.trades);}
  else{S.losses++;S.consecutiveLoss++;log.loss('LOSS -$'+Math.abs(profit).toFixed(2)+' | Bal:$'+S.balance.toFixed(2)+' | Streak:'+S.consecutiveLoss);}
  S.inTrade=false; S.currentSignal=null;
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
  if(!CONFIG.DERIV_API_TOKEN){ log.stop('DERIV_API_TOKEN not set in Railway Variables!'); return; }
  if(!CONFIG.DERIV_APP_ID)   { log.stop('DERIV_APP_ID not set in Railway Variables!');    return; }
  try{
    const id=await getAccountId();
    S.accountId=id;
    const wsUrl=await getOTP(id);
    connectWebSocket(wsUrl);
  }catch(e){
    log.stop('Startup error: '+e.message);
    if(e.message.includes('401')||e.message.includes('403')){
      log.stop('Token rejected — check DERIV_API_TOKEN and DERIV_APP_ID in Railway Variables');
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

startBot(); // Market monitoring only: all order paths are blocked by the test-mode guard.