'use strict';

// DERIV_MULTIPLIER_ENTRYPOINT_ROUTER_V1_4B
// Railway staging has intermittently launched this historical probe entrypoint
// even when the effective deployment command points at multiplier execution.
// Route explicitly by mutually exclusive environment mode without weakening
// the execution module's own demo-only safety gates.
if (process.env.MULTIPLIER_EXECUTION_TEST === 'true') {
  if (process.env.MULTIPLIER_PROBE_ONLY === 'true') {
    throw new Error('Multiplier execution and probe modes cannot both be enabled.');
  }
  require('./demo-multiplier-execution');
} else {
const WebSocket = require('ws');
const https = require('node:https');
const http = require('node:http');
const {
  PROBE_STAKE,
  PROBE_MULTIPLIERS,
  PROBE_RISK_PROFILES,
  INSTRUMENTS,
  MULTIPLIER_TYPES,
  assertDemoWebSocketUrl,
  assertProposalOnlyRequest,
  buildMultiplierProposal,
} = require('./demo-multiplier-probe-safety');

if (process.env.STAGING_DASHBOARD_ONLY !== 'true') throw new Error('STAGING_DASHBOARD_ONLY=true is required.');
if (process.env.MULTIPLIER_PROBE_ONLY !== 'true') throw new Error('MULTIPLIER_PROBE_ONLY=true is required.');
if (!process.env.DERIV_DEMO_API_TOKEN) throw new Error('DERIV_DEMO_API_TOKEN is required.');
if (!process.env.DERIV_APP_ID) throw new Error('DERIV_APP_ID is required.');
if (process.env.DERIV_API_TOKEN) throw new Error('DERIV_API_TOKEN must not exist in proposal-probe staging.');

const TOKEN = process.env.DERIV_DEMO_API_TOKEN;
const APP_ID = process.env.DERIV_APP_ID;
const PORT = Number(process.env.PORT || 8080);

const state = {
  status: 'starting',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  executionEnabled: false,
  buyImplemented: false,
  results: {},
  error: null,
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
  if (!demo || !demo.account_id) throw new Error('No Deriv demo Options account found. Live-account fallback is forbidden.');
  return demo.account_id;
}

async function getDemoWebSocketUrl(accountId) {
  const result = await apiRequest('POST', '/trading/v1/options/accounts/' + encodeURIComponent(accountId) + '/otp');
  return assertDemoWebSocketUrl(result && result.data && result.data.url);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveSymbols(list) {
  const out = {};
  for (const instrument of INSTRUMENTS) {
    const wanted = normalize(instrument);
    const match = (Array.isArray(list) ? list : []).find(item => {
      const name = item.underlying_symbol_name || item.display_name || '';
      const symbol = item.underlying_symbol || item.symbol || '';
      return symbol && (normalize(name).includes(wanted) || normalize(symbol) === wanted);
    });
    if (!match) throw new Error('Unable to resolve ' + instrument + ' from active symbols.');
    out[instrument] = match.underlying_symbol || match.symbol;
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runProbe(ws) {
  let reqId = 1;
  const pending = new Map();

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.req_id && pending.has(msg.req_id)) {
      const entry = pending.get(msg.req_id);
      pending.delete(msg.req_id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  });

  function request(payload) {
    assertProposalOnlyRequest(payload);
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('Demo WebSocket disconnected.'));
      const id = reqId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Deriv proposal probe timeout.'));
      }, 12000);
      pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  const active = await request({ active_symbols: 'brief' });
  if (active.error) throw new Error('active_symbols failed: ' + active.error.message);
  const symbols = resolveSymbols(active.active_symbols);

  for (const instrument of INSTRUMENTS) {
    const symbol = symbols[instrument];
    const contractReply = await request({ contracts_for: symbol });
    if (contractReply.error) throw new Error(instrument + ' contracts_for failed: ' + contractReply.error.message);

    const available = Array.isArray(contractReply.contracts_for && contractReply.contracts_for.available)
      ? contractReply.contracts_for.available : [];
    const advertised = available
      .filter(row => MULTIPLIER_TYPES.includes(String(row.contract_type || '').toUpperCase()))
      .map(row => ({
        contractType: String(row.contract_type || '').toUpperCase(),
        sentiment: String(row.sentiment || ''),
        category: String(row.contract_category || ''),
      }));

    const result = {
      underlyingSymbol: symbol,
      advertised,
      factors: { MULTUP: [], MULTDOWN: [] },
      riskProfiles: { MULTUP: [], MULTDOWN: [] },
    };
    state.results[instrument] = result;

    console.log('MULTIPLIER PROBE symbol:', instrument, '(' + symbol + ')');
    console.log('MULTIPLIER PROBE advertised:', JSON.stringify(advertised));

    for (const contractType of MULTIPLIER_TYPES) {
      for (const multiplier of PROBE_MULTIPLIERS) {
        const reply = await request(buildMultiplierProposal({ symbol, contractType, multiplier }));

        if (reply.error) {
          console.log('MULTIPLIER PROBE rejected:', instrument, contractType, 'x' + multiplier, '-', reply.error.message || reply.error.code || 'unknown');
        } else {
          const proposal = reply.proposal || {};
          result.factors[contractType].push({
            multiplier,
            askPrice: Number.isFinite(Number(proposal.ask_price)) ? Number(proposal.ask_price) : null,
          });
          console.log('MULTIPLIER PROBE accepted:', instrument, contractType, 'x' + multiplier);
        }
        await sleep(250);
      }

      const firstAccepted = result.factors[contractType][0];
      if (!firstAccepted) continue;

      for (const profile of PROBE_RISK_PROFILES) {
        if (profile.name === 'none') {
          result.riskProfiles[contractType].push({ name: profile.name, multiplier: firstAccepted.multiplier, accepted: true });
          continue;
        }

        const reply = await request(buildMultiplierProposal({
          symbol,
          contractType,
          multiplier: firstAccepted.multiplier,
          limitOrder: profile.limit_order,
        }));

        const accepted = !reply.error;
        const error = accepted ? null : String(reply.error.message || reply.error.code || 'unknown').slice(0, 160);
        result.riskProfiles[contractType].push({
          name: profile.name,
          multiplier: firstAccepted.multiplier,
          accepted,
          error,
        });

        console.log(
          accepted ? 'MULTIPLIER RISK accepted:' : 'MULTIPLIER RISK rejected:',
          instrument,
          contractType,
          'x' + firstAccepted.multiplier,
          profile.name,
          accepted ? '' : '- ' + error
        );
        await sleep(250);
      }
    }
  }
}

async function startProbe() {
  state.status = 'connecting';
  try {
    const accountId = await getDemoAccount();
    const url = await getDemoWebSocketUrl(accountId);
    const ws = new WebSocket(url);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Demo WebSocket connection timeout.')), 15000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', error => { clearTimeout(timer); reject(error); });
    });

    console.log('DERIV MULTIPLIER PROPOSAL PROBE connected to demo. BUY/SELL execution is not implemented.');
    state.status = 'probing';
    await runProbe(ws);
    state.status = 'complete';
    state.finishedAt = new Date().toISOString();
    console.log('MULTIPLIER PROBE COMPLETE:', JSON.stringify(state.results));
    try { ws.close(); } catch {}
  } catch (error) {
    state.status = 'failed';
    state.error = String(error && error.message || error).slice(0, 300);
    state.finishedAt = new Date().toISOString();
    console.error('MULTIPLIER PROBE FAILED:', state.error);
  }
}

function safeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function renderHtml() {
  const rows = INSTRUMENTS.map(instrument => {
    const item = state.results[instrument];
    if (!item) return `<tr><td>${instrument}</td><td colspan="4">Waitingâ€¦</td></tr>`;
    const up = item.factors.MULTUP.map(x => 'x' + x.multiplier).join(', ') || 'none';
    const down = item.factors.MULTDOWN.map(x => 'x' + x.multiplier).join(', ') || 'none';
    const upRisk = item.riskProfiles.MULTUP.filter(x => x.accepted).map(x => x.name).join(', ') || 'none';
    const downRisk = item.riskProfiles.MULTDOWN.filter(x => x.accepted).map(x => x.name).join(', ') || 'none';
    return `<tr><td>${instrument}</td><td>${safeHtml(up)}</td><td>${safeHtml(down)}</td><td>${safeHtml(upRisk)}</td><td>${safeHtml(downRisk)}</td></tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DERIV Multiplier Probe</title><style>
body{font-family:system-ui;background:#071426;color:#e7f0ff;margin:0;padding:24px}main{max-width:1050px;margin:auto}
.card{background:#102846;border:1px solid #2b4e73;border-radius:14px;padding:20px;margin:14px 0}
h1{margin:0 0 8px}p{color:#bdd0e7}.safe{color:#47e0b8;font-weight:700}.warn{color:#ffd36a}
table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #2b4e73;text-align:left;font-size:14px}
small{color:#91aac7}</style></head><body><main>
<h1>DERIV EA BOT â€” V1.4A MULTIPLIER PROBE</h1>
<p class="safe">PROPOSAL ONLY â€” BUY/SELL EXECUTION IS NOT IMPLEMENTED.</p>
<div class="card"><strong>Status:</strong> ${safeHtml(state.status.toUpperCase())}<br>
<small>Stake used for proposal pricing: $${PROBE_STAKE.toFixed(2)} Â· Demo account only.</small>
${state.error ? `<p class="warn">${safeHtml(state.error)}</p>` : ''}</div>
<div class="card"><table><thead><tr><th>Instrument</th><th>MULTUP factors</th><th>MULTDOWN factors</th><th>UP risk profiles</th><th>DOWN risk profiles</th></tr></thead><tbody>${rows}</tbody></table></div>
<p><small>Refresh to see updated probe results. No contract purchase endpoint exists in this probe service.</small></p>
</main></body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, status: state.status, executionEnabled: false }));
  }
  if (req.url === '/probe') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state));
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderHtml());
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('DERIV MULTIPLIER PROPOSAL PROBE listening on ' + PORT);
  console.log('PROPOSAL ONLY. BUY/SELL execution is not implemented.');
  startProbe();
});
}
