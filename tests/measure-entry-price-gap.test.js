// tests/measure-entry-price-gap.test.js -- 2026-11-20 (the reviewer). The entry-price gap measurement's rules, on
// fixtures, written and committed with the script BEFORE its first run on the data: the Pacific buy minute across
// the 2026-11-01 change, the reference never taken from a bar after the buy minute, the signed gap, the corrected
// return, the declared materiality bar on both sides, and the re-run decision's three outcomes. No data is read here.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-entry-price-gap.mjs')).href);

await run('the declared constants', () => {
  assert.strictEqual(M.REV, '314f6e0');
  assert.strictEqual(M.MATERIAL_GAP_PCT, 1); assert.strictEqual(M.MATERIAL_MIN_TRADES, 30); assert.strictEqual(M.LOOKBACK_DAYS, 7);
});

await run('the buy minute is Pacific: PDT (UTC-7) before 2026-11-01, PST (UTC-8) from it', () => {
  assert.strictEqual(new Date(M.buyMinuteUtc('2026-10-30', '06:50')).toISOString(), '2026-10-30T13:50:00.000Z');
  assert.strictEqual(new Date(M.buyMinuteUtc('2026-11-05', '06:50')).toISOString(), '2026-11-05T14:50:00.000Z', 'DRVN: its position_id instant');
  assert.strictEqual(new Date(M.buyMinuteUtc('2026-11-01', '00:00')).toISOString(), '2026-11-01T08:00:00.000Z');
  assert.strictEqual(new Date(M.buyMinuteUtc('2026-09-01', '17:30:00')).toISOString(), '2026-09-02T00:30:00.000Z', 'a buy_time with seconds, crossing midnight UTC');
});

await run('the reference is the latest bar starting AT OR BEFORE the buy minute, never one after it, whatever the order', () => {
  const buy = Date.parse('2026-11-05T14:50:00Z');
  const bars = [{ t: '2026-11-05T14:51:00Z', c: 99 }, { t: '2026-11-05T14:47:00Z', c: 12.075 }, { t: '2026-11-05T14:50:00Z', c: 12.09 }, { t: '2026-11-05T14:49:00Z', c: 12.115 }];
  assert.deepStrictEqual(M.pickReference(bars, buy), { price: 12.09, barStart: '2026-11-05T14:50:00.000Z', ageMin: 0 });
  assert.deepStrictEqual(M.pickReference([{ t: '2026-11-05T14:40:00Z', c: 5 }], buy), { price: 5, barStart: '2026-11-05T14:40:00.000Z', ageMin: 10 });
  assert.strictEqual(M.pickReference([{ t: '2026-11-05T14:51:00Z', c: 99 }], buy), null, 'only a later bar: NO REFERENCE, nothing substituted');
  assert.strictEqual(M.pickReference([], buy), null);
});

await run('the gap is signed (positive: recorded above the market) and the corrected return is from the reference', () => {
  assert.ok(Math.abs(M.gapPct(11.9, 12.09) - (-1.5715)) < 1e-3);
  assert.ok(Math.abs(M.gapPct(2.2, 2) - 10) < 1e-9);
  assert.ok(Math.abs(M.correctedReturnPct(11.66, 12.09) - 100 * (11.66 - 12.09) / 12.09) < 1e-12);
  assert.ok(Math.abs(M.correctedReturnPct('2.1', 2) - 5) < 1e-9, 'a string sell_price is a number');
});

await run('MATERIAL is at least 30 trades with |gap| >= 1%, either sign; 29 is not, and 0.99% does not count', () => {
  const g = n => [...Array(n).fill(1), ...Array(n).fill(0).map(() => 0.2)];
  assert.strictEqual(M.isMaterial([...Array(15).fill(1), ...Array(15).fill(-1)]), true, 'negative gaps count');
  assert.strictEqual(M.isMaterial(g(29)), false);
  assert.strictEqual(M.isMaterial(g(30)), true);
  assert.strictEqual(M.isMaterial(Array(100).fill(0.99)), false);
});

await run('the re-run decision: not material -> not computed; material with a missing reference -> cannot apply; else run', () => {
  assert.strictEqual(M.rerunDecision({ material: false, missing: 0 }), 'not-material');
  assert.strictEqual(M.rerunDecision({ material: false, missing: 3 }), 'not-material');
  assert.strictEqual(M.rerunDecision({ material: true, missing: 1 }), 'cannot-apply');
  assert.strictEqual(M.rerunDecision({ material: true, missing: 0 }), 'run');
});

await run('the gap and age tables count every value once, at the declared edges', () => {
  const t = M.gapTable([0, 0.24, -0.25, 0.5, 0.99, -1, 1.99, 2, 4.99, -5, 30]);
  assert.deepStrictEqual(t.map(x => x.n), [2, 1, 2, 2, 2, 2]);
  assert.strictEqual(t.reduce((a, x) => a + x.n, 0), 11);
  assert.deepStrictEqual(M.ageTable([0, 1, 5, 6, 15, 16, 60, 61, 4000]).map(x => x.n), [1, 2, 2, 2, 2]);
});

await run('the declared rule, the last-re-run sentence, the limits and the SIP feed are in the script', () => {
  const src = readSource('scripts/measure-entry-price-gap.mjs');
  assert.ok(src.includes('feed=sip&adjustment=raw&limit=1&sort=desc'));
  assert.ok(/THIS IS THE LAST RE-RUN: if corrected returns are also null, that is the answer/.test(src));
  assert.ok(src.includes("console.log(LAST_RERUN);"));
  assert.ok(src.includes("NOT MEASURED HERE: sell_price."));
  assert.ok(src.includes("THE RULE DOES NOT FIRE: the re-run is not computed, and ef99790"));
  assert.ok(!/winsor|trim\(|outlier/i.test(src.replace(/^\/\/.*$/gm, '')), 'no trimming in the code');
});
})();
