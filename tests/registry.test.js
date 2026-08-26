// tests/registry.test.js — shell/registry.js. docs/warrior-engine-spec-v2.md
// Phase 2. The registry is the ONLY dispatch mechanism into engine code —
// this proves the basic contract (register/get round-trip, unregistered id
// returns null rather than throwing) that everything else in Phase 2
// depends on.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadRegistry() {
  const src = readSource('shell/registry.js');
  const exposeCode = 'global.__registerEngine = registerEngine; global.__getEngine = getEngine;';
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return { registerEngine: global.__registerEngine, getEngine: global.__getEngine };
}

async function testRegisterAndGetRoundTrip() {
  const { registerEngine, getEngine } = loadRegistry();
  const registration = {
    label: 'Warrior',
    renderTab: () => '<div>tab</div>',
    renderBadge: () => '<span>badge</span>',
    renderSnapshot: () => '<div>snapshot</div>',
    evaluateExit: () => ({ status: 'HOLD', reasons: [] }),
    summarizeForReport: () => 'stub',
  };
  registerEngine('WARRIOR', registration);
  const got = getEngine('WARRIOR');
  console.log('getEngine returned the same registration object:', got === registration);
  assert.strictEqual(got, registration, 'getEngine did not return the exact object passed to registerEngine');
}

async function testUnregisteredIdReturnsNull() {
  const { getEngine } = loadRegistry();
  const got = getEngine('WARRIOR');
  console.log('getEngine for an unregistered id:', got);
  assert.strictEqual(got, null, 'getEngine should return null (not undefined, not throw) for an id nothing registered');
}

async function testRegistryHasNoBuiltInKnowledgeOfEngineIds() {
  // The registry must not special-case 'WARRIOR' or 'EDGE' — it's a plain
  // key-value store. Any id round-trips identically; that's what "shell
  // never branches on engine id" actually rests on downstream.
  const { registerEngine, getEngine } = loadRegistry();
  registerEngine('SOME_FUTURE_ENGINE', { label: 'Whatever' });
  const got = getEngine('SOME_FUTURE_ENGINE');
  assert.strictEqual(got.label, 'Whatever');
  assert.strictEqual(getEngine('WARRIOR'), null, 'registering one id must not affect lookups for a different, unregistered id');
}

(async () => {
  await run('registry: register/get round-trip returns the exact registration object', testRegisterAndGetRoundTrip);
  await run('registry: unregistered id returns null, not undefined or a throw', testUnregisteredIdReturnsNull);
  await run('registry: no built-in knowledge of specific engine ids', testRegistryHasNoBuiltInKnowledgeOfEngineIds);
})();
