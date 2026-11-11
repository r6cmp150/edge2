// tests/db043-sql.test.js — 2026-11-11. db/043's SQL, on main ahead of the app code that writes its value (main is
// deployable at every commit: the migration first, Roman runs it, then the app). The SQL-only checks; the schema
// harness (test-043.mjs, outside the repo) proves the rest by behaviour on the 2026-11-11 capture: run 1 applies
// on db/042's live CHECK text, run 2 passes, the deployed app's sale still lands, the rollback is exact and guarded,
// every guard aborts with nothing changed, and five SQL mutants die.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { run, readSource } = require('./_lib');

const norm = f => readSource(f).replace(/\r\n/g, '\n');
const sql042 = norm('db/042_execution_mode.sql');
const sql = norm('db/043_execution_mode_copied_source.sql');
const run2 = norm('db/043-run-2-behaviour.sql');
const undo = norm('db/043-rollback.sql');
// Changing a file the harness proved means proving it again: move the pin only after test-043 passes on the new text.
const PINS = {
  'db/043_execution_mode_copied_source.sql': 'b5e19bd31ccdb3fc461548f21c37894a25aedb97c658494ab583ea43aaf6527b',
  'db/043-run-2-behaviour.sql': '3c81292586a8da8981c02f188a30ab824c1b547af83d89719454d25261bd2b30',
  'db/043-rollback.sql': 'deb4c4a16d7a492d9aa432347f0a24d6e77e09eb044192ca069271be15f1cf05',
};

// The source vocabulary of a trades_v2 execution-mode CHECK as written: the literals and the patterns.
const block = (text, from) => {
  const i = text.indexOf(from);
  assert.ok(i >= 0, `no "${from}"`);
  return text.slice(i, text.indexOf(';', i));
};
const sources = text => [
  ...[...text.matchAll(/execution_mode_source = '([^']+)'/g)].map(m => m[1]),
  ...[...text.matchAll(/execution_mode_source ~ '([^']+)'/g)].map(m => `~${m[1]}`),
].sort();
const ADD = 'alter table trades_v2 add constraint trades_v2_execution_mode_chk check (';

(async () => {
await run('PINS names each db/043 file exactly once, read from this file\'s own text', () => {
  // Object.keys cannot see a duplicate key: the literal collapses it (the last wins) before any code runs. So the
  // check reads the source: a stale pin shadowed by a later line would otherwise pass while reading as current.
  const self = readSource('tests/db043-sql.test.js').replace(/\r\n/g, '\n');
  const body = self.slice(self.indexOf('const PINS = {'), self.indexOf('};', self.indexOf('const PINS = {')));
  const keys = [...body.matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]);
  const files = ['db/043_execution_mode_copied_source.sql', 'db/043-run-2-behaviour.sql', 'db/043-rollback.sql'];
  assert.deepStrictEqual(keys, files, 'exactly these three, once each, in this order');
  assert.deepStrictEqual(Object.keys(PINS), files);
});

await run('the three files are the ones the harness proved (sha256 pins)', () => {
  for (const [f, pin] of Object.entries(PINS)) {
    const got = crypto.createHash('sha256').update(norm(f)).digest('hex');
    assert.strictEqual(got, pin, `${f} changed (or its pin was never set): re-run test-043, then pin ${got}`);
  }
});

await run('db/043 adds exactly one source, copied_from_position, to db/042\'s trades_v2 CHECK, and nothing else', () => {
  const before = sources(block(sql042, ADD)), after = sources(block(sql, ADD));
  assert.deepStrictEqual(after.filter(s => !before.includes(s)), ['copied_from_position'], 'exactly the one value asked for');
  assert.deepStrictEqual(before.filter(s => !after.includes(s)), [], 'every source db/042 allowed still allowed');
  // apart from the one added line, the constraint text is db/042's
  assert.strictEqual(block(sql, ADD).replace("\n       or execution_mode_source = 'copied_from_position'", ''), block(sql042, ADD));
});

await run('portfolio and the other tables are untouched', () => {
  assert.ok(!/alter table (?!trades_v2\b)/i.test(sql), 'only trades_v2 is altered');
  assert.deepStrictEqual([...sql.matchAll(/alter table trades_v2 (\w+ constraint \w+)/g)].map(m => m[1]),
    ['drop constraint trades_v2_execution_mode_chk', 'add constraint trades_v2_execution_mode_chk']);
  assert.ok(!/\b(add column|drop column|grant|revoke|create (table|policy|trigger|function))\b/i.test(sql));
});

await run('the rollback restores db/042\'s constraint and comment, character for character', () => {
  assert.strictEqual(block(undo, ADD), block(sql042, ADD));
  const comment = t => t.match(/comment on column trades_v2\.execution_mode_source is '(?:[^']|'')*';/)[0];
  assert.strictEqual(comment(undo), comment(sql042));
  assert.ok(/copied_from_position/.test(comment(sql)), 'run 1 names the new source in the comment');
});

await run('the guard literal is the same text in run 1 (twice) and the rollback, and run 2 probes the new source on every mode', () => {
  const lits = [...sql.matchAll(/\$d\$(CHECK [\s\S]*?)\$d\$/g), ...undo.matchAll(/\$d\$(CHECK [\s\S]*?)\$d\$/g)].map(m => m[1]);
  assert.strictEqual(lits.length, 3);
  assert.strictEqual(new Set(lits).size, 1, 'one spelling of db/042 as captured');
  for (const m of ['live', 'paper', 'not_known']) assert.ok(run2.includes(`jsonb_build_array('trades_v2', '${m}', 'copied_from_position', 'key'`), m);
  assert.ok(run2.includes(`jsonb_build_array('portfolio', 'paper', 'copied_from_position', 'check'`), 'portfolio stays refused');
});
})();
