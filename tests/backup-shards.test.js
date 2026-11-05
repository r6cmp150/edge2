// tests/backup-shards.test.js — 2026-11-04. Monthly backup files for signal_log
// and rating_snapshots. A refused push loses every table's backup, and the
// backup is the recovery path, so what has to survive the move is the guarantee:
// the table's rows across all its files, never a silently empty or short backup.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

const load = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'backup-shards.mjs')).href);
const NOW = Date.parse('2026-11-20T06:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-backup-'));

// Enough rows to clear the floors, across two old months, plus recent ones.
const rating = (n, start = 1) => Array.from({ length: n }, (_, i) => ({
  id: start + i, ticker: 'T' + (start + i), score: 50 + (i % 40),
  captured_at: new Date(Date.parse('2026-09-15T15:00:00Z') + (start + i) * 3600e3).toISOString(),
}));
const signal = (n, start = 1) => Array.from({ length: n }, (_, i) => ({
  id: `uuid-${String(start + i).padStart(5, '0')}`, symbol: 'S', ret_close: null, outcomes_filled_at: '2026-10-01T00:00:00Z',
  created_at: new Date(Date.parse('2026-09-15T15:00:00Z') + (start + i) * 1800e3).toISOString(),
}));

// Filters the way PostgREST would, for the `or=(...)` the daily read sends.
function fakeApi(tableRows, log = []) {
  return {
    async readRows(table, filter) {
      log.push(filter);
      if (!filter) return [...tableRows];
      const parts = filter.slice(4, -1).split(/,(?=[a-z_]+\.)/);
      return tableRows.filter(r => parts.some(p => {
        const [col, op, ...rest] = p.split('.'); const v = rest.join('.');
        if (op === 'is') return r[col] == null;
        if (col === 'id') return r.id > Number(v);
        return r[col] != null && Date.parse(r[col]) >= Date.parse(v);
      }));
    },
    async countRows() { return tableRows.length; },
  };
}
const seed = async (dir, table, rows, nowMs = NOW) => {
  const s = await load();
  const out = await s.runShardedTable({ table, dir, api: fakeApi(rows), nowMs, last: null });
  assert.ok(out.ok, out.reason);
  s.writeShards(dir, table, out.texts, out.removeLegacy);
  return { ...out.entry, run_at: new Date(nowMs).toISOString() };
};
const held = (dir, table) => fs.readdirSync(path.join(dir, table)).sort()
  .flatMap(f => JSON.parse(fs.readFileSync(path.join(dir, table, f), 'utf8')));

run('the first run moves the old single file to month files, loses nothing, removes it, and each file is plain JSON', async () => {
  const s = await load();
  const dir = tmp(), rows = rating(3000);
  fs.writeFileSync(path.join(dir, 'rating_snapshots.json'), JSON.stringify(rows, null, 2));
  const out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(rows), nowMs: NOW, last: null });
  assert.ok(out.ok, out.reason);
  assert.strictEqual(out.entry.mode, 'full');
  assert.strictEqual(out.removeLegacy, true);
  s.writeShards(dir, 'rating_snapshots', out.texts, out.removeLegacy);
  assert.ok(!fs.existsSync(path.join(dir, 'rating_snapshots.json')), 'old file gone only after the write');
  const back = held(dir, 'rating_snapshots');
  assert.strictEqual(back.length, 3000);
  assert.deepStrictEqual(back.map(r => r.id), rows.map(r => r.id), 'every row, in order');
  assert.ok(Object.keys(out.entry.shards).length >= 2, 'more than one month');
  assert.strictEqual(Object.values(out.entry.shards).reduce((a, b) => a + b, 0), 3000, 'the manifest adds up to the table');
});

