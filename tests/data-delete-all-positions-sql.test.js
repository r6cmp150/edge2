// tests/data-delete-all-positions-sql.test.js -- 2026-11-23. db/data-2026-11-23-delete-all-open-positions.sql, Roman's
// permanent delete of every open position. The SQL-only checks. The schema harness (pg-harness/test-delete.mjs, outside
// the repo, PGlite 0.5.10 = PostgreSQL 18.6, test-044.mjs's build on the 2026-11-11b capture, the 46 EXPORTED rows and
// the real trades_v2 backup) proved it by behaviour, 11 of 11: the 46 deleted, listed with their cost (total $24,764.45);
// trades_v2 and another table byte-identical; a second run, a row added since the export, and an exported row missing
// each abort with nothing changed; a delete trigger touching trades_v2, or any other table, rolls it back. It caught a
// defect first: a second run in one session failed on the temp table instead of aborting (now dropped first).
// Changing the file means proving it again: move the pin only after test-delete passes on the new text.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { run, readSource } = require('./_lib');

const FILE = 'db/data-2026-11-23-delete-all-open-positions.sql';
const sql = readSource(FILE);
const EXPORT_FILE = 'data/exports/portfolio-2026-11-23-before-delete.json';

run('the harness-proved text, pinned', () => {
  assert.strictEqual(crypto.createHash('sha256').update(sql).digest('hex'), '1b6a113dc6a7c1f2491f433db7b796dba48140706a2df6ad1c891d73c892c88d');
});

run('the export it deletes is committed and is the one named, by its sha256', () => {
  const exp = readSource(EXPORT_FILE);
  assert.strictEqual(crypto.createHash('sha256').update(exp).digest('hex'), '954e2bd9af4369bf01e020cf51e55290030d50d9f0c5a26e5a54fe2f01add229');
  assert.ok(sql.includes('954e2bd9af4369bf01e020cf51e55290030d50d9f0c5a26e5a54fe2f01add229') && sql.includes('(8fcf7ab)'), 'the SQL names the export and its commit');
});

run('exactly the exported position_ids, no others; guarded on 46; one transaction; every other table fingerprinted', () => {
  const exp = JSON.parse(readSource(EXPORT_FILE));
  const inArray = sql.match(/ids constant text\[\] := array\[([^\]]+)\]/)[1].match(/'(\d+)'/g).map(s => s.slice(1, -1));
  assert.deepStrictEqual(inArray, exp.rows.map(r => r.position_id).sort());
  assert.strictEqual(exp.row_count, 46); assert.strictEqual(inArray.length, 46);
  assert.ok(/if n <> 46 then raise exception 'ABORTED, nothing changed: portfolio holds % rows/.test(sql));
  assert.ok(/if n <> 46 then raise exception 'ABORTED, nothing changed: only % of the 46 exported position_ids/.test(sql));
  assert.strictEqual((sql.match(/^begin;$/gm) || []).length, 1); assert.strictEqual((sql.match(/^commit;$/gm) || []).length, 1);
  assert.ok(/from pg_tables where schemaname = 'public' and tablename <> 'portfolio'/.test(sql) && /ROLLED BACK: table % changed during the delete/.test(sql));
  assert.ok(!/delete from (public\.)?trades_v2|update (public\.)?trades_v2/i.test(sql.replace(/^--.*$/gm, '')), 'never writes trades_v2');
  assert.ok(/^drop table if exists deleted_positions;/m.test(sql), 'a second run in one session aborts on its guard, not on the temp table');
});
