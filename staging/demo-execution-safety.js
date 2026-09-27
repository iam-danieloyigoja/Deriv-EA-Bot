'use strict';

const MAX_DEMO_TRADES = 3;
const MIN_TEST_STAKE = 0.35;
const MAX_TEST_STAKE = 0.50;
const MAX_SESSION_LOSS = 1.50;

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

function assertAllowedDemoRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Deriv request.');
  }

  const forbidden = ['sell', 'cancel', 'contract_update', 'authorize', 'logout', 'cashier'];
  if (forbidden.some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('Blocked Deriv request in final demo acceptance mode.');
  }

  const primaries = ['balance', 'ticks', 'active_symbols', 'ping', 'proposal', 'buy', 'proposal_open_contract']
    .filter(key => Object.prototype.hasOwnProperty.call(payload, key));

  if (primaries.length !== 1) {
    throw new Error('Exactly one approved Deriv request type is required.');
  }

  const primary = primaries[0];

  if (primary === 'proposal') {
    const amount = Number(payload.amount);
    if (
      payload.proposal !== 1 ||
      !Number.isFinite(amount) ||
      amount < MIN_TEST_STAKE ||
      amount > MAX_TEST_STAKE ||
      payload.basis !== 'stake' ||
      !['CALL', 'PUT'].includes(payload.contract_type) ||
      payload.currency !== 'USD' ||
      payload.duration !== 5 ||
      payload.duration_unit !== 't' ||
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
  assertDemoWebSocketUrl,
  normalizeTestStake,
  assertAllowedDemoRequest,
};
