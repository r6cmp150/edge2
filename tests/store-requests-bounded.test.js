// tests/store-requests-bounded.test.js -- 2026-11-18 (the reviewer: "Every .from( in core/store.js goes through
// boundedRequest, or is declared with its reason. A test that lists them by name and fails on an undeclared one").
// No request had a timeout, so a hang held whatever awaited it for good (the sale card at "Recording sale…", boot at
// "Loading your data…", the re-read's in-flight flag). The enumeration (review-store-request-enumeration.md) found
// 14 requests in 10 functions. This holds that list: each request IDENTIFIED by its function, its table and its place
// within the pair, never counted, so a new request fails until it is bounded or declared, a replaced one does not
// inherit its predecessor's entry, and one converted without updating the registry fails too (in both directions).
// A PENDING entry is the remaining build order, held by the suite instead of in a note. When none is left, STATUS says
// "every request in the client is bounded", with the count.
'use strict';
const assert = require('assert');
const { readSource, run, enclosingFunctions } = require('./_lib');

const store = readSource('core/store.js');

// key: `${function} · ${table} · #${n}` (n counts within that function and table, in source order).
const BOUNDED = 'bounded';
const pending = (step, why) => ({ step, why });
const REGISTRY = {
  'loadPortfolioFromSupabase · portfolio · #1': BOUNDED,
  'loadPortfolioFromSupabase · trades_v2 · #1': BOUNDED,
  'deletePositionFromSupabase · portfolio · #1': BOUNDED,
  'deletePositionFromSupabase · portfolio · #2': BOUNDED,
  'loadSettingsFromSupabase · settings · #1': BOUNDED,
  'insertPositionToSupabase · portfolio · #1': pending(4, 'the Add: the form hangs with its button disabled; a write, so UNKNOWN on no answer'),
  'readExecutionMode · settings · #1': pending(4, 'the Add: the Live/Paper read before every buy is recorded (8 s)'),
  'writeExecutionMode · settings · #1': pending(5, 'the Live/Paper toggle never confirms'),
  'writeExecutionMode · execution_mode_changes · #1': pending(5, 'the toggle\'s change log, written with it'),
  'saveSettingsToSupabase · settings · #1': pending(5, 'a Settings save never confirms'),
  'savePositionToSupabase · portfolio · #1': pending(5, 'Mark filled never finishes (a tap); background peak saves never report'),
  'savePositionToSupabase · portfolio · #2': pending(5, 'the update\'s existence check, as the first'),
  'selectRatingSnapshotsByTickers · rating_snapshots · #1': pending(6, 'background: the cards\' "Earlier scans" line reads loading for good'),
  'insertSignalSnapshotAtBuy · signal_snapshot_at_buy · #1': pending(6, 'background: the snapshot outcome never reports; the Add is not held'),
};

function requests() {
  const re = /supabaseClient\s*\.from\(\s*'([a-z_0-9]+)'\s*\)/g;
  const fns = enclosingFunctions(store, re);
  const seen = {}, out = [];
  let i = 0;
  for (const m of store.matchAll(re)) {
    const pair = `${fns[i++]} · ${m[1]}`;
    seen[pair] = (seen[pair] || 0) + 1;
    out.push({ key: `${pair} · #${seen[pair]}`, bounded: /boundedRequest\(\s*$/.test(store.slice(Math.max(0, m.index - 40), m.index)) });
  }
  return out;
}

run('every request in core/store.js is found by the identifying search (no request made another way)', () => {
  // a .from( on another client, a variable table, or a request with no .from would escape the registry: there is none
  assert.strictEqual((store.match(/\.from\(/g) || []).length, requests().length, 'every .from( is a supabaseClient.from(\'<table>\')');
  assert.ok(!/supabaseClient\s*\.\s*(rpc|storage|functions|channel)\b/.test(store), 'no request outside .from');
});

run('each request is in the registry by name, and each entry is a request that exists', () => {
  const found = requests().map(r => r.key).sort();
  const declared = Object.keys(REGISTRY).sort();
  assert.deepStrictEqual(found.filter(k => !(k in REGISTRY)), [], 'a request not in the registry: bound it, or declare it with its reason');
  assert.deepStrictEqual(declared.filter(k => !found.includes(k)), [], 'a registry entry for a request that no longer exists');
});

run('an entry marked bounded goes through boundedRequest, and a pending one does not (both directions)', () => {
  for (const r of requests()) {
    const entry = REGISTRY[r.key];
    if (entry === BOUNDED) assert.ok(r.bounded, `${r.key}: declared bounded, but not passed to boundedRequest`);
    else {
      assert.ok(entry && typeof entry.why === 'string' && entry.why.length > 10 && Number.isInteger(entry.step), `${r.key}: a pending entry gives its reason and its step`);
      assert.ok(!r.bounded, `${r.key}: now bounded: mark it bounded in the registry`);
    }
  }
});

run('boundedRequest never throws: it is the one place a timeout is turned into an outcome', () => {
  const i = store.indexOf('async function boundedRequest(');
  const body = store.slice(i, store.indexOf('\n}\n', i));
  assert.ok(!/\bthrow\b/.test(body), 'no throw in the helper');
  assert.ok(/catch \(e\) \{ r = \{ thrown: e \}; \}/.test(body), 'a thrown request becomes a result');
});
