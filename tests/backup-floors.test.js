// tests/backup-floors.test.js — 2026-11-02. RLS answers a read it won't
// allow with an EMPTY LIST, not an error, so a policy mistake would make the
// daily backup "succeed" with nothing in it. The shrink rules caught that for
// the append-only tables only while a prior backup file existed; portfolio
// (whose zero is legitimate) never aborted at all. Now every table has a
// floor, portfolio's empty read must be corroborated by new sales, and each
// run commits a manifest of what it actually wrote.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');
const { readSource, run, REPO_ROOT } = require('./_lib');

const load = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'backup-rules.mjs')).href);

run('an EMPTY read is refused for every table (the RLS-denial shape), with or without a prior backup file', async () => {
  const { judgeTable, MIN_ROWS, TABLE_RULES } = await load();
  assert.deepStrictEqual(Object.keys(MIN_ROWS).sort(), Object.keys(TABLE_RULES).sort(), 'a floor for every table the backup writes');
  for (const table of Object.keys(TABLE_RULES)) {
    if (table === 'portfolio') continue; // judged by corroboration, below
    for (const prior of [0, 5000]) { // 0 = no prior file: the case the shrink rules couldn't see
      const v = judgeTable(table, 0, prior, {});
      assert.strictEqual(v.ok, false, `${table}: empty read with prior ${prior} must be refused`);
    }
    assert.strictEqual(judgeTable(table, MIN_ROWS[table], MIN_ROWS[table], {}).ok, true, `${table}: at its floor, unchanged, is fine`);
    assert.strictEqual(judgeTable(table, MIN_ROWS[table] - 1, 0, {}).ok, false, `${table}: one below the floor, no prior file, is refused`);
  }
});

run('the floors are the committed counts at d6e277d for the tables that only grow (never set above real data)', async () => {
  const { MIN_ROWS } = await load();
  for (const [table, floor] of Object.entries(MIN_ROWS)) {
    if (table === 'portfolio') { assert.strictEqual(floor, 0); continue; }
    let n;
    try { n = JSON.parse(execSync(`git show d6e277d:data/backups/${table}.json`, { cwd: REPO_ROOT, maxBuffer: 2e9 }).toString()).length; }
    catch (e) { console.log(`  (${table} @ d6e277d not readable; skipped)`); continue; }
    assert.strictEqual(floor, n, `${table}: floor ${floor} vs committed ${n}`);
  }
});

run('portfolio: an empty read needs as many new sales as there were holdings; pending orders are not holdings', async () => {
  const { judgeTable, holdingsIn } = await load();
  const ctx = (priorHoldings, v2Prior, v2Fresh) => ({ priorHoldings, tradesV2Prior: v2Prior, tradesV2Fresh: v2Fresh });
  assert.strictEqual(judgeTable('portfolio', 0, 3, ctx(3, 451, 451)).ok, false, '3 holdings vanish with no new sales: an empty read');
  assert.ok(/read back EMPTY with 3 holding\(s\)/.test(judgeTable('portfolio', 0, 3, ctx(3, 451, 452)).reason), 'says why');
  assert.strictEqual(judgeTable('portfolio', 0, 3, ctx(3, 451, 454)).ok, true, '3 holdings, 3 new sales: Roman sold everything');
  assert.strictEqual(judgeTable('portfolio', 0, 2, ctx(0, 451, 451)).ok, true, 'only pending orders before: cancelling them is legitimate');
  assert.strictEqual(judgeTable('portfolio', 0, 3, ctx(3, 451, undefined)).ok, false, 'trades_v2 count unknown: not corroborated');
  assert.strictEqual(judgeTable('portfolio', 34, 1, ctx(1, 451, 467)).ok, true, 'a non-empty read is never refused');
  assert.strictEqual(holdingsIn([{ order_type: 'limit', filled_at: null }, { order_type: 'market', filled_at: 'x' }, { order_type: null, filled_at: null }]), 2,
    'a pending order (type, no fill) is not a holding; legacy rows are');
  assert.strictEqual(holdingsIn(undefined), 0);
});

run('the backup runs main() unconditionally, judges every table through judgeTable, and commits a manifest', () => {
  const src = readSource('scripts/backup-tables.mjs');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/\nmain\(\)\.catch\(/.test(code), 'main() runs at top level');
  assert.ok(!/import\.meta\.url\s*===/.test(code), 'no "run only when executed" guard that could silently skip the backup');
  assert.ok(code.includes('const verdict = judgeTable(table, fresh.length, priorCount, {'), 'the floor is checked for every whole-file table');
  assert.ok(readSource('scripts/lib/backup-shards.mjs').includes('judgeTable(table, merged.size, held.length, {})'), 'and on the total of every month-file table');
  assert.ok(!/TABLE_RULES\[table\]\(/.test(code), 'no table bypasses the floor by calling its rule directly');
  assert.ok(code.includes("writeFileSync(path.join(BACKUP_DIR, '_manifest.json')"), 'manifest written');
  assert.ok(readSource('.github/workflows/backup-tables.yml').includes('git add -A data/backups'), 'and committed with the backups, month folders and the old file\'s removal included');
});
