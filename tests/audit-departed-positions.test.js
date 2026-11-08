// tests/audit-departed-positions.test.js -- 2026-11-08. The classifier behind
// scripts/audit-departed-positions.mjs, which replaced "236 of 236" (a figure that had
// lost its method) with a rerunnable read. Its first version matched on position_id only
// and reported 176 departed positions with no sale: trades_v2 had no position_id before
// db/033, so it was blind to every older sale. These pin both tiers and the gaps.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

const v = (at, rows) => ({ sha: at, at, rows });
const pos = (position_id, ticker, buy_date) => ({ position_id, ticker, buy_date });

run('exact by position_id, weaker by ticker + buy date only for sales with no position_id, and a real miss stays a miss', async () => {
  const { classify } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-departed-positions.mjs')).href);
  const versions = [
    v('2026-09-07T00:00:00Z', [pos('a', 'AAA', '2026-09-05'), pos('old', 'OLD', '2026-09-06T00:00:00+00:00'), pos('zz', 'ZZVERIFY', '2026-09-06')]),
    v('2026-11-07T00:00:00Z', [pos('open', 'OPN', '2026-11-02'), pos('b', 'BBB', '2026-11-05')]),
  ];
  const live = [{ position_id: 'open' }];
  const trades = [
    { position_id: 'a', ticker: 'AAA', buy_date: '2026-09-05' },        // exact
    { position_id: null, ticker: 'OLD', buy_date: '2026-09-06' },       // legacy: ticker + date
    { position_id: null, ticker: 'BBB', buy_date: '2026-11-05' },       // legacy row, but BBB's sale must match by id -- it doesn't exist
    { position_id: 'never', ticker: 'NEW', buy_date: '2026-11-06' },    // intraday: in no backup
  ];
  const r = classify(versions, live, trades);
  assert.strictEqual(r.backups, 2); assert.deepStrictEqual(r.range, ['2026-09-07T00:00:00Z', '2026-11-07T00:00:00Z']);
  assert.strictEqual(r.seen, 5); assert.strictEqual(r.open, 1); assert.strictEqual(r.departed, 4);
  assert.strictEqual(r.byId, 1, 'AAA by position_id');
  assert.strictEqual(r.byTickerDate, 2, 'OLD and BBB by ticker + date (BBB has no exact row, and a legacy row fits)');
  assert.deepStrictEqual(r.missing.map(m => m.ticker), ['ZZVERIFY'], 'no row by either: a miss, never matched to something');
  assert.strictEqual(r.neverBackedUp, 1, 'a sale whose position is in no backup is counted as unchecked');
  assert.strictEqual(r.tradesNoId, 2); assert.strictEqual(r.legacyUnused, 0);
});

run('two departures on one key, one row: CANNOT TELL for the first (named), MISSING for the second', async () => {
  const { classify } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-departed-positions.mjs')).href);
  const r = classify([v('2026-09-07T00:00:00Z', [pos('x1', 'DUP', '2026-09-05'), pos('x2', 'DUP', '2026-09-05')])], [], [{ position_id: null, ticker: 'DUP', buy_date: '2026-09-05' }]);
  assert.strictEqual(r.byTickerDate, 0, 'an ambiguous match is never a confirmation');
  assert.deepStrictEqual(r.cannotTell.map(c => [c.position_id, c.candidates, c.rivals]), [['x1', 1, 2]], 'named, with why');
  assert.strictEqual(r.missing.length, 1, 'the row is consumed: the second departure has none left');
});

run('nothing departed matches a sale on the wrong date, or a sale with a position_id by ticker', async () => {
  const { classify } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-departed-positions.mjs')).href);
  const r = classify([v('2026-09-07T00:00:00Z', [pos('p', 'TCK', '2026-09-05')])], [], [
    { position_id: null, ticker: 'TCK', buy_date: '2026-09-04' },
    { position_id: 'other', ticker: 'TCK', buy_date: '2026-09-05' },
  ]);
  assert.strictEqual(r.byId + r.byTickerDate, 0); assert.strictEqual(r.missing.length, 1);
});

run('a backup row with no position_id is counted, not guessed', async () => {
  const { classify } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-departed-positions.mjs')).href);
  const r = classify([v('2026-09-07T00:00:00Z', [pos(null, 'NOID', '2026-09-05'), pos('', 'EMPTY', '2026-09-05')])], [], []);
  assert.strictEqual(r.noId, 2); assert.strictEqual(r.seen, 0);
});

run('two candidate rows for one departure: CANNOT TELL, not WEAK', async () => {
  const { classify } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-departed-positions.mjs')).href);
  const r = classify([v('2026-09-07T00:00:00Z', [pos('p', 'TWO', '2026-09-05')])], [], [
    { position_id: null, ticker: 'TWO', buy_date: '2026-09-05' }, { position_id: null, ticker: 'TWO', buy_date: '2026-09-05' }]);
  assert.strictEqual(r.byTickerDate, 0); assert.strictEqual(r.cannotTell.length, 1); assert.strictEqual(r.cannotTell[0].candidates, 2);
});

run('the printed report never adds the tiers into one confirmed total', () => {
  const src = require('fs').readFileSync(path.join(REPO_ROOT, 'scripts/audit-departed-positions.mjs'), 'utf8');
  assert.ok(!/byId\s*\+|byTickerDate\s*\+|cannotTell\.length\s*\+|\+\s*r\.(byId|byTickerDate|cannotTell)/.test(src), 'no sum of tiers anywhere in the script');
  for (const t of ['CONFIRMED, exact', 'WEAK:', 'CANNOT TELL:', 'MISSING:']) assert.ok(src.includes(t), t + ' printed, with its method');
});
