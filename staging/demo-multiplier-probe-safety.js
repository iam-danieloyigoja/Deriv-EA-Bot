'use strict';

const PROBE_STAKE = 1.00;
const PROBE_MULTIPLIERS = Object.freeze([10, 20, 50, 100, 200, 500]);
const PROBE_RISK_PROFILES = Object.freeze([
  Object.freeze({ name: 'none', limit_order: null }),
  Object.freeze({ name: 'stop-0.10', limit_order: Object.freeze({ stop_loss: 0.10 }) }),
  Object.freeze({ name: 'take-0.10', limit_order: Object.freeze({ take_profit: 0.10 }) }),
  Object.freeze({ name: 'both-0.10', limit_order: Object.freeze({ stop_loss: 0.10, take_profit: 0.10 }) }),
]);
const INSTRUMENTS = Object.freeze(['BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000']);
const MULTIPLIER_TYPES = Object.freeze(['MULTUP', 'MULTDOWN']);

function assertDemoWebSocketUrl(url) {
  if (typeof url !== 'string' || !/\/trading\/v1\/options\/ws\/demo\?otp=/.test(url)) {
    throw new Error('Demo WebSocket URL required. Live-account connection refused.');
  }
  return url;
}

function assertProposalOnlyRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid probe request.');
  }

  const forbidden = ['buy','sell','cancel','contract_update','proposal_open_contract','authorize','logout','cashier'];
  if (forbidden.some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('Execution request blocked in multiplier proposal-probe mode.');
  }

  const primaries = ['active_symbols','contracts_for','proposal','ping']
    .filter(key => Object.prototype.hasOwnProperty.call(payload, key));

  if (primaries.length !== 1) {
    throw new Error('Exactly one proposal-probe request type is required.');
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'proposal')) {
    if (payload.proposal !== 1) throw new Error('Invalid proposal probe.');
    if (payload.amount !== PROBE_STAKE) throw new Error("Probe stake is locked to Deriv's observed minimum.");
    if (payload.basis !== 'stake') throw new Error('Proposal basis must be stake.');
    if (!MULTIPLIER_TYPES.includes(payload.contract_type)) throw new Error('Only multiplier contracts may be probed.');
    if (payload.currency !== 'USD') throw new Error('Probe currency must be USD.');
    if (payload.duration_unit !== 's') throw new Error('Multiplier probe duration_unit must be seconds.');
    if (!PROBE_MULTIPLIERS.includes(payload.multiplier)) throw new Error('Unapproved multiplier probe factor.');
    if (typeof payload.underlying_symbol !== 'string' || !payload.underlying_symbol) throw new Error('Underlying symbol is required.');

    if (payload.limit_order !== undefined) {
      const limit = payload.limit_order;
      if (!limit || typeof limit !== 'object' || Array.isArray(limit)) throw new Error('Invalid probe limit order.');
      const keys = Object.keys(limit);
      if (!keys.length || keys.some(key => !['stop_loss','take_profit'].includes(key))) throw new Error('Invalid probe limit order.');
      for (const value of Object.values(limit)) {
        if (value !== 0.10) throw new Error('Probe limit-order amount is locked to 0.10.');
      }
    }
  }
  return payload;
}

function buildMultiplierProposal({ symbol, contractType, multiplier, limitOrder = null }) {
  const payload = {
    proposal: 1,
    amount: PROBE_STAKE,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    duration_unit: 's',
    multiplier,
    underlying_symbol: symbol,
  };
  if (limitOrder) payload.limit_order = { ...limitOrder };
  return assertProposalOnlyRequest(payload);
}

module.exports = {
  PROBE_STAKE,
  PROBE_MULTIPLIERS,
  PROBE_RISK_PROFILES,
  INSTRUMENTS,
  MULTIPLIER_TYPES,
  assertDemoWebSocketUrl,
  assertProposalOnlyRequest,
  buildMultiplierProposal,
};
