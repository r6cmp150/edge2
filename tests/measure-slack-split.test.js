// tests/measure-slack-split.test.js -- 2026-11-27. The slack split (scripts/measure-slack-split.mjs): allocated bytes =
// live + index + structural overhead + slack, with the overhead read from a never-updated table of the same kind, and
// the allocated trend counting index and overhead as growth. On fixtures, and on the committed RUN-ME-23 cell.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const S = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-slack-split.mjs')).href);
const t = (table, total, index, live, rows = 100) => ({ table, total_bytes: total, index_bytes: index, live_data_bytes: live, rows });

await run('the split: index and structural overhead are not slack; overhead comes from the reference table', () => {
  const cell = { public_tables: [
    t('signal_snapshot_at_buy', 1250, 50, 1000), // never updated: o = 1200/1000 - 1 = 20%
    t('rating_snapshots', 1150, 100, 1000),       // its own reference: o = 5%
    t('signal_log', 2000, 100, 1000),             // 1900 non-index; overhead 200 (20%, from the snapshot table); slack 700
    t('trades_v2', 1300, 50, 1000),               // 1250 non-index; overhead 200; slack 50
  ] };
  const p = S.split(cell);
  assert.ok(Math.abs(p.signal_log.o - 0.2) < 1e-12 && Math.abs(p.signal_log.overhead - 200) < 1e-9 && Math.abs(p.signal_log.slack - 700) < 1e-9);
  assert.ok(Math.abs(p.rating_snapshots.o - 0.05) < 1e-12 && Math.abs(p.rating_snapshots.slack) < 1e-9, 'its own reference: no slack by construction');
  assert.ok(Math.abs(p.trades_v2.slack - 50) < 1e-9);
  for (const x of Object.values(p)) assert.ok(Math.abs(x.live + x.index + x.overhead + x.slack - x.total) < 1e-9, 'the parts add up to the total');
});

await run('the allocated trend counts live growth with its overhead, plus index bytes per row times new rows', () => {
  const parts = { a: { o: 0.2, index: 2e6, rows: 1000 } };
  const tr = S.allocatedTrend(parts, { a: 1 }, { a: 500 });
  assert.ok(Math.abs(tr.sum - (1.2 + 1)) < 1e-12, '1 MB live x 1.2, plus 2,000 B per row x 500 rows = 1 MB');
});

await run('on the committed RUN-ME-23 cell (a transcription): 21 tables, the totals the reviewer validated, and four parts that add up', () => {
  const cell = JSON.parse(readSource('data/db-reads/run-me-23-2026-11-27.json'));
  assert.strictEqual(cell.public_tables.length, 21);
  assert.strictEqual(cell.public_tables.reduce((s, x) => s + x.total_bytes, 0), 52436992);
  assert.strictEqual(cell.public_tables.reduce((s, x) => s + x.live_data_bytes, 0), 33689147);
  assert.strictEqual(cell.stats_reset, null, 'the counters cover the database\'s whole life');
  // every total is heap + TOAST + index + the free-space and visibility maps (0, 24 or 32 KB): the cell is self-consistent
  for (const x of cell.public_tables) assert.ok([0, 24576, 32768].includes(x.total_bytes - x.heap_bytes - x.toast_bytes - x.index_bytes), x.table);
  const pc = cell.public_tables.find(x => x.table === 'peak_corrections');
  assert.deepStrictEqual([pc.inserted, pc.deleted, pc.rows, pc.dead_rows], [2, 0, 0, 2], 'rolled back, never deleted');
  const p = S.split(cell);
  assert.ok(p.signal_log.slack > 5e6 && p.signal_log.slack < 6.5e6 && p.rating_snapshots.slack === 0);
});
})();
