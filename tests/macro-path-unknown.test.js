// tests/macro-path-unknown.test.js -- 2026-11-14. From (c), 0c60fbf (2026-11-12), until this fix, macroPathColumn wrote
// 'unknown' for "no reading attached" and then refused 'unknown' when handed it back: it passed it to checkedMacroPath,
// whose list does not hold it. 'unknown' is the column DEFAULT, so every position from before db/038 was loaded back
// holding it. Every position save and every sale of such a position threw on the phone before anything was sent: all
// 6 open positions, and the GRNT and VG sales queued on Roman's phone. Retry failed identically. The suite passed
// because no test ever handed the writer a value it had itself written.
// Held here in both directions, against the database's own CHECKs (db/live-columns.json, captured from production):
// every value a column accepts, the app accepts; a value no column accepts, the app refuses; what the writer writes,
// it accepts again. And the real load -> save round trip of a pre-db/038 position.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, columnValidatorsSrc } = require('./_lib');

const store = readSource('core/store.js');
const fn = name => { const i = store.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return store.slice(i, store.indexOf('\n}\n', i) + 3); };
const ctx = { JSON, Object, Array, String, Number, Math, Date };
vm.createContext(ctx);
vm.runInContext(columnValidatorsSrc() + fn('mapSupabasePortfolioRowToPosition') + fn('mapPositionToSupabaseRow')
  + ';globalThis.__col = macroPathColumn; globalThis.__load = mapSupabasePortfolioRowToPosition; globalThis.__save = mapPositionToSupabaseRow;', ctx);

const checks = JSON.parse(readSource('db/live-columns.json')).checks;
// checks: { table: { constraint_name: 'CHECK (...)' } }
const allowed = name => {
  const def = Object.values(checks).map(t => t && t[name]).find(Boolean);
  assert.ok(def, `${name}: no captured CHECK`);
  return [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]);
};
const COLUMNS = ['portfolio_macro_path_at_buy_check', 'trades_v2_macro_path_check', 'rating_snapshots_macro_path_check'];

run('every value each macro-path column accepts, the app accepts as itself; a value none accepts, it refuses', () => {
  for (const c of COLUMNS) {
    const vals = allowed(c);
    assert.ok(vals.includes('unknown') && vals.length >= 6, `${c}: read ${vals.join(',')}`);
    for (const v of vals) assert.strictEqual(ctx.__col(v), v, `${c} accepts ${v}; the app must write it unchanged`);
  }
  for (const bad of ['sideways', '', 'UNKNOWN', 'Unknown', 0]) assert.throws(() => ctx.__col(bad), /not a macro path/, JSON.stringify(bad));
});

run('what the writer writes, it accepts again', () => {
  for (const v of [null, undefined, 'unknown', 'groq', 'pattern']) {
    const once = ctx.__col(v);
    assert.strictEqual(ctx.__col(once), once, `${JSON.stringify(v)} -> ${once} -> must pass again`);
  }
});

run('a position from before db/038 loads, and saves back, without throwing', () => {
  // The shape PostgREST returns for one of Roman's six open positions (2026-11-14 read): macro_path_at_buy 'unknown'.
  const pos = ctx.__load({ position_id: '1793633798712', ticker: 'CLRO', buy_price: 6.21, shares: 100, buy_date: '2026-11-02', macro_path_at_buy: 'unknown' });
  assert.strictEqual(pos.macroPathAtBuy, 'unknown');
  const row = ctx.__save(pos);
  assert.strictEqual(row.macro_path_at_buy, 'unknown');
});

run('the sale insert writes the position\'s path through the same function', () => {
  const app = readSource('app.js');
  assert.ok(app.includes('      macro_path: macroPathColumn(pos.macroPathAtBuy),'), 'trades_v2.macro_path goes through macroPathColumn, which the cases above hold');
});
