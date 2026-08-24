// tests/_lib.js — shared plumbing for the plain-node test scripts in this
// directory. No framework: each test file is runnable standalone via
// `node tests/<name>.js`, uses Node's built-in assert module, and exits
// non-zero on failure. This file only removes literal duplication of the
// "read a core/*.js file and eval it with mocked globals" pattern every
// test needs — it has no discovery, no runner, no assertion DSL of its own.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Reads a file relative to the repo root (e.g. 'core/market-data.js').
function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// Evals `src` with the given globals present, then exposes the listed
// top-level const/let bindings onto `global` so the calling test can
// reference them afterward. Necessary because direct eval() in Node scopes
// let/const to the eval call itself — only function declarations leak out
// in sloppy mode — so bindings that need to survive past this call must be
// named explicitly. `mocks` are assigned onto `global` before the eval so
// the source can reference them as ambient globals (matching how these
// files actually run in the browser, as classic scripts sharing one global
// scope).
function evalModule(src, { mocks = {}, expose = [] } = {}) {
  for (const [name, value] of Object.entries(mocks)) {
    global[name] = value;
  }
  const exposeStatements = expose.map(name => `global.${name} = ${name};`).join(' ');
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeStatements);
}

// Minimal pass/fail runner: runs an async fn, prints PASS/FAIL, sets
// process.exitCode so `node tests/x.js` is a valid CI-style check without
// needing a framework to interpret its output.
async function run(name, fn) {
  try {
    await fn();
    console.log(`\nPASS: ${name}`);
  } catch (e) {
    console.error(`\nFAIL: ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

module.exports = { readSource, evalModule, run, REPO_ROOT };
