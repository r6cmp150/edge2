// tests/measure-good-days.test.js -- 2026-11-23. The good-days test's machinery, on fixtures, committed with the script
// BEFORE its first run: per-day means, ranks, the differential against the market proxy, and the spread test in both
// directions (days that truly differ are found wider than chance; days that do not, are not).
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-good-days.mjs')).href);

await run('the declared constants', () => {
  assert.deepStrictEqual([M.REV, M.BENCH, M.MIN_DAY_N, M.TOP, M.SHUFFLES, M.SEED], ['314f6e0', 'IWM', 5, 10, 10000, 20261123]);
  assert.deepStrictEqual(M.REMEMBERED, ['2026-10-23', '2026-10-24']);
});

await run('per-day means of return, proxy and differential; ranks with 1 the highest', () => {
  const rows = [{ day: 'A', ret: 2, bench: 1, diff: 1 }, { day: 'A', ret: 4, bench: 1, diff: 3 }, { day: 'B', ret: 5, bench: 6, diff: -1 }];
  const d = M.byDay(rows);
  assert.deepStrictEqual(d.map(x => [x.day, x.n, x.ret, x.bench, x.diff]), [['A', 2, 3, 1, 2], ['B', 1, 5, 6, -1]]);
  assert.strictEqual(M.rankOn(d, 'ret').get('B'), 1, 'B has the higher return');
  assert.strictEqual(M.rankOn(d, 'diff').get('A'), 1, 'but A the higher differential: the market carried B');
  assert.ok(Math.abs(M.ret(4, 5) - 25) < 1e-12);
});

await run('the spread test: days that truly differ are wider than chance; days that do not, are not', () => {
  const differ = [], same = [];
  for (let d = 0; d < 20; d++) for (let k = 0; k < 6; k++) {
    differ.push({ day: `D${d}`, ret: 0, bench: 0, diff: (d % 2 ? 5 : -5) + (k - 2.5) * 0.1 });
    same.push({ day: `D${d}`, ret: 0, bench: 0, diff: ((d * 6 + k) * 7919 % 13) - 6 });
  }
  assert.ok(M.spreadTest(differ, { shuffles: 2000 }).p < 0.05);
  assert.ok(M.spreadTest(same, { shuffles: 2000 }).p >= 0.05);
});

await run('the framing is printed first and last, and names the proxy as a proxy', () => {
  const src = readSource('scripts/measure-good-days.mjs');
  assert.ok(M.FRAMING.startsWith('THE DAYS WERE CHOSEN BECAUSE THEY LOOKED GOOD'));
  assert.ok(M.FRAMING.includes('IWM is a named proxy for the market, not the universe') && M.FRAMING.includes('Nothing here reopens the score question'));
  assert.ok(src.includes("console.log(FRAMING + '\\n');") && src.includes('console.log(`\\n${FRAMING}`);'));
  assert.ok(src.includes("'NO TRADES that day in the sample (and none anywhere in the record)'"));
  assert.ok(src.includes("(too few to read)"));
});
})();
