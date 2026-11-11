// tests/audit-peak-gain.test.js — 2026-11-05. Does he give back his biggest gains: the peak is the regular-
// session high after the fill and up to the recorded sale, from bars; a missing peak is NULL, never a number.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

(async () => {
const m = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-peak-gain.mjs')).href);
// 2026-10-08 is PDT: 06:30 PT = 13:30Z, 13:00 PT = 20:00Z.
const bar = (iso, h) => ({ t: iso, h });
const trade = (o = {}) => ({ buy_date: '2026-10-08', sell_date: '2026-10-08', buy_price: 10, sell_price: 11, buy_time: '06:31', sell_time: '12:00', filled_at: '2026-10-08T14:00:00Z', ...o });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

await run('the peak counts only regular-session bars after the fill and up to the recorded sale', () => {
  const bars = [
    bar('2026-10-08T12:00:00Z', 30),   // pre-market
    bar('2026-10-08T13:59:00Z', 20),   // after the 06:31 PT order, before the fill
    bar('2026-10-08T15:00:00Z', 12),   // the peak
    bar('2026-10-08T19:30:00Z', 25),   // after the recorded 12:00 PT sale
    bar('2026-10-08T21:00:00Z', 40),   // after hours
  ];
  const g = m.giveBack(trade(), bars);
  near(g.peak, 20, 'peak +20%');
  assert.strictEqual(g.peakAt, Date.parse('2026-10-08T15:00:00Z'));
  near(g.realized, 10, 'realized'); near(g.givenBack, 10, 'given back, points'); near(g.captured, 0.5, 'captured');
  assert.strictEqual(g.lowerPeak, null, 'same-day: no lower bound');
});

await run('no bar in range is NULL, not a peak of zero; a peak at or below the buy has no captured share', () => {
  const g = m.giveBack(trade(), [bar('2026-10-08T12:00:00Z', 30)]);
  assert.strictEqual(g.peak, null); assert.strictEqual(g.givenBack, null); assert.strictEqual(g.captured, null);
  assert.strictEqual(m.giveBack(trade({ sell_price: 9 }), [bar('2026-10-08T15:00:00Z', 9.5)]).captured, null, 'a peak below the buy');
});

await run('a multi-day hold has a lower bound that stops before the sale day; an unfilled order starts at its order time', () => {
  const t = trade({ sell_date: '2026-10-09', filled_at: null, buy_time: '07:00' }); // 07:00 PT = 14:00Z
  const bars = [bar('2026-10-08T13:45:00Z', 50), bar('2026-10-08T15:00:00Z', 11), bar('2026-10-09T12:00:00Z', 40), bar('2026-10-09T14:00:00Z', 13)]; // day two's pre-market is in the hold, and not the peak
  const g = m.giveBack(t, bars);
  near(g.peak, 30, 'upper: through the sale day'); near(g.lowerPeak, 10, 'lower: before it');
});

await run('a band counts captured-under-half, losses and sale-day peaks, and is empty rather than zero', () => {
  const row = (peak, realized, peakDate = '2026-10-08') => ({ t: { sell_date: '2026-10-08' }, g: { peak, realized, givenBack: peak - realized, captured: realized / peak, peakAt: Date.parse(`${peakDate}T15:00:00Z`) } });
  const rows = [row(12, 11), row(6, 2), row(4, -1, '2026-10-07'), row(2, 1), { t: {}, g: { peak: null } }];
  const b = m.band(rows, 3);
  assert.strictEqual(b.n, 3);
  assert.strictEqual(b.halfOrMoreGivenBack, 2, '6 to 2, and 4 to -1');
  assert.strictEqual(b.endedAtALoss, 1);
  assert.strictEqual(b.peakOnSaleDay, 2);
  assert.strictEqual(m.band(rows, 3).medianPeak, 6);
  assert.deepStrictEqual(m.band(rows, 50), { n: 0 }, 'an empty band says n 0, not a median of nothing');
});

await run('a row with no sell_time is its own state: giveBack refuses it rather than give it a time (no 13:00 default)', () => {
  for (const missing of [null, undefined, '']) {
    assert.throws(() => m.giveBack(trade({ sell_time: missing }), [bar('2026-10-08T15:00:00Z', 12)]), /no sale time/, String(missing));
  }
  // and the three scripts that once defaulted it carry no time-of-day fallback for sell_time
  const fs = require('fs');
  for (const f of ['audit-peak-gain.mjs', 'audit-exit-rules.mjs', 'audit-render-sampled-inputs.mjs', 'prereg-peak-before-after.mjs']) {
    const s = fs.readFileSync(path.join(REPO_ROOT, 'scripts', f), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/sell_time\s*(\|\||\?\?)/.test(s), `${f}: sell_time with a fallback`);
  }
});

await run('the spec records the measurement, per trade at the top, with both average-win figures, and decides nothing', () => {
  const spec = require('fs').readFileSync(path.join(REPO_ROOT, 'docs/phase-10-entry-gate-spec.md'), 'utf8').replace(/\s+/g, ' ');
  for (const s of ['the +20% threshold is NOT decided.', '$9.75 on a $492 position over the 283 winners', '$10.98 on $563 in the v2 era, which is seven days',
    'CPNG captured 99%', 'NNBR 97% (its peak is in the minute of the recording', "it is the reviewer's and Roman's decision, not made here."]) assert.ok(spec.includes(s), s);
});
})();
