// tests/warrior-degradation.test.js — app.js's loadWarriorEngine().
// docs/warrior-engine-spec-v2.md Phase 2 acceptance items 1 and 3: deleting
// engines/warrior/index.js entirely, and a syntax error inside it, must
// both produce the same result (app still loads, Warrior tab shows
// "unavailable"). Both failure modes reach loadWarriorEngine() identically
// — as a rejected import() promise — which is exactly why this test can
// verify both with the same mechanism rather than needing two different
// test setups.
//
// Extracts the REAL loadWarriorEngine() from app.js and only replaces the
// literal `await import('./engines/warrior/index.js')` expression with an
// injectable mock — the try/catch and state-update logic under test is the
// actual production code, not a reimplementation of it. A real dynamic
// import() can't be meaningfully mocked from a Node/eval context anyway
// (its module resolution semantics don't match this being a browser-only
// app), so this is the direct analogue of mocking alpacaGet elsewhere in
// this suite while testing the real surrounding logic.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const appSrc = readSource('app.js');

function loadWarriorEngineWithMockImport(mockImportFn) {
  const re = /async function loadWarriorEngine\(\) \{[\s\S]*?\n\}/m;
  const m = appSrc.match(re);
  if (!m) throw new Error('could not extract loadWarriorEngine from app.js');
  const patched = m[0].replace("await import('./engines/warrior/index.js')", 'await __mockImport()');

  global.state = {};
  global.__mockImport = mockImportFn;
  const warnings = [];
  global.console = { ...console, warn: (...args) => warnings.push(args.join(' ')) };

  const exposeCode = 'global.__loadWarriorEngine = loadWarriorEngine;';
  // eslint-disable-next-line no-eval
  eval(patched + '\n' + exposeCode);
  return { loadWarriorEngine: global.__loadWarriorEngine, warnings };
}

async function testMissingModuleDegradesGracefully() {
  // Real shape of a 404 dynamic-import failure in a browser.
  const rejection = new TypeError("Failed to fetch dynamically imported module: https://example.com/engines/warrior/index.js");
  const { loadWarriorEngine, warnings } = loadWarriorEngineWithMockImport(() => Promise.reject(rejection));

  await loadWarriorEngine(); // must not throw past this call
  console.log('state.warrior after missing-module failure:', global.state.warrior);
  console.log('console.warn called:', warnings.length > 0);

  assert.strictEqual(global.state.warrior.status, 'unavailable');
  assert.strictEqual(global.state.warrior.error, rejection.message, 'the REAL error message must be preserved, not a generic one');
  assert.ok(warnings.length > 0, 'expected a console.warn for visibility, per "never fails silently"');
}

async function testSyntaxErrorModuleDegradesTheSameWay() {
  // Real shape of an ES module syntax error surfacing through import().
  const rejection = new SyntaxError("Unexpected token '}'");
  const { loadWarriorEngine, warnings } = loadWarriorEngineWithMockImport(() => Promise.reject(rejection));

  await loadWarriorEngine();
  console.log('state.warrior after syntax-error-module failure:', global.state.warrior);

  assert.strictEqual(global.state.warrior.status, 'unavailable', 'a syntax error must produce the SAME degraded state shape as a missing module — that\'s the acceptance requirement ("same result")');
  assert.strictEqual(global.state.warrior.error, rejection.message);
  assert.ok(warnings.length > 0);
}

async function testSuccessfulLoadSetsLoadedStatus() {
  // Positive control — proves the test setup can distinguish success from
  // failure, not just that failures look alike.
  let registerCalled = false;
  const { loadWarriorEngine } = loadWarriorEngineWithMockImport(() => Promise.resolve({ register: () => { registerCalled = true; } }));

  await loadWarriorEngine();
  console.log('state.warrior after successful load:', global.state.warrior, '| register() called:', registerCalled);

  assert.strictEqual(global.state.warrior.status, 'loaded');
  assert.strictEqual(global.state.warrior.error, undefined);
  assert.ok(registerCalled, 'register() on the resolved module must actually be called');
}

(async () => {
  await run('warrior-degradation: missing module -> unavailable with real error, no throw', testMissingModuleDegradesGracefully);
  await run('warrior-degradation: syntax-error module -> same degraded shape as missing module', testSyntaxErrorModuleDegradesTheSameWay);
  await run('warrior-degradation: successful import -> loaded status (positive control)', testSuccessfulLoadSetsLoadedStatus);
})();
