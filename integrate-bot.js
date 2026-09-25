'use strict';

// Offline, manual integration helper. --check only verifies anchors and security guards.
// --apply patches a local bot.js only; it never uses GitHub or Railway APIs.
const fs = require('node:fs');
const path = require('node:path');
const fileFlag = process.argv.indexOf('--file');
const target = path.resolve(fileFlag >= 0 ? process.argv[fileFlag + 1] || 'bot.js' : 'bot.js');
const apply = process.argv.includes('--apply');
if (!fs.existsSync(target)) {
  console.error('Cannot find bot.js. Run this from the root of your cloned bot repository or use --file PATH.');
  process.exit(1);
}
let source = fs.readFileSync(target, 'utf8');
if (source.includes('createDashboardHandler(')) {
  console.error('This bot.js appears to be integrated already. No changes made.');
  process.exit(1);
}

function once(oldText, replacement, name) {
  const start = source.indexOf(oldText);
  if (start < 0 || source.indexOf(oldText, start + oldText.length) >= 0) {
    throw new Error(`Cannot safely locate a unique ${name} anchor; your bot.js may differ. No changes made.`);
  }
  source = source.slice(0, start) + replacement + source.slice(start + oldText.length);
}
function replaceOne(pattern, replacement, name) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))];
  if (matches.length !== 1) throw new Error(`Expected one ${name} anchor, found ${matches.length}. No changes made.`);
  source = source.replace(pattern, replacement);
}

try {
  const original = source;
  once("const chalk     = require('chalk');", "const chalk     = require('chalk');\nconst { createDashboardHandler } = require('./dashboard/server');", 'require');
  replaceOne(/^(\s*DERIV_API_TOKEN\s*:\s*)process\.env\.DERIV_API_TOKEN\s*\|\|\s*(['"])[^'"\r\n]+\2\s*,/m,
    '$1process.env.DERIV_API_TOKEN,', 'hardcoded token');
  // Fail closed. This package cannot be used to operate a live trading service.
  once('const SYMBOL_MAP = {', `if (process.env.DASHBOARD_TEST_ONLY !== 'true' || CONFIG.DEMO_MODE !== true) {\n  throw new Error('Integration package requires DASHBOARD_TEST_ONLY=true and DEMO_MODE=true on an isolated test service.');\n}\n\nconst SYMBOL_MAP = {`, 'symbol map');
  once('function placeTrade(signal){', `function placeTrade(signal){\n  // Test-mode safety guard: never simulate or submit a buy order.\n  if (process.env.DASHBOARD_TEST_ONLY === 'true') return;`, 'trade execution');
  once('const id=account.account_id||account.id||account.loginid;', `if (process.env.DASHBOARD_TEST_ONLY === 'true' &&\n      (!account || !(account.account_type==='demo' || account.is_virtual || account.type==='demo'))) {\n    throw new Error('A Deriv demo account was not found. Monitor-only connection refused.');\n  }\n  const id=account.account_id||account.id||account.loginid;`, 'account selection');
  const htmlStart = source.indexOf('const HTML = `');
  const serverStart = source.indexOf('const server = http.createServer((req, res) => {');
  const listenStart = source.indexOf('server.listen(CONFIG.PORT, () => {', serverStart);
  if (htmlStart < 0 || serverStart < htmlStart || listenStart < serverStart) {
    throw new Error('Cannot safely locate old HTML and HTTP server blocks. No changes made.');
  }
  source = source.slice(0, htmlStart) +
    '// Replacement dashboard is served from ./dashboard/ (authenticated + read-only).\n\n' +
    'const server = http.createServer(createDashboardHandler({ state: S, config: CONFIG }));\n\n' +
    source.slice(listenStart);
  replaceOne(/^startBot\(\);\s*$/m,
    "startBot(); // Market monitoring only: all order paths are blocked by the test-mode guard.", 'startup');
  if (source === original) throw new Error('No changes prepared');
  console.log('Preflight passed: old unauthenticated API removed, token fallback removed, demo-only startup enforced, trade execution guarded.');
  if (!apply) {
    console.log('Dry run only. No files changed. Use --apply only on a throwaway branch or isolated test-service copy.');
  } else {
    const temp = `${target}.integration-new`;
    if (fs.existsSync(temp)) throw new Error('A staging file exists; refusing to overwrite it.');
    try {
      fs.writeFileSync(temp, source, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, target);
    } catch (error) {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      throw error;
    }
    console.log('Local bot.js updated; no token-bearing backup, push, or deployment was created. Restore from your original Git commit if needed.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
