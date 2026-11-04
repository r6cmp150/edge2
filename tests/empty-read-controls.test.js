// tests/empty-read-controls.test.js — 2026-11-02, auth step 4½. The
// classifications in tests/empty-read-sites.test.js say WHY each read is safe
// on an empty result; this checks that the reason is still true in the code:
// the positive control behaves, it runs BEFORE the reads it guards, every
// post-write re-read is asserted, and the app keeps its copy rather than
// overwrite it with nothing. Deleting a control fails here even though the
// read count (all the registry sees) is unchanged.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

run('assertReadable: a row passes; empty or an error throws, naming the table', async () => {
  const { assertReadable, assertReReadComplete } = await import('../scripts/lib/readable.mjs');
  const f = (status, rows) => async () => ({ status, json: async () => rows, text: async () => 'x' });
  await assertReadable('u', {}, 'trades_v2', f(200, [{ id: 1 }]));
  await assert.rejects(assertReadable('u', {}, 'trades_v2', f(200, [])), /trades_v2 reads back EMPTY/);
  await assert.rejects(assertReadable('u', {}, 'trades_v2', f(401, null)), /positive-control read failed/);
  assert.throws(() => assertReReadComplete('x', 3, 2), /found 2 of 3/);
  assertReReadComplete('x', 3, 3);
});

const before = (src, a, b, label) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert.ok(i >= 0, `${label}: control not found`); assert.ok(j >= 0, `${label}: guarded read not found`);
  assert.ok(i < j, `${label}: the control must run before the read it guards`);
};
run('each script runs its control before the reads it guards', () => {
  const fo = readSource('scripts/fill-outcomes.mjs');
  for (const t of ['signal_log', 'trades_v2']) before(fo, `await assertReadable(SUPABASE_URL, anonHeaders, '${t}');`, 'const rowsRes = await fetch(', `fill-outcomes ${t}`);
  // ...and nothing in fill-outcomes reads before those controls
  const firstRead = fo.search(/fetch\(\s*`\$\{SUPABASE_URL\}\/rest\/v1\/[a-z_]+\?select=/);
  assert.ok(fo.indexOf("assertReadable(SUPABASE_URL, anonHeaders, 'trades_v2')") < firstRead, 'fill-outcomes: a read precedes the controls');
  const sg = readSource('scripts/lib/scan-gate.mjs');
  before(sg, "'scan_runs');", '/rest/v1/scan_runs?engine_source=eq.', 'scan gate');
  const sp = readSource('scripts/audit-signal-log-splits.mjs');
  before(sp, "await assertReadable(SUPABASE_URL, anonHeaders, 'signal_log');", '/rest/v1/signal_log?select=${selectCols}&or=', 'splits audit');
  for (const [f, t, verify] of [['scripts/log-signals-edge.mjs', 'signal_log', 'const verifyBody = await verifyRes.json();'],
    ['scripts/log-signals-warrior.mjs', 'signal_log', 'const verifyBody = await verifyRes.json();'],
    ['scripts/log-signals-warrior.mjs', 'setup_triggers', 'const triggerVerifyBody = await triggerVerifyRes.json();']]) {
    const src = readSource(f);
    before(src, `await assertReadable(SUPABASE_URL, headers, '${t}');`, verify, `${f} ${t}`);
  }
});

run('setup_triggers can truly be empty, so its control runs only after this run inserted', () => {
  const src = readSource('scripts/log-signals-warrior.mjs');
  const block = src.indexOf('if (setupTriggerRows.length) {'), failed = src.indexOf('setup_triggers insert failed');
  const control = src.indexOf("assertReadable(SUPABASE_URL, headers, 'setup_triggers')");
  assert.ok(block >= 0 && failed > block && control > failed, 'outside the insert block, the control fails every run on an empty table');
});

run('every post-write re-read is asserted, never just printed', () => {
  for (const f of ['scripts/fill-outcomes.mjs', 'scripts/audit-signal-log-splits.mjs']) {
    const src = readSource(f);
    const reads = (src.match(/= await selectByIds\(/g) || []).length;
    const asserted = (src.match(/assertReReadComplete\(/g) || []).length;
    assert.ok(reads > 0 && asserted >= reads, `${f}: ${reads} re-read(s), ${asserted} asserted`);
  }
  assert.strictEqual((readSource('scripts/log-signals-edge.mjs').match(/assertReReadComplete\(/g) || []).length, 1);
  assert.strictEqual((readSource('scripts/log-signals-warrior.mjs').match(/assertReReadComplete\(/g) || []).length, 2);
  const g = readSource('scripts/test-db019-db021-grants.mjs');
  assert.ok(!/cannot run this check|Skipped\.'\); return;/.test(g), 'the grant test no longer skips to a pass');
  assert.ok(!/console\.log\(`re-select \(anon key\)[^`]*-- expect/.test(g), 'no "expect X" that is only printed');
  assert.ok(/if \(failures\.length\) \{.*process\.exit\(1\); \}/.test(g), 'a failed expectation fails the run');
  assert.ok((g.match(/expect\('/g) || []).length >= 7, 'every check asserts');
});

