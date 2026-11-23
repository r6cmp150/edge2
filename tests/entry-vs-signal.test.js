// tests/entry-vs-signal.test.js -- 2026-11-23. entry_vs_signal_price_pct compared the add form's price, PRE-FILLED with
// sig.price (to 2 dp), with sig.price itself: 0 for every unedited add, a value nobody measured (the self-referential
// sweep's #1, the pre-fill guard's last KNOWN allowance). It is now computed only when the price was typed.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { run, readSource } = require('./_lib');

const app = readSource('app.js');
const i = app.search(/^async function computeEntryMeasurementFields\(/m);
const src = app.slice(i, app.indexOf('\n}\n', i) + 3);
const ctx = { state: { settings: {}, lastScanTime: null }, getPT: () => new Date('2026-11-23T10:00:00'), Number, Math, Date, console };
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__f = computeEntryMeasurementFields;', ctx);

(async () => {
await run('an unedited pre-fill stores null, never the 0 it would compare to itself', async () => {
  const sig = { price: 4.2137 };
  assert.strictEqual((await ctx.__f('X', 4.21, sig)).entryVsSignalPricePct, null, 'the pre-fill is sig.price to 2 dp');
});

await run('a TYPED price is the real gap to the signal', async () => {
  const sig = { price: 4.2137 };
  const r = await ctx.__f('X', 4.30, sig);
  assert.ok(Math.abs(r.entryVsSignalPricePct - (4.30 - 4.2137) / 4.2137 * 100) < 1e-9);
});

await run('no signal: null, as before', async () => {
  assert.strictEqual((await ctx.__f('X', 4.30, null)).entryVsSignalPricePct, null);
});
})();
