// tests/measure-change-split.test.js -- 2026-11-23. The split at the change date, on fixtures, committed BEFORE its
// first run: the boundary, the day-resampled interval, the two-part reading in both directions, the cached reference
// (a re-run reads the same bar, and a dropped connection is retried), and the limit printed with the numbers.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-change-split.mjs')).href);

await run('the boundary is the change date: 10-22 before, 10-23 after', () => {
  assert.strictEqual(M.LAST_BEFORE, '2026-10-22');
  assert.strictEqual(M.side('2026-10-22'), 'before'); assert.strictEqual(M.side('2026-10-23'), 'after'); assert.strictEqual(M.side('2026-08-17'), 'before');
});

const days = (n, f) => Array.from({ length: n }, (_, d) => Array.from({ length: 4 }, (_, k) => ({ day: `2026-11-${String(d + 1).padStart(2, '0')}`, diff: f(d, k) }))).flat();

await run('ALIVE needs both: an interval above zero AND most days positive', () => {
  assert.strictEqual(M.reading(days(12, (d, k) => 1 + (k - 1.5) * 0.2)).verdict, 'ALIVE');
  assert.strictEqual(M.reading(days(12, (d, k) => (d % 2 ? 1 : -1) + k * 0.01)).verdict, 'DEAD', 'around zero');
  // one huge day and the rest slightly negative: the mean can be positive but it is not sustained
  assert.strictEqual(M.reading(days(12, (d, k) => (d === 0 ? 30 : -0.2))).verdict, 'DEAD', 'one good day is not sustained');
  // each half alone: an interval above zero carried by 5 of 12 days is not sustained; 7 of 12 days positive with a
  // negative mean is not clearly positive
  const fewDays = days(12, (d) => (d < 5 ? 2 : -0.1));
  assert.ok(M.dayInterval(fewDays).lo > 0, 'the fixture has its interval above zero');
  assert.strictEqual(M.reading(fewDays).verdict, 'DEAD', 'interval above zero, but only 5 of 12 days positive');
  assert.strictEqual(M.reading(days(12, (d) => (d < 7 ? 0.1 : -3))).verdict, 'DEAD', '7 of 12 days positive, but the interval is not above zero');
});

await run('the interval resamples whole days', () => {
  const ci = M.dayInterval(days(10, (d) => d), { resamples: 2000 });
  assert.ok(ci.lo < 4.5 && ci.hi > 4.5 && ci.lo > 0, JSON.stringify(ci));
});

await run('the shared reference is cached and retried', async () => {
  const L = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/sip-ref.mjs')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipref-'));
  process.env.SIP_REF_CACHE = dir;
  const key = path.join(dir, 'ABC-1000.json');
  fs.writeFileSync(key, JSON.stringify({ price: 7, barStart: 'x', ageMin: 0 }));
  assert.deepStrictEqual(await L.sipRef({}, 'ABC', 1000, { wait: async () => {} }), { price: 7, barStart: 'x', ageMin: 0 }, 'read from the cache, no request');
  delete process.env.SIP_REF_CACHE;
  fs.rmSync(dir, { recursive: true, force: true });
  const src = readSource('scripts/lib/sip-ref.mjs');
  assert.ok(src.includes("import { pickReference, latestSipBar } from '../measure-entry-price-gap.mjs';"), 'the same method, imported');
  assert.ok(/if \(!\(e instanceof TypeError\) \|\| i >= 5\) throw e;/.test(src), 'only a transport failure is retried');
});

await run('the limit is printed with the numbers', () => {
  const src = readSource('scripts/measure-change-split.mjs');
  assert.ok(M.LIMIT.startsWith('IWM IS A PROXY FOR THE SMALL-CAP MARKET, NOT THE UNIVERSE'));
  assert.ok(src.includes("console.log(LIMIT + '\\n');") && src.includes('console.log(`\\n${LIMIT}`);'));
});
})();