run('a daily read asks only for what can change, and picks up new rows, late retries and late fills', async () => {
  const s = await load();
  const dir = tmp(), rows = rating(3000);
  const last = await seed(dir, 'rating_snapshots', rows);
  const lateRetry = { id: 3001, ticker: 'LATE', score: 70, captured_at: '2026-10-01T15:00:00.000Z' };
  const log = [];
  const out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi([...rows, lateRetry], log), nowMs: NOW + 864e5, last });
  assert.ok(out.ok, out.reason);
  assert.strictEqual(out.entry.mode, 'daily');
  assert.ok(/id\.gt\.3000/.test(log[0]), `reads by id too, for a retried batch: ${log[0]}`);
  assert.strictEqual(out.entry.fetched, 3001, 'the late retry, older than the window, is kept');
  assert.ok(out.entry.read < 3001, 'and it did not read the whole table');

  const recent = rating(3000).map((r, i) => (i === 2999 ? { ...r, captured_at: '2026-11-18T15:00:00.000Z' } : r));
  const dirW = tmp();
  const lastW = await seed(dirW, 'rating_snapshots', recent);
  const changed = recent.map((r, i) => (i === 2999 ? { ...r, score: 11 } : r));
  const outW = await s.runShardedTable({ table: 'rating_snapshots', dir: dirW, api: fakeApi(changed), nowMs: NOW + 864e5, last: lastW });
  assert.strictEqual(Object.values(outW.texts).flatMap(x => JSON.parse(x)).find(r => r.id === 3000).score, 11, 'a change to a row inside the window lands');

  const dirS = tmp(), sig = signal(2000);
  const lastS = await seed(dirS, 'signal_log', sig, Date.parse('2026-11-20T06:00:00Z'));
  const filled = { ...sig[1999], ret_close: 0.02, outcomes_filled_at: '2026-11-20T12:00:00.000Z' };
  const unsettledOld = { ...sig[0], outcomes_filled_at: null };
  const logS = [];
  const outS = await s.runShardedTable({ table: 'signal_log', dir: dirS, api: fakeApi([unsettledOld, ...sig.slice(1, 1999), filled], logS), nowMs: Date.parse('2026-11-21T06:00:00Z'), last: lastS });
  assert.ok(outS.ok, outS.reason);
  assert.ok(/outcomes_filled_at\.is\.null/.test(logS[0]), `re-reads unsettled rows: ${logS[0]}`);
  const all = Object.values(outS.texts).flatMap(t => JSON.parse(t));
  assert.strictEqual(all.find(r => r.id === filled.id).ret_close, 0.02, 'a fill settled since the last run lands, however old the row');
  assert.strictEqual(all.find(r => r.id === sig[0].id).outcomes_filled_at, null, 'an old unsettled row stays current');
});

run('REFUSED, nothing written: an empty read, a shrink, a delete hidden by an insert, a short read, on both tables', async () => {
  const s = await load();
  for (const [table, make] of [['rating_snapshots', () => rating(3000)], ['signal_log', () => signal(2000)]]) {
    const dir = tmp(), rows = make();
    const last = await seed(dir, table, rows);
    const before = JSON.stringify(held(dir, table));
    const next = NOW + 864e5;
    const refused = async (api, why) => {
      const out = await s.runShardedTable({ table, dir, api, nowMs: next, last });
      assert.strictEqual(out.ok, false, `${table}: ${why} must be refused`);
      assert.ok(out.reason, 'with a reason');
      assert.strictEqual(out.texts, undefined, 'and nothing to write');
      assert.deepStrictEqual(out.entry.shards, last.shards, 'and the manifest keeps what the next run checks against');
    };
    await refused({ readRows: async () => [], countRows: async () => 0 }, 'an RLS-denied read');
    await refused(fakeApi(rows.slice(0, -1)), 'one row lost');
    const swapped = [...rows.slice(1), { ...rows[0], id: table === 'signal_log' ? 'uuid-new' : 99999, created_at: new Date(next).toISOString(), captured_at: new Date(next).toISOString() }];
    await refused(fakeApi(swapped), 'a delete hidden by an insert: the count is level');
    await refused({ readRows: async () => [], countRows: async () => rows.length + 5 }, 'rows the read did not return');
    assert.strictEqual(JSON.stringify(held(dir, table)), before, 'the files are untouched');
  }
});

run('REFUSED below the floor on the total, with no prior files at all', async () => {
  const s = await load();
  const rows = rating(100);
  const out = await s.runShardedTable({ table: 'rating_snapshots', dir: tmp(), api: fakeApi(rows), nowMs: NOW, last: null });
  assert.strictEqual(out.ok, false);
  assert.ok(/below this table's floor/.test(out.reason), out.reason);
});

run('REFUSED: a month file missing or short against the last manifest, even though it would make the rest add up', async () => {
  const s = await load();
  const dir = tmp(), rows = rating(3000);
  const last = await seed(dir, 'rating_snapshots', rows);
  const months = Object.keys(last.shards).sort();
  const f = path.join(dir, 'rating_snapshots', `${months[0]}.json`);
  const text = fs.readFileSync(f, 'utf8');
  fs.rmSync(f);
  let out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(rows), nowMs: NOW + 864e5, last });
  assert.strictEqual(out.ok, false, 'a missing month');
  assert.ok(/corrupt prior backup/.test(out.reason) && out.reason.includes(months[0]), out.reason);
  fs.writeFileSync(f, '[]\n');
  out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(rows), nowMs: NOW + 864e5, last });
  assert.strictEqual(out.ok, false, 'an emptied month');
  assert.ok(/corrupt prior backup/.test(out.reason), `named as the file's fault, not the table's: ${out.reason}`);
  fs.writeFileSync(f, 'not json');
  out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(rows), nowMs: NOW + 864e5, last });
  assert.strictEqual(out.ok, false, 'a corrupt month');
  fs.writeFileSync(f, text);
  out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(rows), nowMs: NOW + 864e5, last });
  assert.ok(out.ok, 'restored, it runs');
});

