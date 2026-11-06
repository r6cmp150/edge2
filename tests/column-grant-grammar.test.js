// tests/column-grant-grammar.test.js — 2026-11-06. In GRANT/REVOKE, a column list binds only to the privilege right
// before it: "revoke insert, update (col) on t" revokes INSERT on the WHOLE TABLE, plus UPDATE on col. Written that way
// in db/037, it revoked anon's table-level INSERT on portfolio (the schema harness caught it: adding a position would
// have failed). So in every migration not yet applied, a GRANT or REVOKE with a column list names exactly ONE
// privilege. Applied migrations (up to db/035, and db/040) are history.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, REPO_ROOT } = require('./_lib');

const APPLIED = n => n <= 35 || n === 40;
// every GRANT/REVOKE statement that carries a column list, with the privileges written before the first "("
function columnStatements(sql) {
  const out = [];
  const text = sql.replace(/--[^\n]*/g, '');
  for (const m of text.matchAll(/\b(grant|revoke)\s+([a-z ,]+?)\s*\(([^)]*)\)\s*on\b/gi)) {
    out.push({ verb: m[1].toLowerCase(), privs: m[2].split(',').map(s => s.trim()).filter(Boolean), cols: m[3] });
  }
  return out;
}

(async () => {
await run('the detector: a privilege list before a column list is caught; one privilege is not', () => {
  assert.deepStrictEqual(columnStatements('revoke insert, update (a) on t from anon;').map(s => s.privs), [['insert', 'update']]);
  assert.deepStrictEqual(columnStatements('grant select, update (\n a, b\n) on t to r;').map(s => s.privs), [['select', 'update']], 'across lines');
  assert.deepStrictEqual(columnStatements('revoke insert (a, b) on t from anon;\nrevoke update (a) on t from anon;').map(s => s.privs), [['insert'], ['update']]);
  assert.strictEqual(columnStatements('grant select, insert on t to anon; -- insert, update (x) on t').length, 0, 'no column list, and comments ignored');
  assert.strictEqual(columnStatements("execute function f('a', 'b');").length, 0, 'not a grant');
});

await run('every GRANT/REVOKE with a column list in an unapplied migration names exactly one privilege', () => {
  const dir = path.join(REPO_ROOT, 'db');
  const bad = [];
  let seen = 0;
  for (const f of fs.readdirSync(dir).filter(f => /^\d{3}[-_].*\.sql$/.test(f) && !APPLIED(Number(f.slice(0, 3))))) {
    for (const s of columnStatements(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      seen++;
      if (s.privs.length !== 1) bad.push(`${f}: ${s.verb} ${s.privs.join(', ')} (${s.cols.replace(/\s+/g, ' ').slice(0, 40)}...)`);
    }
  }
  assert.ok(seen >= 10, `column statements seen: ${seen}`);
  assert.deepStrictEqual(bad, []);
});
})();
