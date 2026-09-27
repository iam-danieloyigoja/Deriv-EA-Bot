'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('probe entrypoint safely routes execution mode before probe guard', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../staging/demo-multiplier-probe.js'),
    'utf8'
  );

  const marker = source.indexOf('DERIV_MULTIPLIER_ENTRYPOINT_ROUTER_V1_4B');
  const executionRoute = source.indexOf("require('./demo-multiplier-execution')");
  const probeGuard = source.indexOf("MULTIPLIER_PROBE_ONLY !== 'true'");

  assert.ok(marker >= 0, 'entrypoint router marker missing');
  assert.ok(executionRoute > marker, 'execution router require missing');
  assert.ok(probeGuard > executionRoute, 'probe guard must remain inside probe-only branch');
  assert.match(source, /MULTIPLIER_EXECUTION_TEST === 'true'/);
  assert.match(source, /cannot both be enabled/);
});
