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
  assert.throws(() => normalizeTestStake(100), /between/);
});

test('only a Deriv demo websocket URL is accepted', () => {
  const demo = 'wss://ws.derivws.com/trading/v1/options/ws/demo?otp=example';
  assert.equal(assertDemoWebSocketUrl(demo), demo);

  assert.throws(
    () => assertDemoWebSocketUrl('wss://ws.derivws.com/trading/v1/options/ws/real?otp=example'),
    /Demo WebSocket URL required/
  );
});

test('proposal discovery is bounded to an approved duration allowlist', () => {
  assert.ok(PROPOSAL_DURATIONS.length > 1);
  assert.ok(PROPOSAL_DURATIONS.length <= 8);
  assert.equal(isAllowedDuration(5, 't'), true);
  assert.equal(isAllowedDuration(10, 't'), true);
  assert.equal(isAllowedDuration(1, 'm'), true);
  assert.equal(isAllowedDuration(60, 'm'), false);
  assert.equal(isAllowedDuration(1, 'h'), false);
});

test('request gate permits proposal-id demo purchase lifecycle across approved durations', () => {
  for (const candidate of PROPOSAL_DURATIONS) {
    assert.doesNotThrow(() => assertAllowedDemoRequest({
      proposal: 1,
      amount: .35,
      basis: 'stake',
      contract_type: 'CALL',
      currency: 'USD',
      duration: candidate.duration,
      duration_unit: candidate.duration_unit,
      underlying_symbol: 'BOOM500',
    }));
  }

  assert.doesNotThrow(() => assertAllowedDemoRequest({
    buy: 'safe-demo-proposal-id',
    price: .35,
  }));

  assert.doesNotThrow(() => assertAllowedDemoRequest({
    proposal_open_contract: 1,
    contract_id: 123,
    subscribe: 1,
  }));

  assert.throws(
    () => assertAllowedDemoRequest({
      proposal: 1,
      amount: .35,
      basis: 'stake',
      contract_type: 'CALL',
      currency: 'USD',
      duration: 60,
      duration_unit: 'm',
      underlying_symbol: 'BOOM500',
    }),
    /Blocked invalid proposal request/
  );

  assert.throws(
    () => assertAllowedDemoRequest({
      buy: 1,
      price: .35,
      parameters: { basis: 'stake' },
    }),
    /Blocked invalid buy request/
  );

  assert.throws(() => assertAllowedDemoRequest({ sell: 123 }), /Blocked Deriv request/);
  assert.throws(() => assertAllowedDemoRequest({ cashier: 'payments' }), /Blocked Deriv request/);
  assert.throws(() => assertAllowedDemoRequest({ authorize: 'token' }), /Blocked Deriv request/);
});
