// tests/db038-sql.test.js — 2026-11-06. db/038's SQL, carved to main ahead of the app code that fills its columns (main
// is deployable at every commit: the migration first, Roman runs it, then the app). The SQL-only checks; the app-side
// ones stay with the gated app code (tests/verdict-a.test.js there). The schema harness proves the rest by behaviour:
// db/038 applies on today's live state, the deployed app's writes all still succeed after it, and the undo is exact.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { run, readSource } = require('./_lib');

// The revision stamp is tied to the contents: change the file and this fails until the stamp moves too.
const sql = readSource('db/038_macro_observe_only_and_settings.sql').replace(/\r\n/g, '\n');
const run2 = readSource('db/038-run-2-behaviour.sql').replace(/\r\n/g, '\n');
const undo = readSource('db/038-rollback.sql').replace(/\r\n/g, '\n');
const STAMP = '2026-11-06-e';
const SHA = '930c509506b8a47ae6717faea7b633200c9fc95fe22bec1d48e7a0d5c5c3346b';
const added = () => {
  const out = [];
  for (const block of sql.matchAll(/alter table ([a-z_0-9]+)\n([\s\S]*?);/g)) for (const m of block[2].matchAll(/add column ([a-z_0-9]+)/g)) out.push(`${block[1]}.${m[1]}`);
  return out;
};

(async () => {
await run('db/038 carries a revision, run 2 reads it back from the database, and the stamp moves with the file', () => {
  assert.ok(sql.includes(`-- REVISION ${STAMP}.`));
  assert.ok(sql.includes(`db038_revision=${STAMP}`), 'stored in the database');
  assert.ok(run2.includes(`expected_revision constant text := '${STAMP}'`), 'the check expects the same one');
  assert.ok(/obj_description\('public\.macro_observations'::regclass\)/.test(run2), 'read back, not assumed');
  assert.ok(/applied_revision is distinct from expected_revision/.test(run2), 'and it fails on any other');
  assert.strictEqual(crypto.createHash('sha256').update(sql).digest('hex'), SHA, 'db/038 changed: change its REVISION in both files, then this pin, and say earlier copies are void');
});

await run('run 2 verifies each part on its own, so a failure names which', () => {
  for (const p of ['macro', 'settings', 'sell_filled_at', 'capture and scoring', 'verdict A']) assert.ok(run2.includes(`('${p}', '`), p);
  const partOf = {};
  for (const m of run2.matchAll(/\('(macro|settings|sell_filled_at|capture and scoring|verdict A)', '([a-z_0-9]+)', '([a-z_0-9]+)'\)/g)) partOf[`${m[2]}.${m[3]}`] = m[1];
  assert.ok(added().length >= 15, `found ${added().length} columns`);
  assert.deepStrictEqual(added().filter(c => !partOf[c]), [], 'every column db/038 adds is verified under a part');
  for (const c of ['sell_filled_at-consistent', 'sell_filled_at-needs-source', 'verdict-consistent', 'verdict-needs-state', 'verdict-state', 'verdict-write-once']) assert.ok(run2.includes(c), c);
  assert.ok(sql.includes('revoke all on macro_observations from anon, authenticated;\ngrant select, insert on macro_observations to anon;'), 'explicit grants on macro_observations, not the default ACL');
  assert.ok(run2.includes("format(' macro_observations-grid(%s/24)', g_ok)"), 'the 24-probe grid');
  assert.ok(sql.includes("execute function trades_v2_reject_provenance_change('verdict_displayed_at_sale', 'verdict_display_state')"), 'write-once');
});

await run('safe against the app as deployed: every added column is nullable or has a default', () => {
  // a NOT NULL without a default would break the current app's inserts the moment it lands
  const bad = [];
  for (const block of sql.matchAll(/alter table ([a-z_0-9]+)\n([\s\S]*?);/g)) {
    for (const m of block[2].matchAll(/add column ([a-z_0-9]+)([^\n]*(?:\n\s+check[^\n]*)?)/g)) {
      if (/not null/i.test(m[2]) && !/\bdefault\b/i.test(m[2])) bad.push(`${block[1]}.${m[1]}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

await run('one macro-path vocabulary: "sent nothing" and "ran, no verdict" are different values in every column', () => {
  // the dataset exists to decide whether market condition should affect the score: "not measured" and "measured,
  // indeterminate" must be separable by value, never by one value and the absence of another
  const lists = [...sql.matchAll(/check \((?:macro_path|macro_path_at_buy|path) in \(([^)]*)\)\)/g)].map(m => m[1].replace(/\s+/g, ''));
  assert.strictEqual(lists.length, 4, 'macro_observations.path, rating_snapshots.macro_path, trades_v2.macro_path, portfolio.macro_path_at_buy');
  for (const l of lists) assert.ok(l.includes("'unclassified'") && l.includes("'not_fetched'") && l.includes("'pattern_groq_failed'"), l);
  assert.strictEqual(lists.filter(l => l.includes("'unknown'")).length, 3, "'unknown' (the writer sent nothing) on the three tables a writer fills; an observation always has a path");
  assert.ok(/add column macro_path_at_buy text not null default 'unknown'/.test(sql), 'portfolio says "sent nothing" as the other two do, not as NULL');
  assert.strictEqual((sql.match(/add column macro_path text not null default 'unknown'/g) || []).length, 2);
  for (const c of ['rating_snapshots.macro_path', 'trades_v2.macro_path', 'portfolio.macro_path_at_buy']) assert.ok(new RegExp(`comment on column ${c.replace('.', '\\.')} is '[^\\n]*unknown = the writer sent no macro reading[^\\n]*unclassified = the engine ran`).test(sql), `${c}: the vocabulary in its comment`);
  assert.ok(run2.includes("('macro-path-vocabulary', 'a macro path outside the vocabulary'") && run2.includes("' unclassified-allowed'"), 'run 2 proves both by behaviour');
  assert.ok(undo.includes("where macro_path_at_buy <> 'unknown'"), 'the undo\'s guard reads the new encoding');
  assert.ok(undo.includes('AVAILABLE ONLY BETWEEN db/038 AND THE APP-CODE PUSH, BY DESIGN'));
});

await run('the undo: drops exactly what db/038 adds, idempotently, behind a three-state guard, and restores the sell_time comment', () => {
  const dropped = [];
  for (const block of undo.matchAll(/alter table ([a-z_0-9]+)\s*\n?([\s\S]*?);/g)) for (const m of block[2].matchAll(/drop column if exists ([a-z_0-9]+)/g)) dropped.push(`${block[1]}.${m[1]}`);
  assert.deepStrictEqual([...dropped].sort(), [...added()].sort(), 'every column db/038 adds, and nothing else');
  assert.ok(/drop table if exists macro_observations;/.test(undo) && /drop trigger if exists trades_v2_verdict_display_write_once on trades_v2;/.test(undo));
  assert.ok(!/\bdrop (column|table|trigger|constraint)\s+(?!if exists)/i.test(undo), 'every drop is "if exists": runnable on any state, and twice');
  assert.ok(/if \(held <> ''\) is not false then\s*raise exception 'db\/038 ROLLBACK ABORTED, nothing changed/.test(undo), 'aborts if data would be lost');
  assert.ok(undo.includes("comment on column trades_v2.sell_time is 'SELL FILL time, PT wall clock HH:MM. (db/027)';"), 'db/027\'s comment back, as it was');
});
})();
