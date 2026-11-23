// tests/spread-hurdle.test.js -- 2026-11-22. The hurdle's arithmetic on fixtures: a trade's position value, its
// round-trip spread cost (half of each spread against the mid, so MID - NET), the dollar-weighted percent, and the
// dollar hurdle at the median position; plus the STATUS entry carrying the figures and saying it is the bar.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/spread-hurdle.mjs')).href);
const near = (a, b) => Math.abs(a - b) < 1e-9;

await run('one trade: V at the buy mid, C is half of each spread, RT% at each side\'s own mid', () => {
  const c = M.tradeCost(100, { bp: 1.98, ap: 2.02 }, { bp: 3.97, ap: 4.03 });
  assert.ok(near(c.V, 200)); assert.ok(near(c.C, 100 * (0.02 + 0.03)));
  assert.ok(near(c.rt, 100 * (0.02 / 2 + 0.03 / 4)));
});

await run('the hurdle: SUM(C)/SUM(V), dollar-weighted, and the median position times it', () => {
  const h = M.hurdle([{ V: 100, C: 1, rt: 1 }, { V: 300, C: 1, rt: 0.2 }, { V: 1000, C: 2, rt: 0.2 }]);
  assert.ok(near(h.weightedPct, 100 * 4 / 1400), 'not the mean of RT%');
  assert.strictEqual(h.medianV, 300); assert.ok(near(h.hurdleDollars, 300 * 4 / 1400));
  assert.ok(near(h.medianRt, 0.2)); assert.ok(near(h.meanRt, 1.4 / 3));
  assert.strictEqual(M.hurdle([{ V: 1, C: 0, rt: 0 }, { V: 3, C: 0, rt: 0 }]).medianV, 2, 'an even count averages the middle two');
});

await run('STATUS records the hurdle as the bar, with its arithmetic and its source', () => {
  const s = readSource('STATUS.md');
  assert.ok(s.includes('## THE HURDLE: the bar, not a result'));
  assert.ok(s.includes('$744.75 / $255,861.76 x 100 = 0.291%') && s.includes('$513.50 x 0.291% = $1.49'));
  assert.ok(s.includes('scripts/spread-hurdle.mjs'));
});
})();
