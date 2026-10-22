// tests/report-written-off.test.js — spec §7.5: cons_up_* / rel_strength_pts
// on EDGE trades ordered before the stock-modal fix are written off. The
// report must never bucket or print them as measured, and must never drop
// them silently: three states, measured / written off / the count of each.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const start = app.indexOf('const MODAL_COMPONENTS_FIXED_FROM');
const fnStart = app.indexOf('function buildIndividualSignalPerformanceSection(sold) {');
assert.ok(start >= 0 && fnStart > start, 'cutoff helpers sit just above the section builder');
let depth = 0, end = app.indexOf('{', fnStart);
for (; end < app.length; end++) { if (app[end] === '{') depth++; else if (app[end] === '}' && --depth === 0) break; }
// eslint-disable-next-line no-eval
eval(app.slice(start, end + 1) + '\nglobal.__section = buildIndividualSignalPerformanceSection; global.__off = modalComponentsWrittenOff;');

const trade = (buyDate, relStrengthPts, pnlPct, engineSource = 'EDGE') => ({
  buyDate, engineSource, relStrengthPts, pnlPct, volSpikePts: 20, rsiPts: 15, priceMomentumPts: 0, maPts: 10,
  volBuildPts: 0, meanReversionPts: 0, macroAdjustmentPts: 0,
});

run('written off: EDGE before the cutoff, or with no buy date; measured: on/after it, and Warrior', () => {
  assert.strictEqual(global.__off(trade('2026-10-21', 15, 1)), true);
  assert.strictEqual(global.__off(trade(null, 15, 1)), true, 'an unplaceable trade is written off, not assumed clean');
  assert.strictEqual(global.__off(trade('2026-10-22', 15, 1)), false);
  assert.strictEqual(global.__off(trade('2026-10-01', 15, 1, 'WARRIOR')), false, 'Warrior never went through the stock modal');
});

run('relative-strength block: counts both states, buckets only measured rows', () => {
  const old = Array.from({ length: 10 }, (_, i) => trade('2026-10-0' + (i % 9 + 1), 15, 5));
  const fresh = [trade('2026-10-22', 15, -2), trade('2026-10-23', 5, 3)];
  const out = global.__section([...old, ...fresh]);
  assert.ok(/2 measured \| 10 written off — stored value is the stock modal's recompute/.test(out), out);
  assert.ok(/Got \+15 \(outperform 2%\+\):\s+1 trades \| 0% win rate/.test(out), 'only the one measured +15 trade is bucketed, not the 10 written-off ones');
  assert.ok(/Got \+5 \(outperform >0%\):\s+1 trades/.test(out));
});

run('relative-strength block with nothing measured says so, and still counts the written-off rows', () => {
  const out = global.__section(Array.from({ length: 12 }, () => trade('2026-10-02', 15, 1)));
  assert.ok(/0 measured \| 12 written off/.test(out) && /No measured trades yet\./.test(out), out);
  assert.ok(!/Got \+15 \(outperform/.test(out), 'no bucket line built from written-off rows');
});

run('per-trade history prints "written off" for pre-fix EDGE components', () => {
  assert.ok(/Consecutive days:  \$\{modalComponentsWrittenOff\(s\) \? `written off — \$\{MODAL_WRITE_OFF_REASON\}`/.test(app), 'consecutive days line gated');
  assert.ok(/Relative strength: \$\{modalComponentsWrittenOff\(s\) \? 'written off/.test(app), 'relative strength line gated');
  const bare = app.match(/\$\{fmtPts\(s\.(consUpPts|relStrengthPts)\)\}/g) || [];
  assert.strictEqual(bare.length, 2, 'the only bare prints of these fields are the two inside the gate');
});
