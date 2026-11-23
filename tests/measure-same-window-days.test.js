// tests/measure-same-window-days.test.js -- 2026-11-23. The same-window day comparison's machinery, committed BEFORE its
// first run: the close is that day's bar and no other, the win rate, and the limits printed first and last.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-same-window-days.mjs')).href);

await run('the close is the buy day\'s own bar; another day\'s is not used', () => {
  const bars = [{ t: '2026-10-27T04:00:00Z', c: 10 }, { t: '2026-10-28T04:00:00Z', c: 11 }];
  assert.strictEqual(M.closeOn(bars, '2026-10-28'), 11);
  assert.strictEqual(M.closeOn(bars, '2026-10-29'), null);
  assert.strictEqual(M.closeOn(undefined, '2026-10-28'), null);
});

await run('the logger\'s ret_close is a fraction and is put in percent before it meets Roman\'s side', () => {
  assert.strictEqual(M.fractionToPct('0.0123'), 1.23);
  assert.ok(readSource('scripts/measure-same-window-days.mjs').includes('.map(x => fractionToPct(x.ret_close));'));
});

await run('the spread: the sample standard deviation, none under two returns', () => {
  assert.ok(Math.abs(M.sd([1, 2, 3]) - 1) < 1e-12); assert.strictEqual(M.sd([5]), null);
});

await run('win rate: strictly positive returns, of all; none for no returns', () => {
  assert.strictEqual(M.win([1, -1, 0, 2]), 50); assert.strictEqual(M.win([]), null);
});

await run('declared: the same window, his own exit not used, the limits printed first and last', () => {
  const src = readSource('scripts/measure-same-window-days.mjs');
  assert.deepStrictEqual([M.REV, M.FROM], ['98bcc07', '2026-10-23']);
  assert.ok(M.LIMITS.startsWith('SAME WINDOW (entry to that session\'s close) for both, DESCRIPTIVE, no bar.'));
  assert.ok(src.includes("console.log(LIMITS + '\\n');") && src.includes('console.log(`\\n${LIMITS}`);'));
  assert.ok(!/\bsell_price\b|\bpnl_pct\b|\bsell_time\b/.test(src.replace(/^\/\/.*$/gm, '')), 'his own exit is never read (sell_price_unverified, the sample filter, is not his exit)');
});
})();
