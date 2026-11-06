// tests/db039-sql.test.js — 2026-11-06. db/039's SQL, carved to main ahead of the app code that fills its columns (main
// is deployable at every commit: the migration first, Roman runs it, then the app). The SQL-only checks; the schema
// harness proves the rest by behaviour: db/039 applies on today's live state, the deployed app's writes all still
// succeed after it, the function's ACL is exactly its owner and outcome_filler, and the undo is exact and guarded.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { run, readSource } = require('./_lib');

// The revision stamp is tied to the contents: change the file and this fails until the stamp moves too.
const sql = readSource('db/039_rating_snapshots_outcomes.sql').replace(/\r\n/g, '\n');
const run2 = readSource('db/039-run-2-behaviour.sql').replace(/\r\n/g, '\n');
const undo = readSource('db/039-rollback.sql').replace(/\r\n/g, '\n');
const STAMP = '2026-11-06-a';
const SHA = '7e74262395d2dc40b75671d02f3475a77570015298c85c25ad88df2e05377d40';
const added = () => {
  const out = [];
  for (const block of sql.matchAll(/alter table ([a-z_0-9]+)\n([\s\S]*?);/g)) for (const m of block[2].matchAll(/add column ([a-z_0-9]+)/g)) out.push(`${block[1]}.${m[1]}`);
  return out;
};

(async () => {
await run('db/039 carries a revision, run 2 reads it back from the database, and the stamp moves with the file', () => {
  assert.ok(sql.startsWith(`-- REVISION ${STAMP}.`));
  assert.ok(sql.includes(`db039_revision=${STAMP}'`), 'stored in the database, on the function');
  assert.ok(run2.includes(`expected_revision constant text := '${STAMP}'`), 'the check expects the same one');
  assert.ok(/obj_description\(to_regprocedure\('public\.fill_rating_outcomes\(jsonb\)'\), 'pg_proc'\)/.test(run2), 'read back, not assumed');
  assert.ok(/applied_revision is distinct from expected_revision\) is not false then\s*raise exception 'db\/039 run 2 RESULT: FAIL/.test(run2), 'and it fails on any other');
  assert.strictEqual(crypto.createHash('sha256').update(sql).digest('hex'), SHA, 'db/039 changed: change its REVISION in both files, then this pin, and say earlier copies are void');
});

await run('safe against the app as deployed: every added column nullable or defaulted; the one CHECK definite on NULL', () => {
  const bad = [];
  for (const m of sql.matchAll(/add column ([a-z_0-9]+)([^,;\n]*)/g)) if (/not null/i.test(m[2]) && !/\bdefault\b/i.test(m[2])) bad.push(m[1]);
  assert.deepStrictEqual(bad, [], 'a NOT NULL without a default breaks the deployed app\'s inserts the moment it lands');
  assert.strictEqual(added().length, 15);
  const checks = [...sql.matchAll(/add column [a-z_0-9]+ [^\n]*? check \(([^\n]*?)\);/g)].map(m => m[1]); // a column CHECK, not a policy's "with check"
  assert.deepStrictEqual(checks, ["outcome_selection is null or outcome_selection in ('first_in_30min', 'not_selected')"], 'the deployed app leaves it NULL: TRUE through "is null", never passed by a NULL');
  assert.ok(!/create trigger/i.test(sql), 'no trigger on a path the deployed app takes');
  assert.deepStrictEqual([...sql.matchAll(/create policy "[^"]+" on rating_snapshots for (\w+) to (\w+)/g)].map(m => `${m[1]}:${m[2]}`), ['select:outcome_filler', 'update:outcome_filler'], 'policies for outcome_filler only');
});

await run('the function\'s ACL is explicit: every default-ACL grantee revoked, exactly owner + outcome_filler after', () => {
  assert.ok(sql.includes('revoke all on function fill_rating_outcomes(jsonb) from public;'));
  assert.ok(/for g in select distinct pg_get_userbyid\(a\.grantee\)::text\s+from pg_proc p, aclexplode\(p\.proacl\) a\s+where p\.oid = 'public\.fill_rating_outcomes\(jsonb\)'::regprocedure\s+and a\.grantee <> 0 and a\.grantee <> p\.proowner loop\s+execute format\('revoke all on function public\.fill_rating_outcomes\(jsonb\) from %I', g\);/.test(sql), 'read from the function\'s own ACL, not a list of names (the draft\'s list left service_role)');
  assert.ok(sql.indexOf('grant execute on function fill_rating_outcomes(jsonb) to outcome_filler;') > sql.indexOf("execute format('revoke all on function"), 'granted after the revokes');
  assert.ok(/is distinct from 'outcome_filler'\) is not false then\s*raise exception 'db\/039 ABORTED, rolled back: fill_rating_outcomes'' ACL is not exactly its owner and outcome_filler'/.test(sql), 'the post-condition, three-state');
  assert.ok(/has_function_privilege\('authenticated', 'public\.fill_rating_outcomes\(jsonb\)', 'EXECUTE'\)/.test(sql));
  assert.ok(/language sql security invoker set search_path = public, pg_temp/.test(sql), 'SECURITY INVOKER, pinned search_path');
  assert.ok(run2.includes("set local role service_role; perform fill_rating_outcomes('[]'::jsonb);"), 'run 2 tries service_role by behaviour');
});

await run('the undo: drops exactly what db/039 adds, idempotently, behind a three-state guard on the new columns\' data', () => {
  const dropped = [];
  for (const block of undo.matchAll(/alter table ([a-z_0-9]+)\s*\n?([\s\S]*?);/g)) for (const m of block[2].matchAll(/drop column if exists ([a-z_0-9]+)/g)) dropped.push(`${block[1]}.${m[1]}`);
  assert.deepStrictEqual([...dropped].sort(), [...added()].sort(), 'every column db/039 adds, and nothing else');
  assert.ok(!/\bdrop (column|table|trigger|constraint|function|policy)\s+(?!if exists)/i.test(undo), 'every drop is "if exists"');
  assert.ok(undo.includes('drop function if exists fill_rating_outcomes(jsonb);') && undo.includes('drop policy if exists "outcome filler update" on rating_snapshots;') && undo.includes('drop policy if exists "outcome filler select" on rating_snapshots;'));
  const guard = undo.match(/execute \$q\$select count\(\*\) from rating_snapshots([\s\S]*?)\$q\$/);
  assert.ok(guard, 'a data guard');
  for (const c of added().map(x => x.split('.')[1])) assert.ok(new RegExp(`\\b${c}\\b`).test(guard[1]), `the guard reads ${c}`);
  assert.ok(/if \(n > 0\) is not false then\s*raise exception 'db\/039 ROLLBACK ABORTED, nothing changed/.test(undo), 'three-state');
  assert.ok(undo.includes('AVAILABLE ONLY BETWEEN db/039 AND THE FIRST OUTCOME FILL, BY DESIGN'));
});
})();
