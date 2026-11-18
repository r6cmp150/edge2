// tests/sale-writer-db044.test.js -- 2026-11-14. The real writeTradeToSupabase, run against a stub client that captures
// the inserted row, for db/044's two rules at the sale:
//   - the peak RSI's provenance travels with it: a record this build computed says sampled_since (with when sampling
//     began) or not_sampled; a record an OLDER build computed and queued (a Retry) says not_established, never a guess;
//   - sale_code_version is the build that COMPUTED the record (stamped when the sale was entered), not the build that
//     writes it; a record with no stamp writes NULL ("not recorded": trades_v2's shape CHECK admits only that).
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, columnValidatorsSrc } = require('./_lib');

const app = readSource('app.js');
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
const grab = n => { const i = app.search(new RegExp(`^(async )?function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

async function write(record) {
  let row = null, status = null;
// CHANGED 2026-11-18, declared: the sale insert has a bounded wait (SALE_WRITE_TIMEOUT_MS, an AbortController, .abortSignal on
// the query); the mock answers .abortSignal and the context carries the timer and AbortController.
  const ctx = { Math, Object, String, Number, Array, JSON, Date, console, isFinite, isNaN, AbortController, setTimeout, clearTimeout, SALE_WRITE_TIMEOUT_MS: 20000,
    supabaseClient: { from: () => ({ insert: rows => { row = rows[0]; return { select: () => ({ abortSignal: async () => ({ data: [{ id: 'x' }], error: null }) }) }; } }) },
    noteSaleWrite: (pos, s, message) => { status = s === 'WRITTEN' ? s : `${s}: ${message}`; return s; },
    persist: () => {}, invalidateSessionRead: () => {}, state: { sold: [] } };
  vm.createContext(ctx);
  vm.runInContext(strip(readSource('core/edge-scoring.js')) + columnValidatorsSrc()
    + ['writeTradeToSupabase', 'saleVerdictProvenance', 'saleModeColumns'].map(grab).join('\n') + ';globalThis.__w = writeTradeToSupabase;', ctx);
  await ctx.__w({ id: 'p1', ticker: 'AAA', shares: 1, buyPrice: 1, buyDate: '2026-11-01', engineSource: 'EDGE', macroPathAtBuy: 'unknown' }, { ticker: 'AAA', ...record }, '2026-11-14', 1.1, 0.1, 10);
  assert.strictEqual(status, 'WRITTEN', `the write ran: ${status}`);
  return row;
}
const STAMP = { app: '20261114045100', scoring: 2, scoring_hash: 'h' };

(async () => {
await run('a record this build computed: its provenance, when sampling began, and the computing build', async () => {
  const s = await write({ peakRsiDuringHold: 71.5, peakRsiProvenance: 'sampled_since', peakRsiSampledFrom: '2026-11-13T15:00:00.000Z', saleCodeVersion: STAMP });
  assert.deepStrictEqual([s.peak_rsi_during_hold, s.peak_rsi_provenance, s.peak_rsi_sampled_from], [71.5, 'sampled_since', '2026-11-13T15:00:00.000Z']);
  assert.deepStrictEqual(s.sale_code_version, STAMP, 'the computing build, not the writing one');
  const n = await write({ peakRsiDuringHold: null, peakRsiProvenance: 'not_sampled', peakRsiSampledFrom: '2026-11-13T15:00:00.000Z', saleCodeVersion: STAMP });
  assert.deepStrictEqual([n.peak_rsi_during_hold, n.peak_rsi_provenance, n.peak_rsi_sampled_from], [null, 'not_sampled', null], 'a timestamp only with sampled_since (db/044\'s CHECK)');
});

await run('a record an older build computed (a Retry): not_established, no timestamp, and the computing build NOT RECORDED', async () => {
  const o = await write({ peakRsiDuringHold: 63.2 });
  assert.deepStrictEqual([o.peak_rsi_during_hold, o.peak_rsi_provenance, o.peak_rsi_sampled_from], [63.2, 'not_established', null]);
  assert.strictEqual(o.sale_code_version, null, 'NULL, never the retrying build');
});
})();
