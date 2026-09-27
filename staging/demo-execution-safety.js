'use strict';

const MAX_DEMO_TRADES = 3;
const MIN_TEST_STAKE = 0.35;
const MAX_TEST_STAKE = 0.50;
const MAX_SESSION_LOSS = 1.50;

const PROPOSAL_DURATIONS = Object.freeze([
  Object.freeze({ duration: 5, duration_unit: 't', label: '5 ticks' }),
  Object.freeze({ duration: 10, duration_unit: 't', label: '10 ticks' }),
  Object.freeze({ duration: 15, duration_unit: 't', label: '15 ticks' }),
  Object.freeze({ duration: 30, duration_unit: 't', label: '30 ticks' }),
  Object.freeze({ duration: 1, duration_unit: 'm', label: '1 minute' }),
  Object.freeze({ duration: 2, duration_unit: 'm', label: '2 minutes' }),
  Object.freeze({ duration: 5, duration_unit: 'm', label: '5 minutes' }),
]);

const SAFE_DIRECTIONAL_TYPES = Object.freeze(new Set(['CALL', 'PUT', 'CALLE', 'PUTE']));

function assertDemoWebSocketUrl(url) {
  if (typeof url !== 'string' || !/\/trading\/v1\/options\/ws\/demo\?otp=/.test(url)) {
    throw new Error('Demo WebSocket URL required. Live-account connection refused.');
  }
  return url;
}

function normalizeTestStake(value) {
  const stake = Number(value);
  if (!Number.isFinite(stake) || stake < MIN_TEST_STAKE || stake > MAX_TEST_STAKE) {
    throw new Error(`Demo stake must be between ${MIN_TEST_STAKE.toFixed(2)} and ${MAX_TEST_STAKE.toFixed(2)}.`);
  }
  return Math.round(stake * 100) / 100;
}

function isAllowedDuration(duration, durationUnit) {
  return PROPOSAL_DURATIONS.some(item =>
    item.duration === duration && item.duration_unit === durationUnit
  );
}

function selectDirectionalContracts(available) {
  const result = { up: null, down: null, compatible: [], observed: [] };

  for (const row of Array.isArray(available) ? available : []) {
    const type = String(row && row.contract_type || '').toUpperCase();
    const sentiment = String(row && row.sentiment || '').toLowerCase();
    const category = String(row && row.contract_category || '');

    if (type) result.observed.push({ type, sentiment, category });

    if (!SAFE_DIRECTIONAL_TYPES.has(type)) continue;
    if (sentiment !== 'up' && sentiment !== 'down') continue;

    result.compatible.push({ type, sentiment, category });

    if (!result[sentiment]) {
      result[sentiment] = type;
    }
  }

  return result;
}

function assertAllowedDemoRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Deriv request.');
  }

  const forbidden = ['sell', 'cancel', 'contract_update', 'authorize', 'logout', 'cashier'];
  if (forbidden.some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('Blocked Deriv request in final demo acceptance mode.');
  }

  const primaries = [
    'balance', 'ticks', 'active_symbols', 'contracts_for', 'ping',
    'proposal', 'buy', 'proposal_open_contract'
  ].filter(key => Object.prototype.hasOwnProperty.call(payload, key));

  if (primaries.length !== 1) {
    throw new Error('Exactly one approved Deriv request type is required.');
  }

  const primary = primaries[0];

  if (primary === 'contracts_for') {
    if (typeof payload.contracts_for !== 'string' || !/^\w{2,30}$/.test(payload.contracts_for)) {
      throw new Error('Blocked invalid contracts_for request in final demo acceptance mode.');
    }
  }

  if (primary === 'proposal') {
    const amount = Number(payload.amount);
    if (
      payload.proposal !== 1 ||
      !Number.isFinite(amount) ||
      amount < MIN_TEST_STAKE ||
      amount > MAX_TEST_STAKE ||
      payload.basis !== 'stake' ||
      !SAFE_DIRECTIONAL_TYPES.has(payload.contract_type) ||
      payload.currency !== 'USD' ||
      !isAllowedDuration(payload.duration, payload.duration_unit) ||
      typeof payload.underlying_symbol !== 'string' ||
      !payload.underlying_symbol
    ) {
      throw new Error('Blocked invalid proposal request in final demo acceptance mode.');
    }
  }

  if (primary === 'buy') {
    const price = Number(payload.price);
    if (
      typeof payload.buy !== 'string' ||
      !payload.buy ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price > MAX_TEST_STAKE ||
      Object.prototype.hasOwnProperty.call(payload, 'parameters')
    ) {
      throw new Error('Blocked invalid buy request in final demo acceptance mode.');
    }
  }

  return payload;
}

module.exports = {
  MAX_DEMO_TRADES,
  MIN_TEST_STAKE,
  MAX_TEST_STAKE,
  MAX_SESSION_LOSS,
  PROPOSAL_DURATIONS,
  SAFE_DIRECTIONAL_TYPES,
  assertDemoWebSocketUrl,
  normalizeTestStake,
  isAllowedDuration,
  selectDirectionalContracts,
  assertAllowedDemoRequest,
};
