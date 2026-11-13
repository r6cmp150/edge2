// tests/persist-failure-text.test.js -- 2026-11-13. "Storage full? Free up space, then reload." was on Roman's phone, in
// red, while he held ten positions. A person reads that as "clear this site's data", which destroys the only copy of
// tier-2 measured state (the peak RSI of open positions, written onto their sale records), and freeing space on the
// phone does nothing for a per-site quota anyway. The detail now depends on the failed key's tier. This holds every
// key in core/store.js's PERSIST_TIER to it.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, persistFailureDetailSrc } = require('./_lib');

const store = readSource('core/store.js');
const i = store.indexOf('const PERSIST_TIER = {');
const j = store.indexOf('const persistTier = ');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(store.slice(i, store.indexOf('\n', j) + 1) + persistFailureDetailSrc() + '\n;globalThis.__d = persistFailureDetail; globalThis.__keys = Object.keys(PERSIST_TIER); globalThis.__tier = persistTier; globalThis.__never = NEVER_CLEAR;', ctx);
const keys = ctx.__keys;

run('no failed-save text, for any key, suggests freeing space, reloading as a fix, or clearing data; every one says never to clear it', () => {
  assert.ok(keys.length >= 20, `read ${keys.length} keys`);
  for (const k of keys) {
    const t = ctx.__d(k);
    assert.ok(!/free up space|then reload|storage full\?/i.test(t), `${k}: ${t}`);
    assert.ok(t.includes(ctx.__never), `${k}: must carry the never-clear sentence`);
    assert.ok(/peak RSI of open positions is kept only on this phone/.test(t), k);
    // (the reviewer, from s1) the one instruction that matters is its own paragraph, never after "no action is needed"
    assert.ok(t.endsWith(`<br><br>${ctx.__never}`), `${k}: the never-clear sentence opens its own paragraph, last`);
    // (the reviewer) a tier-2 body names the thing in Roman's words; the key stays in the banner's title
    if (ctx.__tier(k) === 2) assert.ok(!t.includes(k), `${k}: a variable name in the body: ${t}`);
    else assert.ok(t.includes(k), `${k}: names the key`);
  }
});

// The tier-4 text once said "nothing more important is unsaved (it would be named here instead)". It came out
// (2026-11-13): the failure record is a single slot, so a queue failure can be replaced by another queue's and then
// cleared by that one's later save, leaving the first unsaved and unnamed (measured; STATUS, Open). A failure message
// carries no reassurance a test cannot hold.
run('no text promises that nothing more important is unsaved', () => {
  for (const k of keys) assert.ok(!/nothing more important|would be named here/i.test(ctx.__d(k)), k);
});

run('each tier says what is actually safe for that tier', () => {
  const byTier = t => keys.filter(k => ctx.__tier(k) === t);
  for (const k of byTier(4)) {
    const t = ctx.__d(k);
    assert.ok(/Nothing recorded in the database is affected/.test(t) && /No action is needed for this cache/.test(t), `${k}: ${t}`);
  }
  for (const k of byTier(1)) assert.ok(/has not reached the database/.test(ctx.__d(k)) && /use Retry on its line here before closing or reloading/.test(ctx.__d(k)), k);
  for (const k of byTier(2)) assert.ok(/kept nowhere else/.test(ctx.__d(k)) && /do not close or reload the app/.test(ctx.__d(k)), k);
  for (const k of byTier(3)) assert.ok(/a reload may lose this change/.test(ctx.__d(k)) && !/No action is needed/.test(ctx.__d(k)), k);
  assert.deepStrictEqual([1, 2, 3, 4].map(t => byTier(t).length > 0), [true, true, true, true], 'every tier has keys, so every branch is exercised');
});

run('the banner uses it; the old text is gone from the app', () => {
  const app = readSource('app.js');
  assert.ok(app.includes("add('var(--red)', `Save failed — ${state.persistFailure.key}`, persistFailureDetail(state.persistFailure.key));"), 'the banner line calls persistFailureDetail');
  const code = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'); // the comment quoting the old text is not text Roman sees
  assert.ok(!/Free up space|then reload/i.test(code), 'the old remedy is gone from every string the app can show');
});
