'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROBE_STAKE,
  PROBE_MULTIPLIERS,
  PROBE_RISK_PROFILES,
  INSTRUMENTS,
  assertDemoWebSocketUrl,
  assertProposalOnlyRequest,
  buildMultiplierProposal,
} = require('../staging/demo-multiplier-probe-safety');

test('multiplier probe scope is bounded', () => {
  assert.equal(PROBE_STAKE, 1.00);
  assert.deepEqual(INSTRUMENTS, ['BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000']);
  assert.deepEqual(PROBE_MULTIPLIERS, [10, 20, 50, 100, 200, 500]);
  assert.equal(PROBE_RISK_PROFILES.length, 4);
});

test('probe accepts only demo websocket URLs', () => {
  const url = 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=example';
  assert.equal(assertDemoWebSocketUrl(url), url);
  assert.throws(
    () => assertDemoWebSocketUrl('wss://api.derivws.com/trading/v1/options/ws/real?otp=example'),
    /Demo WebSocket URL required/
  );
});

test('proposal-only gate blocks all execution requests', () => {
  assert.throws(() => assertProposalOnlyRequest({ buy: 'id', price: .35 }), /Execution request blocked/);
  assert.throws(() => assertProposalOnlyRequest({ sell: 123 }), /Execution request blocked/);
  assert.throws(() => assertProposalOnlyRequest({ proposal_open_contract: 1 }), /Execution request blocked/);
  assert.throws(() => assertProposalOnlyRequest({ contract_update: 1 }), /Execution request blocked/);
});

test('multiplier proposal builder uses proposal shape without purchase fields', () => {
  const payload = buildMultiplierProposal({
    symbol: 'BOOM500',
    contractType: 'MULTUP',
    multiplier: 10,
    limitOrder: { stop_loss: .10, take_profit: .10 },
  });

  assert.equal(payload.proposal, 1);
  assert.equal(payload.amount, 1.00);
  assert.equal(payload.basis, 'stake');
  assert.equal(payload.contract_type, 'MULTUP');
  assert.equal(payload.currency, 'USD');
  assert.equal(payload.duration_unit, 's');
  assert.equal(payload.multiplier, 10);
  assert.equal(payload.underlying_symbol, 'BOOM500');
  assert.deepEqual(payload.limit_order, { stop_loss: .10, take_profit: .10 });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'buy'), false);
});

test('probe entrypoint contains no purchase request payload', () => {
  const source = fs.readFileSync(path.join(__dirname, '../staging/demo-multiplier-probe.js'), 'utf8');
  assert.equal(/\bbuy\s*:/.test(source), false);
  assert.equal(/\bsell\s*:/.test(source), false);
  assert.equal(/proposal_open_contract\s*:/.test(source), false);
});
