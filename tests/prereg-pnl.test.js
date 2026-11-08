// tests/prereg-pnl.test.js -- 2026-11-08. The pure parts of scripts/prereg-pnl.mjs, on synthetic
// data only: this test never reads the book. It pins the pre-registered design (floor, block
// length, level, seed) so it can't drift after a result is seen, and the three outcome states.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');
const load = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts/prereg-pnl.mjs')).href);

run('the design is the pre-registered one: 20-day floor, blocks of 3, 95% two-sided, 10,000, seed 20261108', async () => {
  const { DESIGN } = await load();
  assert.deepStrictEqual([DESIGN.minDaysForVerdict, DESIGN.blockLength, DESIGN.lowerPct, DESIGN.upperPct, DESIGN.resamples, DESIGN.seed], [20, 3, 2.5, 97.5, 10000, 20261108]);
  assert.deepStrictEqual(DESIGN.periods.map(p => p[1]), ['0000-00-00', '2026-09-15', '2026-10-21', '2026-10-22', '2026-11-01'], 'the event dates, fixed before the run');
});

run('outcomes: WIN, LOSS, BE and UNKNOWN, never folded together', async () => {
  const { outcome } = await load();
  assert.deepStrictEqual([{ pnl_dollars: 5 }, { pnl_dollars: '-0.01' }, { pnl_dollars: 0 }, { pnl_dollars: null }, {}, { pnl_dollars: 'x' }].map(outcome), ['WIN', 'LOSS', 'BE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
});

run('per day groups by BUY date and sums, in date order', async () => {
  const { perDay } = await load();
  assert.deepStrictEqual(perDay([{ buy_date: '2026-11-02T00:00:00+00:00', pnl_dollars: 5 }, { buy_date: '2026-11-01', pnl_dollars: -2 }, { buy_date: '2026-11-02', pnl_dollars: '1.5' }]), [['2026-11-01', -2], ['2026-11-02', 6.5]]);
});

run('asymmetry: averages, ratio, and the largest-5 shares', async () => {
  const { asymmetry } = await load();
  const a = asymmetry([10, 20, -5, -50, 0, 30, 40, 50, 60, -1, -2, -3, -4].map(p => ({ pnl_dollars: p })));
  assert.strictEqual(a.wins, 6); assert.strictEqual(a.losses, 6); assert.strictEqual(a.be, 1);
  assert.strictEqual(a.avgWin, 35); assert.strictEqual(a.avgLoss, -65 / 6);
  assert.strictEqual(a.top5Losses[0], -50, 'largest loss first');
  assert.ok(Math.abs(a.top5LossShare - 64 / 65) < 1e-12 && Math.abs(a.top5WinShare - 200 / 210) < 1e-12);
});

run('the bootstrap is reproducible, brackets the mean, and refuses a series shorter than a block', async () => {
  const { blockBootstrapMean, DESIGN } = await load();
  const s = Array.from({ length: 35 }, (_, i) => Math.sin(i) * 10 + 1);
  const a = blockBootstrapMean(s, DESIGN), b = blockBootstrapMean(s, DESIGN);
  assert.deepStrictEqual(a, b, 'same seed, same interval');
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  assert.ok(a.lower < mean && mean < a.upper, `${a.lower} < ${mean} < ${a.upper}`);
  assert.strictEqual(blockBootstrapMean([1, 2], DESIGN), null);
  const flat = blockBootstrapMean(Array(30).fill(4), DESIGN);
  assert.deepStrictEqual([flat.lower, flat.upper], [4, 4], 'no spread, no interval width');
});
