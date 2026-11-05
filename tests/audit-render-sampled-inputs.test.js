// tests/audit-render-sampled-inputs.test.js — 2026-11-05. The step 2.5 measurement: render-sampled exit inputs
// against SIP bars. Guards the three things that went wrong or could: an audit computing with its own copy of an
// app function, a missing high reported as a high, and a failed fetch becoming a quiet null.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, run, restoring, REPO_ROOT } = require('./_lib');

(async () => {
const m = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-render-sampled-inputs.mjs')).href);
const appRSI = new Function(readSource('core/indicators.js') + '\nreturn calcRSI;')();

await run('it computes RSI with the app\'s own function, not a reimplementation (§7.7)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 15; n < 80; n += 7) {
    const closes = Array.from({ length: n }, (_, i) => 10 + i * 0.05 + rnd() * 2);
    assert.strictEqual(m.rsi14(closes), appRSI(closes), `n=${n}`);
  }
  assert.strictEqual(m.rsi14([1, 2, 3]), null, 'below 15 closes the app answers 50, which is no measurement');
  const src = readSource('scripts/audit-render-sampled-inputs.mjs');
  assert.ok(/core\/indicators\.js/.test(src) && !/ag \* 13|Wilder\(/.test(src.replace(/\/\/[^\n]*/g, '')), 'loads core/indicators.js, carries no smoothing of its own');
});

const bar = (iso, h) => ({ t: iso, h });
await run('the regular-session high: 06:30 to 12:59 PT, and NULL when no bar falls in range', () => {
  // 2026-10-08 is PDT: 06:30 PT = 13:30Z, 13:00 PT = 20:00Z.
  const bars = [bar('2026-10-08T13:29:00Z', 99), bar('2026-10-08T13:30:00Z', 5), bar('2026-10-08T19:59:00Z', 6), bar('2026-10-08T20:00:00Z', 98)];
  const all = [Date.parse('2026-10-08T00:00:00Z'), Date.parse('2026-10-09T00:00:00Z')];
  assert.deepStrictEqual(m.sessionHigh(bars, ...all), { h: 6, date: '2026-10-08' }, 'extended hours never set the high');
  assert.strictEqual(m.sessionHigh(bars.slice(1, 2), ...all).h, 5, '06:30 is in');
  assert.strictEqual(m.sessionHigh([bars[0], bars[3]], ...all), null, 'only extended-hours bars: no high, not theirs');
  assert.strictEqual(m.sessionHigh([], ...all), null);
  const filled = [bar('2026-10-08T13:30:00Z', 7), bar('2026-10-08T13:45:00Z', 6.5)];
  assert.strictEqual(m.sessionHigh(filled, Date.parse('2026-10-08T13:31:00Z'), all[1]).h, 6.5, 'starts after the fill instant: a higher bar before it is not his');
});

await run('a rate limit is waited out; any other failure stops the run, never a quiet null', restoring(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bars-'));
  const opts = { timeframe: '1Min', start: '2026-10-08T00:00:00Z', end: '2026-10-09T00:00:00Z', feed: 'sip' };
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
  let calls = 0, waits = [];
  global.fetch = async () => (++calls <= 2 ? reply(429, { message: 'too many requests.' }) : reply(200, { bars: { ABC: [bar('2026-10-08T14:00:00Z', 3)] } }));
  const got = await m.barsWithRetry({}, 'ABC', opts, dir, async ms => { waits.push(ms); });
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(waits, [2000, 4000], 'two 429s, two waits, then the bars');
  calls = 0;
  global.fetch = async () => { calls++; return reply(500, { message: 'boom' }); };
  await assert.rejects(m.barsWithRetry({}, 'XYZ', opts, dir, async () => {}), /HTTP 500/, 'a server error stops the run');
  assert.strictEqual(calls, 1, 'at once, not after retries');
  calls = 0; // eight tries, then the 429 surfaces; a ninth means it is retrying without limit
  global.fetch = async () => { if (++calls > 8) throw new Error('retried past eight tries'); return reply(429, {}); };
  await assert.rejects(m.barsWithRetry({}, 'QQQ', opts, dir, async () => {}), /HTTP 429/, 'and a rate limit that never lifts stops it too');
  assert.strictEqual(calls, 8);
  global.fetch = async () => { throw new Error('no network expected: cached'); };
  assert.strictEqual((await m.barsWithRetry({}, 'ABC', opts, dir)).length, 1, 'a fetched series is cached');
  fs.rmSync(dir, { recursive: true, force: true });
}));

await run('the spec records the measurement, both facts about the zero, and why step 2.5 is parked', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  for (const s of [
    'The stored "activated: 0" was never evidence about the market, because the field was render-dependent: that stays true',
    'SIP bars now independently confirm zero: none of 464 sold trades reached +20%',
    'Mark filled writes a value that then looks like a measurement.',
    'measured at zero label changes: it fixes the record rather than the recommendation.',
    'Current positions: 0 of 11 change label.',
    "AN AUDIT COMPUTES WITH THE APP'S OWN FUNCTION, NOT A REIMPLEMENTATION OF IT",
    'It has three dependents',
    'a local schema to test migrations against.',
    'No rollback of db/035 may use CASCADE.',
  ]) assert.ok(spec.includes(s), s);
});
})();
