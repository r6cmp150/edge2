// tests/measure-live-bytes.test.js -- 2026-11-27. The live-data trend's arithmetic (scripts/measure-live-bytes.mjs):
// per-table calibration of stored bytes to backup JSON bytes, the series, the slope per calendar day, and the date a
// size reaches a target. On fixtures; the live run reads git.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-live-bytes.mjs')).href);

await run('calibration is per table: stored live bytes over that table\'s JSON bytes at one backup', () => {
  const r = M.ratios({ a: 2, b: 1 }, { a: 4e6, b: 4e6 });
  assert.deepStrictEqual(r, { a: 0.5, b: 0.25 });
  assert.throws(() => M.ratios({ a: 1 }, { a: 0 }), /no JSON bytes/);
  assert.strictEqual(M.liveMB({ a: 4e6, b: 8e6 }, r), 4, '2 + 2 MB: each table at its own ratio, not one pooled ratio');
});

await run('the slope is MB per CALENDAR day, and the date follows from it', () => {
  const r = { a: 0.5 };
  const s = M.slope({ at: '2026-11-14T12:00:00Z', json: { a: 10e6 } }, { at: '2026-11-24T12:00:00Z', json: { a: 30e6 } }, r);
  assert.strictEqual(s, 1, '10 MB of live data over 10 calendar days, weekends included');
  assert.strictEqual(M.reaches(100, '2026-11-26', 1, 200), '2027-03-06');
  assert.strictEqual(M.reaches(100, '2026-11-26', 0, 200), null, 'no growth, no date: never a date from a flat or falling line');
  assert.strictEqual(M.reaches(100, '2026-11-26', -1, 200), null);
});
})();
