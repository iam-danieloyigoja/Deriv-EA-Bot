'use strict';

const MAX_DEMO_TRADES = 3;
const TEST_STAKE = 1.00;
const TEST_MULTIPLIER = 100;
const STOP_LOSS = 0.10;
const TAKE_PROFIT = 0.10;
const MAX_SESSION_LOSS = 0.30;

const ALLOWED_INSTRUMENTS = Object.freeze(['BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000']);
const MULTIPLIER_TYPES = Object.freeze(new Set(['MULTUP', 'MULTDOWN']));

function assertDemoWebSocketUrl(url) {
  if (typeof url !== 'string' || !/\/trading\/v1\/options\/ws\/demo\?otp=/.test(url)) {
    throw new Error('Demo WebSocket URL required. Live-account connection refused.');
  }
  return url;
}

function normalizeTestStake(value) {
  const stake = Number(value);
  if (!Number.isFinite(stake) || Math.abs(stake - TEST_STAKE) > 1e-9) {
    throw new Error(`Final multiplier demo stake is locked at ${TEST_STAKE.toFixed(2)}.`);
  }
  return TEST_STAKE;
}

function selectMultiplierContracts(available) {
  const result = { up: null, down: null, compatible: [], observed: [] };

  for (const row of Array.isArray(available) ? available : []) {
    const type = String(row && row.contract_type || '').toUpperCase();
    const sentiment = String(row && row.sentiment || '').toLowerCase();
    const category = String(row && row.contract_category || '').toLowerCase();

    if (type) result.observed.push({ type, sentiment, category });

    if (!MULTIPLIER_TYPES.has(type)) continue;
    if (category !== 'multiplier') continue;
    if (sentiment !== 'up' && sentiment !== 'down') continue;

    result.compatible.push({ type, sentiment, category });
    if (!result[sentiment]) result[sentiment] = type;
  }

  return result;
}

function buildMultiplierProposal({ symbol, contractType }) {
  return assertAllowedDemoRequest({
    proposal: 1,
    amount: TEST_STAKE,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    duration_unit: 's',
    multiplier: TEST_MULTIPLIER,
    limit_order: {
      stop_loss: STOP_LOSS,
      take_profit: TAKE_PROFIT,
    },
    underlying_symbol: symbol,
  });
}

function assertAllowedDemoRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Deriv request.');
  }

  const forbidden = ['sell', 'cancel', 'contract_update', 'authorize', 'logout', 'cashier'];
  if (forbidden.some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('Blocked Deriv request in final multiplier demo mode.');
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
      throw new Error('Blocked invalid contracts_for request.');
    }
  }

  if (primary === 'proposal') {
    const limit = payload.limit_order;
    if (
      payload.proposal !== 1 ||
      Number(payload.amount) !== TEST_STAKE ||
      payload.basis !== 'stake' ||
      !MULTIPLIER_TYPES.has(payload.contract_type) ||
      payload.currency !== 'USD' ||
      payload.duration_unit !== 's' ||
      Object.prototype.hasOwnProperty.call(payload, 'duration') ||
      Number(payload.multiplier) !== TEST_MULTIPLIER ||
      !limit ||
      Number(limit.stop_loss) !== STOP_LOSS ||
      Number(limit.take_profit) !== TAKE_PROFIT ||
      Object.keys(limit).some(key => !['stop_loss', 'take_profit'].includes(key)) ||
      typeof payload.underlying_symbol !== 'string' ||
      !payload.underlying_symbol
    ) {
      throw new Error('Blocked invalid multiplier proposal request.');
    }
  }

  if (primary === 'buy') {
    const price = Number(payload.price);
    if (
      typeof payload.buy !== 'string' ||
      !payload.buy ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price > TEST_STAKE ||
      Object.prototype.hasOwnProperty.call(payload, 'parameters')
    ) {
      throw new Error('Blocked invalid buy request.');
    }
  }

  if (primary === 'proposal_open_contract') {
    const id = Number(payload.contract_id);
    if (
      payload.proposal_open_contract !== 1 ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      payload.subscribe !== 1
    ) {
      throw new Error('Blocked invalid open-contract subscription request.');
    }
  }

  return payload;
}

module.exports = {
  MAX_DEMO_TRADES,
  TEST_STAKE,
  TEST_MULTIPLIER,
  STOP_LOSS,
  TAKE_PROFIT,
  MAX_SESSION_LOSS,
  ALLOWED_INSTRUMENTS,
  MULTIPLIER_TYPES,
  assertDemoWebSocketUrl,
  normalizeTestStake,
  selectMultiplierContracts,
  buildMultiplierProposal,
  assertAllowedDemoRequest,
};
