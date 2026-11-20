// tests/data-six-positions-sql.test.js -- 2026-11-20. db/data-2026-11-20-six-positions-declared-paper.sql, the data
// correction of six 11/2 portfolio rows to paper, sourced 'declared_by_roman_2026-11-20' (Roman, 2026-11-20). The SQL-only
// checks. The schema harness (pg-harness/test-six.mjs, outside the repo, PGlite 0.5.10 = PostgreSQL 18.6, generated from
// test-044.mjs's build on the 2026-11-11b capture with the real 2026-11-19 backup rows) proved it by behaviour, 12 of 12:
// the six become paper with that source and the CHECK accepts it; every other row byte-identical; a second run, one row
// already paper, and one row gone each abort with nothing changed; a trigger touching another row rolls it back. It also
// caught a defect first: buy_date is a calendar date stored at 00:00 UTC, so the guard read in Pacific time saw 11-01.
// Changing the file means proving it again: move the pin only after test-six passes on the new text.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { run, readSource } = require('./_lib');

const FILE = 'db/data-2026-11-20-six-positions-declared-paper.sql';
const sql = readSource(FILE);
const IDS = ['1793633798712', '1793633909422', '1793633954632', '1793633983466', '1793634490939', '1793637556143'];

run('the harness-proved text, pinned', () => {
  assert.strictEqual(crypto.createHash('sha256').update(sql).digest('hex'), 'd24256a6662550123d8f2a7b319106da055a350cbdb768c0d78fa48bef2a4faa');
});
run('the six rows, by position_id, and no others; the source in db/042\'s shape; one transaction', () => {
  const inArray = sql.match(/ids constant text\[\] := array\[([^\]]+)\]/)[1].match(/'(\d+)'/g).map(s => s.slice(1, -1));
  assert.deepStrictEqual(inArray, IDS);
  assert.ok(/execution_mode_source = 'declared_by_roman_2026-11-20'/.test(sql) && /^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test('declared_by_roman_2026-11-20'));
  assert.strictEqual((sql.match(/^begin;$/gm) || []).length, 1); assert.strictEqual((sql.match(/^commit;$/gm) || []).length, 1);
  assert.ok(/\(buy_date at time zone 'UTC'\)::date = date '2026-11-02'/.test(sql), 'the guard reads the calendar date in UTC');
  assert.ok(!/at time zone 'America\/Los_Angeles'/.test(sql.replace(/^--.*$/gm, '')), 'never in Pacific time');
});