run('a month file that legitimately changes size is fine: growth in one month is not a shrink anywhere', async () => {
  const s = await load();
  const dir = tmp(), rows = rating(3000);
  const last = await seed(dir, 'rating_snapshots', rows);
  const more = rating(50, 3001);
  const out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi([...rows, ...more]), nowMs: NOW + 864e5, last });
  assert.ok(out.ok, out.reason);
  assert.strictEqual(out.entry.fetched, 3050);
});

run('old months are not rewritten; a full read runs once a month and counts what the daily reads missed', async () => {
  const s = await load();
  const dir = tmp(), rows = rating(3000);
  const last = await seed(dir, 'rating_snapshots', rows);
  const oldMonth = Object.keys(last.shards).sort()[0];
  const out = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(rows), nowMs: NOW + 864e5, last });
  assert.deepStrictEqual(s.writeShards(dir, 'rating_snapshots', out.texts, false), [], 'nothing changed, nothing rewritten');

  const edited = rows.map((r, i) => (i === 0 ? { ...r, score: 1 } : r));
  const daily = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(edited), nowMs: NOW + 864e5, last });
  assert.strictEqual(daily.entry.mode, 'daily', 'same month: daily');
  assert.ok(!Object.values(daily.texts).join('').includes('"score":1,'), 'a daily read does not see an old edit');
  const nextMonth = Date.parse('2026-12-01T06:00:00Z');
  const fullRun = await s.runShardedTable({ table: 'rating_snapshots', dir, api: fakeApi(edited), nowMs: nextMonth, last });
  assert.strictEqual(fullRun.entry.mode, 'full', 'new month: full');
  assert.strictEqual(fullRun.entry.changed_outside_window, 1, 'and it says so');
  assert.strictEqual(fullRun.entry.last_full_month, '2026-12');
  assert.deepStrictEqual(s.writeShards(dir, 'rating_snapshots', fullRun.texts, false), [oldMonth], 'only the changed month is rewritten');
});

run('a file over the limit is refused with a reason rather than failing the push for every table', async () => {
  const s = await load();
  assert.ok(s.MAX_FILE_BYTES < 100 * 1024 * 1024, 'under GitHub\'s 100 MiB block');
  const big = 'x'.repeat(40 * 1024 * 1024);
  const rows = rating(3000).map((r, i) => (i < 3 ? { ...r, ticker: big, captured_at: '2026-09-15T15:00:00.000Z' } : r));
  const out = await s.runShardedTable({ table: 'rating_snapshots', dir: tmp(), api: fakeApi(rows), nowMs: NOW, last: null });
  assert.strictEqual(out.ok, false);
  assert.ok(/over the \d+ limit/.test(out.reason), out.reason);
});

run('nothing committed under data/backups is near GitHub\'s block', async () => {
  const s = await load();
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(REPO_ROOT, 'data', 'backups'))) {
    assert.ok(fs.statSync(f).size <= s.MAX_FILE_BYTES, `${f} is ${fs.statSync(f).size} bytes`);
  }
});

run('every whole-file table is still size-checked, and readers work on either layout', async () => {
  const s = await load();
  assert.ok(/Buffer\.byteLength\(text\) > MAX_FILE_BYTES/.test(readSource('scripts/backup-tables.mjs')), 'the whole-file tables too');
  const dir = tmp(), rows = rating(3000);
  fs.writeFileSync(path.join(dir, 'rating_snapshots.json'), JSON.stringify(rows));
  assert.strictEqual(s.readBackupRows(dir, 'rating_snapshots').length, 3000, 'the old single file');
  fs.rmSync(path.join(dir, 'rating_snapshots.json'));
  await seed(dir, 'rating_snapshots', rows);
  assert.strictEqual(s.readBackupRows(dir, 'rating_snapshots').length, 3000, 'month files');
  assert.throws(() => s.readBackupRows(tmp(), 'rating_snapshots'), /no backup of rating_snapshots/, 'absent is an error, not an empty list');
});
