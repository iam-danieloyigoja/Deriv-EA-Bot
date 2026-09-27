'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_DEMO_TRADES,
  MIN_TEST_STAKE,
  MAX_TEST_STAKE,
  MAX_SESSION_LOSS,
  PROPOSAL_DURATIONS,
  assertDemoWebSocketUrl,
  normalizeTestStake,
  isAllowedDuration,
  selectDirectionalContracts,
  assertAllowedDemoRequest,
} = require('../staging/demo-execution-safety');

test('final demo hard limits cannot exceed acceptance-test bounds', () => {
  assert.equal(MAX_DEMO_TRADES, 3);
  assert.equal(MIN_TEST_STAKE, .35);
  assert.equal(MAX_TEST_STAKE, .5);
  assert.equal(MAX_SESSION_LOSS, 1.5);
  assert.equal(normalizeTestStake(.35), .35);
  assert.equal(normalizeTestStake(.5), .5);
  assert.throws(() => normalizeTestStake(.51), /between/);
});

test('only a Deriv demo websocket URL is accepted', () => {
  const demo = 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=example';
  assert.equal(assertDemoWebSocketUrl(demo), demo);
  assert.throws(
    () => assertDemoWebSocketUrl('wss://api.derivws.com/trading/v1/options/ws/real?otp=example'),
    /Demo WebSocket URL required/
  );
});

test('proposal discovery is bounded to an approved duration allowlist', () => {
  assert.ok(PROPOSAL_DURATIONS.length > 1);
  assert.ok(PROPOSAL_DURATIONS.length <= 8);
  assert.equal(isAllowedDuration(5, 't'), true);
  assert.equal(isAllowedDuration(1, 'm'), true);
  assert.equal(isAllowedDuration(60, 'm'), false);
});

test('contracts_for capability selection uses only advertised directional digital contracts', () => {
  const found = selectDirectionalContracts([
    { contract_type: 'PUT', sentiment: 'up', contract_category: 'callput' },
    { contract_type: 'CALL', sentiment: 'down', contract_category: 'callput' },
    { contract_type: 'MULTUP', sentiment: 'up', contract_category: 'multiplier' },
    { contract_type: 'MULTDOWN', sentiment: 'down', contract_category: 'multiplier' },
  ]);

  assert.equal(found.up, 'PUT');
  assert.equal(found.down, 'CALL');
  assert.equal(found.compatible.length, 2);

  const unsupported = selectDirectionalContracts([
    { contract_type: 'MULTUP', sentiment: 'up', contract_category: 'multiplier' },
    { contract_type: 'MULTDOWN', sentiment: 'down', contract_category: 'multiplier' },
  ]);

  assert.equal(unsupported.up, null);
  assert.equal(unsupported.down, null);
});

test('request gate permits contracts_for and proposal-id demo lifecycle only', () => {
  assert.doesNotThrow(() => assertAllowedDemoRequest({ contracts_for: 'BOOM500' }));

  assert.doesNotThrow(() => assertAllowedDemoRequest({
    proposal: 1,
    amount: .35,
    basis: 'stake',
    contract_type: 'PUT',
    currency: 'USD',
    duration: 5,
    duration_unit: 't',
    underlying_symbol: 'BOOM500',
  }));

  assert.doesNotThrow(() => assertAllowedDemoRequest({
    buy: 'safe-demo-proposal-id',
    price: .35,
  }));

  assert.throws(
    () => assertAllowedDemoRequest({
      proposal: 1,
      amount: .35,
      basis: 'stake',
      contract_type: 'MULTUP',
      currency: 'USD',
      duration: 5,
      duration_unit: 't',
      underlying_symbol: 'BOOM500',
    }),
    /Blocked invalid proposal request/
  );

  assert.throws(() => assertAllowedDemoRequest({ sell: 123 }), /Blocked Deriv request/);
});
