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

function render(data) {
  latest = data;
  failureCount = 0;
  const status = element('connection');
  status.classList.toggle('online', data.connected);
  status.replaceChildren(); // API strings are never interpreted as HTML
  const dot = document.createElement('i'); dot.className = 'status-dot'; status.append(dot);
  status.append(document.createTextNode(data.testOnly ? ' TEST ONLY' : !data.connected ? ' DISCONNECTED' : data.running ? ' BOT RUNNING' : ' BOT STOPPED'));
  text('account-mode', data.accountType || 'UNKNOWN');
  text('feed-note', data.testOnly
    ? 'Isolated demo-only market monitoring: trade execution and simulated trade results are both disabled.'
    : data.accountType === 'SIMULATION'
      ? 'Simulation mode: bot.js may generate results that are not Deriv demo-account transactions.'
      : 'Real-account mode reported. This dashboard remains read-only.');
  text('balance', money(data.balance));
  text('pnl', signedMoney(data.dailyPnl));
  element('pnl').className = number(data.dailyPnl) ? data.dailyPnl < 0 ? 'negative' : 'positive' : '';
  text('drawdown', number(data.drawdown) ? `${numeric(data.drawdown, 1)}%` : '—');
  text('trades', number(data.trades) ? String(data.trades) : '—');
  text('win-rate', data.trades > 0 ? `${numeric(data.wins / data.trades * 100, 0)}%` : '—');
  text('streak', number(data.consecutiveLoss) && data.consecutiveLoss > 0 ? `${data.consecutiveLoss} losses` : data.trades > 0 ? '0' : '—');
  const instrument = data.instrument || '—';
  text('instrument-chart', instrument);
  text('instrument-setting', instrument);
  text('stake-setting', money(data.baseStake));
  text('dd-setting', number(data.maxDD) ? `${numeric(data.maxDD, 1)}%` : '—');
  text('target-setting', number(data.dailyTarget) ? `${numeric(data.dailyTarget, 1)}%` : '—');
  text('price', numeric(data.lastPrice));
  renderChart(data.priceHistory);
  const ind = data.indicators || {};
  setBar('rsi', ind.rsi, numeric(ind.rsi, 1));
  setBar('stoch', ind.stochRsi, numeric(ind.stochRsi, 1));
  setBar('ema', ind.emaSignal === 'up' ? 80 : ind.emaSignal === 'down' ? 20 : null, ind.emaSignal === 'up' ? 'Bullish' : ind.emaSignal === 'down' ? 'Bearish' : '—');
  setBar('macd', number(ind.macd) ? ind.macd > 0 ? 74 : 26 : null, number(ind.macd) ? numeric(ind.macd, 4) : '—');
  setBar('squeeze', ind.squeeze === true ? 95 : ind.squeeze === false ? 25 : null, ind.squeeze === null ? '—' : ind.squeeze ? 'Yes' : 'No');
  setBar('spike', ind.spike === true ? 95 : ind.spike === false ? 20 : null, ind.spike === null ? '—' : ind.spike ? 'Detected' : 'None');
  text('active-signal', data.currentSignal ? `${data.currentSignal.strategy} · ${data.currentSignal.dir.toUpperCase()}` : 'No signal reported');
  text('trade-source', data.tradeSource || 'BOT REPORTED');
  const list = element('trade-list'); list.replaceChildren();
  if (!Array.isArray(data.recentTrades) || !data.recentTrades.length) {
    const empty = document.createElement('div'); empty.className = 'empty-trades'; empty.textContent = 'No trades reported yet.'; list.append(empty);
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
  const date = new Date(data.observedAt);
  text('updated', Number.isNaN(date.getTime()) ? 'Updated' : `Updated ${date.toLocaleTimeString()}`);
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
