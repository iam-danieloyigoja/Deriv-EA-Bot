'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_DEMO_TRADES,
  TEST_STAKE,
  TEST_MULTIPLIER,
  STOP_LOSS,
  TAKE_PROFIT,
  MAX_SESSION_LOSS,
  ALLOWED_INSTRUMENTS,
  assertDemoWebSocketUrl,
  normalizeTestStake,
  selectMultiplierContracts,
  buildMultiplierProposal,
  assertAllowedDemoRequest,
} = require('../staging/demo-multiplier-execution-safety');

test('multiplier execution acceptance limits are hard locked', () => {
  assert.equal(MAX_DEMO_TRADES, 3);
  assert.equal(TEST_STAKE, 1);
  assert.equal(TEST_MULTIPLIER, 100);
  assert.equal(STOP_LOSS, .10);
  assert.equal(TAKE_PROFIT, .10);
  assert.equal(MAX_SESSION_LOSS, .30);
  assert.deepEqual(ALLOWED_INSTRUMENTS, ['BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000']);
  assert.equal(normalizeTestStake(1), 1);
  assert.throws(() => normalizeTestStake(.99), /locked/);
  assert.throws(() => normalizeTestStake(1.01), /locked/);
});

test('multiplier execution accepts only demo websocket URLs', () => {
  const demo = 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=example';
  assert.equal(assertDemoWebSocketUrl(demo), demo);
  assert.throws(
    () => assertDemoWebSocketUrl('wss://api.derivws.com/trading/v1/options/ws/real?otp=example'),
    /Demo WebSocket URL required/
  );
});

test('capability selector chooses only advertised multiplier up/down contracts', () => {
  const selected = selectMultiplierContracts([
    { contract_type: 'CALL', sentiment: 'up', contract_category: 'callput' },
    { contract_type: 'MULTUP', sentiment: 'up', contract_category: 'multiplier' },
    { contract_type: 'MULTDOWN', sentiment: 'down', contract_category: 'multiplier' },
  ]);
  assert.equal(selected.up, 'MULTUP');
  assert.equal(selected.down, 'MULTDOWN');
  assert.equal(selected.compatible.length, 2);
});

test('proposal builder is fixed to x100 with 0.10 stop loss and take profit', () => {
  const payload = buildMultiplierProposal({ symbol: 'BOOM500', contractType: 'MULTUP' });
  assert.equal(payload.amount, 1);
  assert.equal(payload.contract_type, 'MULTUP');
  assert.equal(payload.duration_unit, 's');
  assert.equal(payload.multiplier, 100);
  assert.deepEqual(payload.limit_order, { stop_loss: .10, take_profit: .10 });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'duration'), false);
});

test('request gate rejects altered multiplier risk parameters', () => {
  const valid = buildMultiplierProposal({ symbol: 'CRASH500', contractType: 'MULTDOWN' });
  assert.doesNotThrow(() => assertAllowedDemoRequest(valid));
  assert.throws(() => assertAllowedDemoRequest({ ...valid, multiplier: 200 }), /Blocked invalid multiplier proposal/);
  assert.throws(() => assertAllowedDemoRequest({ ...valid, amount: 2 }), /Blocked invalid multiplier proposal/);
  assert.throws(() => assertAllowedDemoRequest({
    ...valid, limit_order: { stop_loss: .20, take_profit: .10 }
  }), /Blocked invalid multiplier proposal/);
});

test('request gate permits proposal-id buy and monitoring but blocks manual exits and updates', () => {
  assert.doesNotThrow(() => assertAllowedDemoRequest({ buy: 'safe-demo-proposal-id', price: 1 }));
  assert.doesNotThrow(() => assertAllowedDemoRequest({
    proposal_open_contract: 1, contract_id: 123456789, subscribe: 1
  }));
  assert.throws(() => assertAllowedDemoRequest({ sell: 123456789 }), /Blocked Deriv request/);
  assert.throws(() => assertAllowedDemoRequest({ contract_update: 1 }), /Blocked Deriv request/);
  assert.throws(() => assertAllowedDemoRequest({ buy: 1, price: 1, parameters: {} }), /Blocked invalid buy/);
});
