'use strict';

const element = id => document.getElementById(id);
const number = value => typeof value === 'number' && Number.isFinite(value);
const text = (id, value) => { element(id).textContent = value; };
const numeric = (value, decimals = 2) => number(value) ? value.toFixed(decimals) : '—';
const money = value => number(value) ? `$${Math.abs(value).toFixed(2)}` : '—';
const signedMoney = value => number(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}` : '—';

let tickCount = 80;
let latest = null;
let failureCount = 0;
let settingsDirty = false;
let controlBusy = false;

function renderChart(prices) {
  const svg = element('price-chart');
  const points = Array.isArray(prices) ? prices.filter(number).slice(-tickCount) : [];
  const grid = element('chart-grid');

  if (!grid.childNodes.length) {
    for (let i = 1; i < 6; i++) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', '780');
      line.setAttribute('y1', String(i * 45)); line.setAttribute('y2', String(i * 45));
      grid.appendChild(line);
    }
    for (let i = 1; i < 9; i++) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(i * 78)); line.setAttribute('x2', String(i * 78));
      line.setAttribute('y1', '0'); line.setAttribute('y2', '270');
      grid.appendChild(line);
    }
  }

  const isEmpty = points.length < 2;
  element('chart-empty').hidden = !isEmpty;
  if (isEmpty) {
    element('chart-line').setAttribute('d', '');
    element('chart-area').setAttribute('d', '');
    text('chart-high', '—'); text('chart-mid', '—'); text('chart-low', '—');
    return;
  }

  const lo = Math.min(...points), hi = Math.max(...points);
  const pad = Math.max((hi - lo) * .13, Math.abs(hi) * .00001, .00001);
  const bottom = lo - pad, top = hi + pad;
  const coordinates = points.map((value, index) => [
    index / (points.length - 1) * 780,
    245 - ((value - bottom) / (top - bottom)) * 220,
  ]);
  const path = coordinates.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  element('chart-line').setAttribute('d', path);
  element('chart-area').setAttribute('d', `${path} L780,270 L0,270 Z`);
  text('chart-high', numeric(top)); text('chart-mid', numeric((top + bottom) / 2)); text('chart-low', numeric(bottom));
  svg.setAttribute('aria-label', `Price history of ${points.length} reported ticks, latest ${numeric(points.at(-1))}`);
}

function setBar(name, value, label) {
  text(name, label);
  const width = number(value) ? Math.max(0, Math.min(100, value)) : 0;
  element(`${name}-bar`).style.width = `${width}%`;
}

function showControlMessage(message, isError = false) {
  const node = element('control-message');
  node.textContent = message || '';
  node.classList.toggle('error', isError);
}

function fillSettings(data) {
  const instruments = Array.isArray(data.allowedInstruments) && data.allowedInstruments.length
    ? data.allowedInstruments : ['BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000'];
  const select = element('instrument-input');

  const existing = Array.from(select.options).map(o => o.value);
  if (existing.join('|') !== instruments.join('|')) {
    select.replaceChildren();
    for (const instrument of instruments) {
      const option = document.createElement('option');
      option.value = instrument;
      option.textContent = instrument;
      select.append(option);
    }
  }

  select.value = data.instrument || instruments[0];
  element('stake-input').value = number(data.baseStake) ? data.baseStake.toFixed(2) : '0.35';
  element('dd-input').value = number(data.maxDD) ? data.maxDD.toFixed(1) : '10';
  element('target-input').value = number(data.dailyTarget) ? data.dailyTarget.toFixed(1) : '15';
}

function renderControls(data) {
  const enabled = data.controlsEnabled === true && data.executionEnabled === false;
  const controls = ['instrument-input', 'stake-input', 'dd-input', 'target-input', 'reset-settings', 'apply-settings', 'toggle-monitor'];

  controls.forEach(id => { element(id).disabled = !enabled || controlBusy; });
  text('control-mode-label', enabled ? 'DEMO CONTROLS' : 'LOCKED');
  text('control-hint', enabled
    ? 'Controls affect demo scanning and in-memory settings only. Buy/sell/order execution is not implemented.'
    : 'Demo controls are locked. No order endpoint is enabled.');

  const toggle = element('toggle-monitor');
  toggle.textContent = data.monitoringActive ? 'STOP SCANNING' : 'START SCANNING';

  if (!settingsDirty) fillSettings(data);
}

function render(data) {
  latest = data;
  failureCount = 0;

  const status = element('connection');
  status.classList.toggle('online', data.connected);
  status.replaceChildren();
  const dot = document.createElement('i'); dot.className = 'status-dot'; status.append(dot);

  const statusText = data.controlsEnabled
    ? data.connected ? (data.monitoringActive ? ' DEMO SCANNING' : ' DEMO PAUSED') : ' DEMO DISCONNECTED'
    : data.connected ? ' DEMO READ-ONLY' : ' DEMO DISCONNECTED';
  status.append(document.createTextNode(statusText));

  text('account-mode', data.accountType || 'UNKNOWN');
  text('mode-title', data.controlsEnabled ? 'Deriv demo control sandbox:' : 'Deriv demo read-only monitor:');
  text('mode-summary', data.controlsEnabled
    ? 'Live demo telemetry is connected. Start/stop and settings affect the demo scanner only.'
    : 'Live demo balance and market telemetry are connected; controls are locked.');
  text('feed-note', 'Order execution remains disabled.');

  text('balance', money(data.balance));
  text('pnl', signedMoney(data.dailyPnl));
  element('pnl').className = number(data.dailyPnl) ? data.dailyPnl < 0 ? 'negative' : 'positive' : '';
  text('drawdown', number(data.drawdown) ? `${numeric(data.drawdown, 1)}%` : '—');
  text('trades', number(data.trades) ? String(data.trades) : '0');
  text('win-rate', data.trades > 0 ? `${numeric(data.wins / data.trades * 100, 0)}%` : '—');
  text('streak', number(data.consecutiveLoss) && data.consecutiveLoss > 0 ? `${data.consecutiveLoss} losses` : data.trades > 0 ? '0' : '—');

  const instrument = data.instrument || '—';
  text('instrument-chart', instrument);
  text('price', numeric(data.lastPrice));
  renderChart(data.priceHistory);

  const ind = data.indicators || {};
  setBar('rsi', ind.rsi, numeric(ind.rsi, 1));
  setBar('stoch', ind.stochRsi, numeric(ind.stochRsi, 1));
  setBar('ema', ind.emaSignal === 'up' ? 80 : ind.emaSignal === 'down' ? 20 : null, ind.emaSignal === 'up' ? 'Bullish' : ind.emaSignal === 'down' ? 'Bearish' : '—');
  setBar('macd', number(ind.macd) ? ind.macd > 0 ? 74 : 26 : null, number(ind.macd) ? numeric(ind.macd, 4) : '—');
  setBar('squeeze', ind.squeeze === true ? 95 : ind.squeeze === false ? 25 : null, ind.squeeze === null ? '—' : ind.squeeze ? 'Yes' : 'No');
  setBar('spike', ind.spike === true ? 95 : ind.spike === false ? 20 : null, ind.spike === null ? '—' : ind.spike ? 'Detected' : 'None');

  text('active-signal', data.monitoringActive
    ? data.currentSignal ? `${data.currentSignal.strategy} · ${data.currentSignal.dir.toUpperCase()}` : 'No signal reported'
    : 'Scanner paused');

  text('trade-source', data.tradeSource || 'ORDER EXECUTION DISABLED');
  const list = element('trade-list'); list.replaceChildren();
  if (!Array.isArray(data.recentTrades) || !data.recentTrades.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-trades';
    empty.textContent = 'No trades reported. Demo order execution is disabled in this phase.';
    list.append(empty);
  } else {
    for (const trade of data.recentTrades) {
      const row = document.createElement('div'); row.className = 'trade-row';
      const values = [trade.strategy, trade.dir.toUpperCase(), money(trade.stake), signedMoney(trade.profit)];
      values.forEach((value, i) => {
        const span = document.createElement('span');
        span.textContent = value;
        if (i === 3) span.className = number(trade.profit) && trade.profit < 0 ? 'negative' : 'positive';
        row.append(span);
      });
      list.append(row);
    }
  }

  renderControls(data);

  const date = new Date(data.observedAt);
  text('updated', Number.isNaN(date.getTime()) ? 'Updated' : `Updated ${date.toLocaleTimeString()}`);
}

async function postControl(payload) {
  controlBusy = true;
  if (latest) renderControls(latest);
  showControlMessage('Applying…');

  try {
    const response = await fetch('/api/dashboard/control', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      window.location.assign('/login');
      return false;
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);

    settingsDirty = false;
    showControlMessage('Applied successfully.');
    await poll();
    return true;
  } catch (error) {
    showControlMessage(error.message || 'Control request failed.', true);
    return false;
  } finally {
    controlBusy = false;
    if (latest) renderControls(latest);
  }
}

async function poll() {
  try {
    const response = await fetch('/api/dashboard/state', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { window.location.assign('/login'); return; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch {
    failureCount++;
    element('connection').classList.remove('online');
    text('connection', failureCount > 1 ? 'CONNECTION LOST' : 'RETRYING');
    text('feed-note', 'Dashboard is not receiving data. The last values shown may be stale.');
    text('updated', 'STALE · Last successful update retained');
  }
}

['instrument-input', 'stake-input', 'dd-input', 'target-input'].forEach(id => {
  element(id).addEventListener('input', () => { settingsDirty = true; showControlMessage(''); });
  element(id).addEventListener('change', () => { settingsDirty = true; showControlMessage(''); });
});

element('reset-settings').addEventListener('click', () => {
  settingsDirty = false;
  showControlMessage('');
  if (latest) fillSettings(latest);
});

element('apply-settings').addEventListener('click', async () => {
  const payload = {
    action: 'update-config',
    instrument: element('instrument-input').value,
    baseStake: Number(element('stake-input').value),
    maxDD: Number(element('dd-input').value),
    dailyTarget: Number(element('target-input').value),
  };
  await postControl(payload);
});

element('toggle-monitor').addEventListener('click', async () => {
  if (!latest) return;
  await postControl({ action: latest.monitoringActive ? 'stop' : 'start' });
});

document.querySelectorAll('[data-ticks]').forEach(button => button.addEventListener('click', () => {
  tickCount = Number(button.dataset.ticks);
  document.querySelectorAll('[data-ticks]').forEach(x => {
    const selected = x === button;
    x.classList.toggle('active', selected);
    x.setAttribute('aria-pressed', String(selected));
  });
  if (latest) renderChart(latest.priceHistory);
}));

element('logout').addEventListener('click', async () => {
  try { await fetch('/api/dashboard/logout', { method: 'POST', credentials: 'same-origin' }); }
  finally { window.location.assign('/login'); }
});

poll();
setInterval(poll, 3000);
