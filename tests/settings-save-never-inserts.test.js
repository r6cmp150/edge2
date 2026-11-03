// tests/settings-save-never-inserts.test.js — 2026-11-02. The settings save
// used to re-read the newest row id and INSERT a fresh row when that read
// came back empty. Row-level security answers a denied read with an EMPTY
// list, not an error, so one flaky read plus any Settings tap would have
// written the in-memory values (after an empty load, the DEFAULTS: budget
// 500, sub-$2 hidden, macro overlay on) as the newest row, and every later
// load, ordered by id, would have returned them for good. The rule: a
// settings save never inserts on the strength of an empty read. It updates
// the row the load read, must get that row back, and otherwise refuses,
// changing nothing, with a message that says to reload.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

// Loads the real core/store.js against a fake supabase client that records
// every call, so the test sees exactly what the save sends.
function load({ loadRow, updateReturns = rows => rows, updateError = null } = {}) {
  const calls = [];
  const chain = (table, verb, payload) => {
    const q = { table, verb, payload, filters: [], selected: null };
    calls.push(q);
    const api = {
      select(cols) { q.selected = cols; return api; },
      order() { return api; }, limit() { return api; },
      eq(col, val) { q.filters.push([col, val]); return api; },
      maybeSingle: async () => ({ data: loadRow ?? null, error: null }),
      then(res, rej) {
        if (verb === 'update') return Promise.resolve(updateError ? { data: null, error: updateError } : { data: updateReturns([{ id: q.filters[0]?.[1] }]), error: null }).then(res, rej);
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      },
    };
    return api;
  };
  const client = {
    from: table => ({
      select: cols => chain(table, 'select').select(cols),
      update: row => chain(table, 'update', row),
      insert: rows => chain(table, 'insert', rows),
      delete: () => chain(table, 'delete'),
    }),
  };
  const c = { console, JSON, Date, Math, Object, Array, String, Promise, Error, localStorage: { getItem: () => null, setItem() {} },
    window: { supabase: { createClient: () => client } }, state: { settings: {} } };
  vm.createContext(c);
  vm.runInContext(readSource('core/store.js') + '\n;globalThis.__s = { loadSettingsFromSupabase, saveSettingsToSupabase };', c);
  return { s: c.__s, calls };
}
const ROMAN = { id: 3, budget: 1500, include_under2: true, show_watch: true, min_volume: 100000, force_pre_market_mode: false, disable_macro_overlay: true };
const SETTINGS = { budget: 1500, includeUnder2: true, showWatch: true, minVolume: 100000, forcePreMarketMode: false, disableMacroOverlay: true };
const inserts = calls => calls.filter(q => q.verb === 'insert');

run('a loaded row: the save updates exactly that row and must get it back', async () => {
  const { s, calls } = load({ loadRow: ROMAN });
  await s.loadSettingsFromSupabase();
  await s.saveSettingsToSupabase(SETTINGS);
  const u = calls.filter(q => q.verb === 'update');
  assert.strictEqual(u.length, 1);
  assert.deepStrictEqual(u[0].filters, [['id', 3]], 'updates the row the load read');
  assert.ok(u[0].selected, 'reads the updated row back');
  assert.strictEqual(inserts(calls).length, 0);
});

run('an EMPTY load (no row, or a denied read): the save refuses, inserts nothing, and says to reload', async () => {
  const { s, calls } = load({ loadRow: null });
  assert.strictEqual(await s.loadSettingsFromSupabase(), null);
  await assert.rejects(s.saveSettingsToSupabase({ budget: 500 }), e => /NOT saved/.test(e.message) && /Nothing was changed/.test(e.message) && /Reload the app/.test(e.message));
  assert.strictEqual(inserts(calls).length, 0, 'never conjures a row');
  assert.strictEqual(calls.filter(q => q.verb === 'update').length, 0, 'and writes nothing at all');
});

run('the update comes back with no row (denied read-back, or the row is gone): refuses, never inserts', async () => {
  const { s, calls } = load({ loadRow: ROMAN, updateReturns: () => [] });
  await s.loadSettingsFromSupabase();
  await assert.rejects(s.saveSettingsToSupabase(SETTINGS), e => /NOT saved/.test(e.message) && /Reload the app/.test(e.message));
  assert.strictEqual(inserts(calls).length, 0);
});

run('a real update error is surfaced as itself, and still never becomes an insert', async () => {
  const { s, calls } = load({ loadRow: ROMAN, updateError: { code: '42501', message: 'permission denied' } });
  await s.loadSettingsFromSupabase();
  await assert.rejects(s.saveSettingsToSupabase(SETTINGS), e => e.code === '42501');
  assert.strictEqual(inserts(calls).length, 0);
});

run('no code path in store.js inserts into settings', () => {
  const src = readSource('core/store.js').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  for (const m of src.matchAll(/\.from\('settings'\)/g)) {
    const stmt = src.slice(m.index, m.index + 20000).split(';')[0];
    assert.ok(!/\.(insert|upsert)\(/.test(stmt), `settings insert/upsert found: ${stmt.slice(0, 120)}`);
  }
});
