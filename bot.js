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

// ─────────────────────────────────────────────────────────────
//  CONFIG — all values come from Railway → Variables tab
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  DERIV_API_TOKEN : process.env.DERIV_API_TOKEN || 'pat_12bdd4f66ea4a9f215e87d7288c15602fa435dae86298760537da5c78b4b2a49',
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
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Deriv EA Bot</title>
<meta name="theme-color" content="#080f1a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="EA Bot">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080f1a;--bg2:#0d1829;--bg3:#111f35;
  --border:#1a2d45;--text:#e2e8f5;--text2:#8fa3c0;--text3:#4a6080;
  --green:#22c55e;--green2:#16a34a;--red:#ef4444;--blue:#60a5fa;--amber:#f59e0b;
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;min-height:100vh}
.topbar{background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:52px;position:sticky;top:0;z-index:10}
.logo{font-size:15px;font-weight:700;color:var(--blue);letter-spacing:2px}
.srow{display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;animation:blink 1.2s infinite;flex-shrink:0}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.pill{padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;border:1px solid;white-space:nowrap}
.wrap{padding:12px;display:flex;flex-direction:column;gap:10px}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
@media(min-width:600px){.metrics{grid-template-columns:repeat(6,1fr)}}
.metric{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;text-align:center}
.mlabel{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.mval{font-size:20px;font-weight:700}
.cols{display:grid;grid-template-columns:1fr;gap:10px}
@media(min-width:900px){.cols{grid-template-columns:1fr 280px}}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.chead{padding:8px 14px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;display:flex;justify-content:space-between;align-items:center}
.cbody{padding:12px 14px}
.siggrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.sigitem{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;display:flex;align-items:center;justify-content:space-between}
.signame{font-size:11px;color:var(--text2)}
.badge{padding:2px 7px;border-radius:99px;font-size:10px;font-weight:700;border:1px solid}
.b-up{background:#0d2d1a;color:var(--green);border-color:var(--green2)}
.b-dn{background:#2d0d0d;color:var(--red);border-color:#dc2626}
.b-nt{background:var(--bg3);color:var(--text3);border-color:var(--border)}
.b-fire{background:#2d1a0d;color:var(--amber);border-color:#b45309}
.logarea{max-height:180px;overflow-y:auto}
.logline{display:flex;gap:8px;padding:4px 14px;border-bottom:1px solid var(--border);font-size:11px;font-family:monospace}
.logline:last-child{border:none}
.lt{color:var(--text3);min-width:52px;flex-shrink:0}
.l-win{color:var(--green)}.l-loss{color:var(--red)}.l-trade{color:var(--amber)}
.l-info{color:var(--blue)}.l-warn{color:var(--amber)}.l-stop{color:var(--red);font-weight:700}
.trow{display:grid;grid-template-columns:28px 1fr 38px 44px 54px;gap:4px;padding:5px 14px;border-bottom:1px solid var(--border);font-size:11px;align-items:center}
.trow:last-child{border:none}
.thead{background:var(--bg3);font-size:10px;color:var(--text3);text-transform:uppercase}
.ddwrap{height:5px;background:var(--border);margin:4px 14px 8px;border-radius:3px;overflow:hidden}
.ddfill{height:100%;border-radius:3px;transition:width .4s,background .4s}
.nodata{padding:14px;text-align:center;color:var(--text3);font-size:12px}
.cfgrow{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px}
.cfgrow:last-child{border:none}
.cfgkey{color:var(--text3)}
.sigbox{margin-top:10px;padding:10px;background:var(--bg3);border-radius:6px;text-align:center;border:1px solid var(--border)}
canvas{display:block;width:100%!important}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">⚡ DERIV EA BOT</div>
  <div class="srow">
    <span class="dot" id="sDot" style="background:var(--text3)"></span>
    <span class="pill" id="sPill" style="border-color:var(--border);color:var(--text3)">CONNECTING</span>
    <span id="upEl" style="font-size:10px;color:var(--text3)">—</span>
  </div>
</div>

<div class="wrap">
  <div class="metrics">
    <div class="metric"><div class="mlabel">Balance</div><div class="mval" id="mBal" style="color:var(--blue)">—</div></div>
    <div class="metric"><div class="mlabel">P&L $</div><div class="mval" id="mPnl">—</div></div>
    <div class="metric"><div class="mlabel">P&L %</div><div class="mval" id="mPct">—</div></div>
    <div class="metric"><div class="mlabel">Drawdown</div><div class="mval" id="mDD">—</div></div>
    <div class="metric"><div class="mlabel">Win Rate</div><div class="mval" id="mWR">—</div></div>
    <div class="metric"><div class="mlabel">Trades</div><div class="mval" id="mTr">0</div></div>
  </div>

  <div class="cols">
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="card">
        <div class="chead">
          <span id="priceLabel">BOOM500 — live price</span>
          <span id="priceEl" style="font-size:20px;font-weight:700;color:var(--blue);font-family:monospace">—</span>
        </div>
        <canvas id="pChart" height="140"></canvas>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);padding:5px 14px 2px">
          <span>Drawdown used</span><span id="ddLbl">0% / 10%</span>
        </div>
        <div class="ddwrap"><div class="ddfill" id="ddFill" style="width:0%;background:var(--green)"></div></div>
        <canvas id="eChart" height="60"></canvas>
      </div>

      <div class="card">
        <div class="chead"><span>Recent trades</span><span id="trCnt" style="color:var(--text3)">0 trades</span></div>
        <div class="trow thead"><span>#</span><span>Strategy</span><span>Dir</span><span>Stake</span><span>P&L</span></div>
        <div id="trList"><div class="nodata">Waiting for first signal...</div></div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="card">
        <div class="chead"><span>Live signals</span><span id="sigSc" style="color:var(--amber)">scanning</span></div>
        <div class="cbody">
          <div class="siggrid">
            <div class="sigitem"><span class="signame">RSI (14)</span><span id="sRsi" style="font-size:12px;font-weight:600;color:var(--text2)">—</span></div>
            <div class="sigitem"><span class="signame">Stoch RSI</span><span id="sSrsi" style="font-size:12px;font-weight:600;color:var(--text2)">—</span></div>
            <div class="sigitem"><span class="signame">EMA trend</span><span id="sEma">—</span></div>
            <div class="sigitem"><span class="signame">MACD</span><span id="sMacd">—</span></div>
            <div class="sigitem"><span class="signame">BB squeeze</span><span id="sSq">—</span></div>
            <div class="sigitem"><span class="signame">Spike</span><span id="sSpk">—</span></div>
          </div>
          <div class="sigbox" id="sigBox">
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px">ACTIVE SIGNAL</div>
            <div style="font-size:15px;font-weight:700;color:var(--text2)" id="sigMain">Scanning...</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="chead"><span>Configuration</span></div>
        <div class="cbody">
          <div class="cfgrow"><span class="cfgkey">Mode</span><span id="cMode">—</span></div>
          <div class="cfgrow"><span class="cfgkey">Instrument</span><span id="cInstr">—</span></div>
          <div class="cfgrow"><span class="cfgkey">Base stake</span><span id="cStake">—</span></div>
          <div class="cfgrow"><span class="cfgkey">Max drawdown</span><span id="cDD">—</span></div>
          <div class="cfgrow"><span class="cfgkey">Daily target</span><span id="cTgt">—</span></div>
          <div class="cfgrow"><span class="cfgkey">Recovery</span><span id="cMarti">—</span></div>
          <div class="cfgrow"><span class="cfgkey">Next reset</span><span id="cReset" style="color:var(--amber)">—</span></div>
        </div>
      </div>

      <div class="card">
        <div class="chead"><span>Activity log</span><span id="logCnt" style="color:var(--text3)">0 events</span></div>
        <div class="logarea" id="logArea"><div class="nodata">Connecting to Deriv...</div></div>
      </div>
    </div>
  </div>
</div>

<script>
let pChart=null, eChart=null;

function initCharts(){
  pChart=new Chart(document.getElementById('pChart').getContext('2d'),{
    type:'line',
    data:{labels:[],datasets:[{data:[],borderColor:'#60a5fa',backgroundColor:'rgba(96,165,250,0.05)',fill:true,tension:0.2,pointRadius:0,borderWidth:1.5}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:true,ticks:{color:'#4a6080',font:{size:10}},grid:{color:'rgba(26,45,69,0.8)'}}},animation:{duration:0}}
  });
  eChart=new Chart(document.getElementById('eChart').getContext('2d'),{
    type:'line',
    data:{labels:[],datasets:[{data:[],borderColor:'#22c55e',backgroundColor:'rgba(34,197,94,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:1.5}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:true,ticks:{color:'#4a6080',font:{size:9},callback:v=>'$'+v.toFixed(0)},grid:{color:'rgba(26,45,69,0.5)'}}},animation:{duration:300}}
  });
}

function b(cls,txt){ return '<span class="badge '+cls+'">'+txt+'</span>'; }

function update(d){
  // Status
  const run=d.running;
  document.getElementById('sDot').style.background=run?'#22c55e':'#ef4444';
  const pill=document.getElementById('sPill');
  pill.textContent=d.stopped?'STOPPED':d.demo?'DEMO — RUNNING':'LIVE — RUNNING';
  pill.style.borderColor=run?'#16a34a':'#dc2626';
  pill.style.color=run?'#22c55e':'#ef4444';
  const u=d.uptime||0;
  document.getElementById('upEl').textContent=Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m '+u%60+'s';

  // Metrics
  const pnl=(d.balance||0)-(d.startBalance||0);
  const pct=d.startBalance?((pnl/d.startBalance)*100).toFixed(1):'0.0';
  document.getElementById('mBal').textContent='$'+(d.balance||0).toFixed(2);
  const pEl=document.getElementById('mPnl');
  pEl.textContent=(pnl>=0?'+':'')+' $'+Math.abs(pnl).toFixed(2);
  pEl.style.color=pnl>=0?'#22c55e':'#ef4444';
  const pPEl=document.getElementById('mPct');
  pPEl.textContent=(parseFloat(pct)>=0?'+':'')+pct+'%';
  pPEl.style.color=parseFloat(pct)>=0?'#22c55e':'#ef4444';
  const dd=parseFloat(d.drawdown||0);
  const ddEl=document.getElementById('mDD');
  ddEl.textContent=dd.toFixed(1)+'%';
  ddEl.style.color=dd>7?'#ef4444':dd>4?'#f59e0b':'#22c55e';
  const wr=d.trades?Math.round(d.wins/d.trades*100):0;
  const wrEl=document.getElementById('mWR');
  wrEl.textContent=d.trades?wr+'%':'—';
  wrEl.style.color=wr>=55?'#22c55e':wr>=45?'#f59e0b':'#ef4444';
  document.getElementById('mTr').textContent=d.trades||0;

  // Price
  if(d.lastPrice) document.getElementById('priceEl').textContent=d.lastPrice.toFixed(5);
  document.getElementById('priceLabel').textContent=(d.instrument||'BOOM500')+' — live price';

  // DD bar
  const maxDD=d.maxDD||10, ddPct=Math.min((dd/maxDD)*100,100);
  const fill=document.getElementById('ddFill');
  fill.style.width=ddPct.toFixed(1)+'%';
  fill.style.background=ddPct>70?'#ef4444':ddPct>40?'#f59e0b':'#22c55e';
  document.getElementById('ddLbl').textContent=dd.toFixed(1)+'% / '+maxDD+'%';

  // Charts
  if(d.priceHistory&&pChart){
    pChart.data.labels=d.priceHistory.map((_,i)=>i);
    pChart.data.datasets[0].data=d.priceHistory;
    pChart.update('none');
  }
  if(d.equityHistory&&eChart&&d.equityHistory.length>0){
    const eq=d.equityHistory;
    eChart.data.labels=eq.map((_,i)=>i);
    eChart.data.datasets[0].data=eq;
    const rising=eq[eq.length-1]>=eq[0];
    eChart.data.datasets[0].borderColor=rising?'#22c55e':'#ef4444';
    eChart.data.datasets[0].backgroundColor=rising?'rgba(34,197,94,0.06)':'rgba(239,68,68,0.06)';
    eChart.update();
  }

  // Signals
  const ind=d.indicators||{};
  const rv=ind.rsi||50, sv=ind.stochRsi||50;
  const rEl=document.getElementById('sRsi');
  rEl.textContent=rv.toFixed(1); rEl.style.color=rv>65?'#ef4444':rv<35?'#22c55e':'#f59e0b';
  const srEl=document.getElementById('sSrsi');
  srEl.textContent=sv.toFixed(1); srEl.style.color=sv>80?'#ef4444':sv<20?'#22c55e':'#8fa3c0';
  document.getElementById('sEma').innerHTML=ind.emaSignal==='up'?b('b-up','▲ BULL'):ind.emaSignal==='down'?b('b-dn','▼ BEAR'):b('b-nt','—');
  const mh=ind.macd||0;
  document.getElementById('sMacd').innerHTML=mh>0?b('b-up','▲ Bull'):mh<0?b('b-dn','▼ Bear'):b('b-nt','—');
  document.getElementById('sSq').innerHTML=ind.squeeze?b('b-fire','🔥 YES'):b('b-nt','No');
  document.getElementById('sSpk').innerHTML=ind.spike?b('b-fire','⚡ SPIKE!'):b('b-nt','None');
  const sig=d.currentSignal;
  const sm=document.getElementById('sigMain');
  sm.textContent=sig?(sig.strategy+' — '+sig.dir.toUpperCase()):(d.inTrade?'⚡ In trade...':'Scanning...');
  sm.style.color=sig?(sig.dir==='up'?'#22c55e':'#ef4444'):'#8fa3c0';
  document.getElementById('sigSc').textContent=d.inTrade?'⚡ IN TRADE':'scanning';

  // Config
  document.getElementById('cMode').textContent=d.demo?'🟡 DEMO':'🔴 LIVE';
  document.getElementById('cInstr').textContent=d.instrument||'—';
  document.getElementById('cStake').textContent='$'+(d.baseStake||0.35);
  document.getElementById('cDD').textContent=(d.maxDD||10)+'%';
  document.getElementById('cTgt').textContent='+'+(d.dailyTarget||15)+'%';
  document.getElementById('cMarti').textContent=d.martingale?'On ('+d.martiMult+'x)':'Off';
  const nr=d.nextResetIn||0;
  document.getElementById('cReset').textContent=Math.floor(nr/3600)+'h '+Math.floor((nr%3600)/60)+'m';

  // Trades
  if(d.recentTrades&&d.recentTrades.length>0){
    document.getElementById('trList').innerHTML=d.recentTrades.slice(0,15).map((t,i)=>{
      const up=t.dir==='up', pc=t.profit>=0?'#22c55e':'#ef4444';
      return '<div class="trow">'
        +'<span style="color:var(--text3)">#'+(d.trades-i)+'</span>'
        +'<span style="color:var(--text2);font-size:10px">'+t.strategy+'</span>'
        +'<span>'+b(up?'b-up':'b-dn',up?'▲':'▼')+'</span>'
        +'<span style="color:var(--amber)">$'+t.stake+'</span>'
        +'<span style="color:'+pc+';font-weight:700">'+(t.profit>=0?'+':'')+'$'+Math.abs(t.profit).toFixed(2)+'</span>'
        +'</div>';
    }).join('');
    document.getElementById('trCnt').textContent=d.trades+' trades';
  }

  // Logs
  if(d.recentLogs&&d.recentLogs.length>0){
    document.getElementById('logArea').innerHTML=d.recentLogs.slice(0,50).map(l=>{
      return '<div class="logline"><span class="lt">'+l.time+'</span><span class="l-'+l.type+'">'+l.msg+'</span></div>';
    }).join('');
    document.getElementById('logCnt').textContent=d.recentLogs.length+' events';
  }
}

function poll(){
  fetch('/api/state')
    .then(r=>r.json()).then(update)
    .catch(()=>{ document.getElementById('sPill').textContent='OFFLINE'; });
}

initCharts();
poll();
setInterval(poll,2000);

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
</script>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────
//  HTTP SERVER
// ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(HTML);

  } else if (req.url === '/api/state') {
    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({
      running      : !S.stopped,
      stopped      : S.stopped,
      demo         : CONFIG.DEMO_MODE,
      instrument   : CONFIG.INSTRUMENT,
      balance      : S.balance,
      startBalance : S.startBalance,
      drawdown     : drawdownPct(),
      wins         : S.wins,
      losses       : S.losses,
      trades       : S.trades,
      inTrade      : S.inTrade,
      uptime       : Math.floor((Date.now()-S.sessionStart)/1000),
      nextResetIn,
      reconnects   : S.reconnects,
      lastPrice    : S.lastPrice,
      priceHistory : S.priceHistory.slice(-80),
      equityHistory: S.equityHistory,
      recentLogs   : S.recentLogs,
      recentTrades : S.recentTrades,
      currentSignal: S.currentSignal,
      indicators   : S.indicators,
      baseStake    : CONFIG.BASE_STAKE,
      maxDD        : CONFIG.MAX_DAILY_DD,
      dailyTarget  : CONFIG.DAILY_TARGET,
      martingale   : CONFIG.MARTINGALE,
      martiMult    : CONFIG.MARTI_MULT,
      dailyResets  : S.dailyResets,
    }));

  } else if (req.url === '/manifest.json') {
    res.writeHead(200, {'Content-Type':'application/manifest+json'});
    res.end(JSON.stringify({
      name:'Deriv EA Bot', short_name:'EA Bot',
      description:'Deriv Boom & Crash automated trading bot',
      start_url:'/', display:'standalone',
      background_color:'#080f1a', theme_color:'#080f1a',
      icons:[
        {src:'/icon.svg', sizes:'192x192', type:'image/svg+xml', purpose:'any maskable'},
        {src:'/icon.svg', sizes:'512x512', type:'image/svg+xml', purpose:'any maskable'},
      ],
    }));

  } else if (req.url === '/sw.js') {
    res.writeHead(200, {'Content-Type':'application/javascript'});
    res.end(`
const CACHE='ea-bot-v1';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.add('/')));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.url.includes('/api/')) return;
  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));return r;}).catch(()=>caches.match(e.request)));
});`);

  } else if (req.url === '/icon.svg') {
    res.writeHead(200, {'Content-Type':'image/svg+xml'});
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
<rect width="192" height="192" rx="36" fill="#080f1a"/>
<rect x="8" y="8" width="176" height="176" rx="30" fill="#0d1829" stroke="#1a2d45" stroke-width="1.5"/>
<path d="M108 22 L58 104 L90 104 L82 170 L134 88 L102 88 Z" fill="#60a5fa"/>
<rect x="28" y="148" width="8" height="22" rx="2" fill="#22c55e" opacity=".8"/>
<rect x="44" y="155" width="8" height="15" rx="2" fill="#ef4444" opacity=".8"/>
<rect x="60" y="143" width="8" height="27" rx="2" fill="#22c55e" opacity=".8"/>
<rect x="76" y="150" width="8" height="20" rx="2" fill="#22c55e" opacity=".8"/>
<rect x="92" y="158" width="8" height="12" rx="2" fill="#ef4444" opacity=".8"/>
<rect x="108" y="142" width="8" height="28" rx="2" fill="#22c55e" opacity=".8"/>
<rect x="124" y="151" width="8" height="19" rx="2" fill="#22c55e" opacity=".8"/>
<rect x="140" y="147" width="8" height="23" rx="2" fill="#ef4444" opacity=".8"/>
<rect x="156" y="139" width="8" height="31" rx="2" fill="#22c55e" opacity=".8"/>
</svg>`);

  } else {
    res.writeHead(404); res.end('Not found');
  }
});

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

startBot();
