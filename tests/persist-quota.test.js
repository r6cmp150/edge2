// tests/persist-quota.test.js — core/store.js's persist(). Extracts just
// the function via regex (same technique tests/pagination-merge.test.js
// uses) rather than eval'ing the whole file, which would need a
// window.supabase mock this test has no reason to care about.
//
// 2026-09-04, found live while adding state.warriorPreMarketRvolObservations
// (an unbounded, persisted array): persist() backs EVERY persisted state
// field in the app and used to swallow ANY localStorage write failure
// silently, quota exhaustion included -- meaning a quota failure doesn't
// just drop the one field that pushed it over, every LATER persist() call
// for ANY key keeps failing the same way, silently, for the rest of the
// session. Fixed to set state.persistFailure (surfaced by
// updateMarketBanner, not tested here — that's app.js, a classic script
// with its own DOM dependencies) and clear it on the next successful call.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function extractPersistFn() {
  const src = readSource('core/store.js');
  const re = /function persist\(key\) \{[\s\S]*?\n\}/;
  const m = src.match(re);
  if (!m) throw new Error('could not extract persist() from core/store.js');
  return m[0];
}

function loadPersist({ localStorageImpl, updateMarketBannerCalls } = {}) {
  global.state = {};
  global.localStorage = localStorageImpl;
  global.updateMarketBanner = () => { if (updateMarketBannerCalls) updateMarketBannerCalls.push(1); };
  // eslint-disable-next-line no-eval
  eval(extractPersistFn() + '\nglobal.__persist = persist;');
  return global.__persist;
}

async function testPersistSucceedsAndClearsAPriorFailure() {
  const calls = [];
  const persist = loadPersist({
    localStorageImpl: { setItem: () => {} },
    updateMarketBannerCalls: calls,
  });
  global.state.foo = { a: 1 };
  global.state.persistFailure = { key: 'bar', message: 'stale failure from earlier', at: 'x' };
  persist('foo');
  console.log('persistFailure after a successful write:', global.state.persistFailure, '| banner calls:', calls.length);
  assert.strictEqual(global.state.persistFailure, null, 'a successful write must clear a stale failure flag');
  assert.strictEqual(calls.length, 1, 'banner must be told to refresh when the failure clears');
}

async function testPersistDoesNotTouchBannerOnRepeatedSuccess() {
  // No stale failure to clear -> no reason to touch the banner every single
  // successful persist() call (this function runs constantly).
  const calls = [];
  const persist = loadPersist({
    localStorageImpl: { setItem: () => {} },
    updateMarketBannerCalls: calls,
  });
  global.state.foo = { a: 1 };
  persist('foo');
  persist('foo');
  console.log('banner calls with no failure ever present:', calls.length);
  assert.strictEqual(calls.length, 0);
}

async function testPersistSurfacesQuotaFailureInsteadOfSwallowingIt() {
  const calls = [];
  const persist = loadPersist({
    localStorageImpl: { setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError'); } },
    updateMarketBannerCalls: calls,
  });
  global.state.warriorPreMarketRvolObservations = [{ big: 'data' }];
  persist('warriorPreMarketRvolObservations');
  console.log('persistFailure after a quota error:', global.state.persistFailure, '| banner calls:', calls.length);
  assert.ok(global.state.persistFailure, 'a write failure must be recorded, not silently swallowed');
  assert.strictEqual(global.state.persistFailure.key, 'warriorPreMarketRvolObservations');
  assert.ok(/quota/i.test(global.state.persistFailure.message));
  assert.ok(global.state.persistFailure.at, 'must record when the failure happened');
  assert.strictEqual(calls.length, 1, 'banner must be told to show the failure immediately, not on the next unrelated render');
}

async function testPersistSurvivesAConsecutiveDifferentKeyFailure() {
  // The whole point: ONE key's quota failure must not throw an uncaught
  // exception that would break the caller -- every OTHER key's persist()
  // call still has to run (and itself fail the same honest way) rather
  // than the app crashing on the first one.
  const calls = [];
  const persist = loadPersist({
    localStorageImpl: { setItem: () => { throw new Error('disk full'); } },
    updateMarketBannerCalls: calls,
  });
  global.state.a = 1;
  global.state.b = 2;
  assert.doesNotThrow(() => { persist('a'); persist('b'); }, 'a persist failure for one key must never throw out to the caller');
  assert.strictEqual(global.state.persistFailure.key, 'b', 'the flag reflects the most recent failure');
}

(async () => {
  await run('persist-quota: a successful write clears a stale failure flag', testPersistSucceedsAndClearsAPriorFailure);
  await run('persist-quota: no banner churn on repeated success with nothing to clear', testPersistDoesNotTouchBannerOnRepeatedSuccess);
  await run('persist-quota: a quota failure is surfaced, not silently swallowed', testPersistSurfacesQuotaFailureInsteadOfSwallowingIt);
  await run('persist-quota: a write failure never throws out to the caller', testPersistSurvivesAConsecutiveDifferentKeyFailure);
})();
