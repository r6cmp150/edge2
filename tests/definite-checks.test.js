// tests/definite-checks.test.js — 2026-11-05. A CHECK passes on NULL, so one that reads a JSON key without
// coalesce never required the key (db/035 run 4: 3 of 4). This reads the text of every CHECK in db/; the schema
// harness (spec, "The schema harness") is what executes them. Files db/040 repaired are a ratchet: they hold the
// applied, hollow definitions as history, and a new file may not join them.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, readSource, REPO_ROOT } = require('./_lib');

// Every CHECK expression in a SQL file: the balanced parentheses after the word CHECK.
function checks(text) {
  const out = [];
  const re = /\bcheck\s*\(/gi;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1, j = m.index + m[0].length;
    while (j < text.length && depth) { if (text[j] === '(') depth++; else if (text[j] === ')') depth--; j++; }
    out.push(text.slice(m.index, j));
  }
  return out;
}
// A key read compared without coalesce: NULL when the key is absent.
const HOLLOW = [
  /(?<!coalesce\()jsonb_typeof\(\s*\(?\s*\w+\s*->\s*'[^']+'(?:::text)?\s*\)?\s*\)\s*=/i,
  /(?<!coalesce\()\(?\s*\w+\s*->>\s*'[^']+'(?:::text)?\s*\)?\s*(=|in\s*\(|=\s*any)/i,
];
const hollowIn = text => checks(text.replace(/--[^\n]*/g, '')).filter(c => HOLLOW.some(re => re.test(c)));
const REPAIRED_BY_040 = ['028_code_version.sql', '032_scan_runs_prefilter_rule.sql', '035-run-1-migration.sql', '035_trades_v2_verdict_provenance.sql', '040_definite_checks.sql'];

(async () => {
await run('the detector finds the pattern db/035 shipped, and passes the repaired form', () => {
  assert.strictEqual(hollowIn(`check (sbs is null or (sbs->>'state' = 'PREDATES_SALE' and jsonb_typeof(sbs->'scanned_at') = 'string'))`).length, 1);
  assert.strictEqual(hollowIn(`check (x is null or jsonb_typeof((x -> 'app'::text)) = 'string'::text)`).length, 1, 'as pg_get_constraintdef prints it');
  assert.strictEqual(hollowIn(`check (sbs is null or (coalesce(sbs ->> 'state', '') = 'PREDATES_SALE' and coalesce(jsonb_typeof(sbs -> 'scanned_at'), '') = 'string'))`).length, 0);
  assert.strictEqual(hollowIn(`-- check (x->>'a' = 'b')\ncheck (y > 0)`).length, 0, 'comments are not checks');
});

await run('no migration outside the ratchet has a CHECK that reads a JSON key without coalesce', () => {
  const dir = path.join(REPO_ROOT, 'db');
  const found = fs.readdirSync(dir).filter(f => f.endsWith('.sql') && !REPAIRED_BY_040.includes(f))
    .flatMap(f => hollowIn(fs.readFileSync(path.join(dir, f), 'utf8')).map(c => `${f}: ${c.slice(0, 90)}`));
  assert.deepStrictEqual(found, []);
  // the ratchet only holds files that still carry the pattern: one that doesn't comes off the list
  for (const f of REPAIRED_BY_040.filter(f => fs.existsSync(path.join(dir, f)))) {
    assert.ok(hollowIn(fs.readFileSync(path.join(dir, f), 'utf8')).length > 0, `${f} no longer has the pattern: remove it from the ratchet`);
  }
});

await run('db/040\'s new definitions are all definite; only its guard quotes the old ones', () => {
  const sql = readSource('db/040_definite_checks.sql');
  const body = sql.slice(sql.indexOf('end $$;'));
  assert.deepStrictEqual(hollowIn(body), [], 'the constraints it adds');
  assert.ok(/raise exception 'db\/040 ABORTED, nothing changed: the live schema does not agree/.test(sql), 'guarded on the live definitions');
  assert.ok(/existing rows would break the definite definitions/.test(sql), 'and on existing rows');
  assert.ok(!/engine_source/.test(body), 'engine_source is not decided by this migration');
});

await run('db/040 run 2 probes what it repaired, and its expected counts match its own list', () => {
  const r2 = readSource('db/040-run-2-behaviour.sql');
  const refuse = (r2.match(/, true, '/g) || []).length, pass = (r2.match(/, false, '/g) || []).length;
  assert.strictEqual(refuse, 16); assert.strictEqual(pass, 9);
  assert.ok(r2.includes('refused % of 16:%') && r2.includes('passed the checks % of 9:%') && r2.includes('nr = 16 and np = 9'));
  for (const s of ['PREDATES_SALE without scanned_at', 'NOT_RECORDED without reason', 'trades_v2.code_version: empty', 'sale_code_version: empty', 'portfolio.code_version: empty', 'scan_runs.code_version: empty', 'signal_log.code_version: empty', 'prefilter_rule: empty']) assert.ok(r2.includes(s), s);
});

await run('the rule is in §7.7, with its case and the harness', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  for (const s of ['A CHECK CONSTRAINT MUST BE PROVABLY NON-NULL FOR EVERY INPUT, OR IT PASSES ON UNKNOWN', 'db/035 run 4 refused 3 of 4', 'Count is not behaviour.', 'as hollow as a comment', 'The schema harness (2026-11-05).', 'the dump has no grants']) assert.ok(spec.includes(s), s);
});
})();
