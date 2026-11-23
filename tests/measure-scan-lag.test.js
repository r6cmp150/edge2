// tests/measure-scan-lag.test.js -- 2026-11-22 (the reviewer). The scannedAt lag, on fixtures, written and committed
// with the script BEFORE its first run on the data: the four states (a missing scan time and a scan after the click are
// counted, never given a lag of 0), the bar imported from 05969ca rather than restated, and the declared split's texts.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-scan-lag.mjs')).href);
const t = { position_id: '1791212400000' };

await run('the four states', () => {
  assert.deepStrictEqual(M.classify(t, null), { state: 'NO_SNAPSHOT' });
  assert.deepStrictEqual(M.classify(t, { snapshot: null }), { state: 'NO_SNAPSHOT' });
  assert.deepStrictEqual(M.classify(t, { snapshot: {} }), { state: 'NO_SCAN_TIME' });
  assert.deepStrictEqual(M.classify(t, { snapshot: { scannedAt: null } }), { state: 'NO_SCAN_TIME' }, 'null is missing, not 0');
  assert.deepStrictEqual(M.classify(t, { snapshot: { scannedAt: 1791212400000 - 25 * 60000 } }), { state: 'MEASURED', lagMin: 25 });
  assert.deepStrictEqual(M.classify(t, { snapshot: { scannedAt: 1791212400000 + 60000 } }), { state: 'CLOCK_ANOMALY', lagMin: -1 });
});

await run('the bar is 05969ca\'s own: median <= 15 and two thirds within 30, each half binding', () => {
  assert.strictEqual(M.reading(Array(10).fill(15)), 'SMALL');
  assert.strictEqual(M.reading(Array(10).fill(15.5)), 'LARGE');
  assert.strictEqual(M.reading([...Array(6).fill(10), ...Array(4).fill(45)]), 'LARGE', '6 of 10 within 30 is under two thirds');
  assert.strictEqual(M.reading([...Array(2).fill(10), ...Array(1).fill(45)]), 'SMALL', 'exactly two thirds');
  assert.strictEqual(M.reading([]), 'NOTHING MEASURED');
  const src = readSource('scripts/measure-scan-lag.mjs');
  assert.ok(src.includes("import { SMALL_MEDIAN_MIN, SMALL_WITHIN_MIN, SMALL_SHARE, NO_RERUN, quantile, lagTable } from './measure-signal-lag.mjs';"));
  assert.ok(!/const SMALL_(MEDIAN_MIN|WITHIN_MIN|SHARE)\s*=/.test(src), 'not restated');
});

await run('the declared split is printed as ruled, and the score test is not re-run', () => {
  assert.ok(M.SMALL_TEXT.includes('FOR THESE TRADES') && M.SMALL_TEXT.includes('the other 342 stay NOT ESTABLISHED'));
  assert.ok(M.LARGE_TEXT.startsWith('LARGE: DOWNGRADE.') && M.LARGE_TEXT.includes('"not established on this sample"'));
  const src = readSource('scripts/measure-scan-lag.mjs');
  assert.ok(src.includes('console.log(NO_RERUN);'));
  assert.ok(!/score-vs-return/.test(src.replace(/^\/\/.*$/gm, '')));
});
})();
