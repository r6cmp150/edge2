// tests/prereg-costs.test.js -- 2026-11-11. The pure parts of scripts/prereg-costs.mjs, on synthetic data only:
// this test never reads the book or calls Alpaca. It pins the moments, the quote choice, the cost arithmetic and
// the verdict wording, which were fixed before the first run.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');
const load = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts/prereg-costs.mjs')).href);

run('PT wall clock to an instant: PDT before 2026-11-01, PST from it', async () => {
  const { ptInstant } = await load();
  assert.strictEqual(new Date(ptInstant('2026-10-30', '07:30')).toISOString(), '2026-10-30T14:30:00.000Z');
  assert.strictEqual(new Date(ptInstant('2026-11-06', '07:30')).toISOString(), '2026-11-06T15:30:00.000Z');
  assert.strictEqual(ptInstant('2026-11-06', 'x'), null);
});

run('moments: the buy at filled_at when recorded, else buy date + time; the sale at sell date + time; a missing one is null', async () => {
  const { tradeMoments } = await load();
  const m = tradeMoments({ filled_at: '2026-11-06T15:08:44.702Z', buy_date: '2026-11-06', buy_time: '07:00', sell_date: '2026-11-06', sell_time: '07:57' });
  assert.strictEqual(new Date(m.buy).toISOString(), '2026-11-06T15:08:44.702Z', 'filled_at wins over buy_time');
  assert.strictEqual(new Date(m.sell).toISOString(), '2026-11-06T15:57:00.000Z');
  const n = tradeMoments({ buy_date: '2026-10-01T00:00:00+00:00', buy_time: '09:28', sell_date: '2026-10-02', sell_time: null });
  assert.strictEqual(new Date(n.buy).toISOString(), '2026-10-01T16:28:00.000Z');
  assert.strictEqual(n.sell, null, 'no sale time: not charged, never guessed');
  assert.strictEqual(tradeMoments({ buy_date: '2026-10-01', sell_date: '2026-10-02', sell_time: '07:00' }).buy, null);
});

run('the quote: the last valid one in the 60 s up to the moment; crossed, empty or stale quotes are not used', async () => {
  const { pickQuote } = await load();
  const at = Date.parse('2026-11-06T15:00:00Z');
  const q = (s, bp, ap) => ({ t: new Date(at - s * 1000).toISOString(), bp, ap });
  assert.strictEqual(pickQuote([q(30, 1.00, 1.02), q(5, 1.01, 1.03)], at).bp, 1.01, 'the latest');
  assert.strictEqual(pickQuote([q(5, 1.05, 1.03)], at), null, 'crossed (ask below bid): not used');
  assert.strictEqual(pickQuote([q(5, 0, 1.03)], at), null, 'no bid: not used');
  assert.strictEqual(pickQuote([q(61, 1.00, 1.02)], at), null, 'older than 60 s: not used');
  assert.strictEqual(pickQuote([q(-1, 1.00, 1.02)], at), null, 'after the moment: not used');
  assert.strictEqual(pickQuote([q(5, 1.01, 1.01)], at).ap, 1.01, 'locked (ask = bid) is a valid zero spread');
  assert.strictEqual(pickQuote([q(10, 1.00, 1.02), q(5, 1.05, 1.03)], at).bp, 1.00, 'an invalid later quote does not hide a valid earlier one');
});

run('costs: base is half the spread on each side, harsh the full spread, times shares', async () => {
  const { costFor } = await load();
  const c = costFor({ shares: 100 }, { bp: 2.00, ap: 2.02 }, { bp: 2.10, ap: 2.14 });
  assert.ok(Math.abs(c.base - 100 * (0.01 + 0.02)) < 1e-9 && Math.abs(c.harsh - 100 * (0.02 + 0.04)) < 1e-9, JSON.stringify(c));
  assert.ok(Math.abs(c.buyRel - 0.02 / 2.01) < 1e-12);
});

run('the verdict, in the words written before the run', async () => {
  const { verdictLine } = await load();
  assert.ok(/does not survive costs as traded, and that is the finding/.test(verdictLine({ lower: -9, upper: -1 }, 35)));
  assert.ok(/survives the base-case costs, bounded by the largest-contributor test/.test(verdictLine({ lower: 1, upper: 9 }, 35)));
  assert.ok(/cannot be distinguished from break-even/.test(verdictLine({ lower: -1, upper: 1 }, 35)));
  assert.ok(/fewer than 20 buy days charged: no interval, no verdict/.test(verdictLine({ lower: -9, upper: -1 }, 19)));
});

run('the output names what the book is, first: paper simulation, provenance not_known', () => {
  const src = require('fs').readFileSync(path.join(REPO_ROOT, 'scripts/prereg-costs.mjs'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const first = main.indexOf("console.log('WHAT THE BOOK IS:");
  assert.ok(first > 0 && first < main.indexOf('console.log(`SOURCE:'), 'printed before anything else');
  assert.ok(/NOT_KNOWN/.test(main.slice(first, first + 400)) && /frictionless paper simulation/.test(main.slice(first, first + 400)));
  assert.ok(!/console\.log\([^)]*headers/.test(src) && !/writeFileSync\([^)]*headers/.test(src), 'the keys are never printed or written');
});
