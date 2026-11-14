// tests/db044-sql.test.js -- 2026-11-14. db/044 (the sampled peak RSI, per position, with provenance) and db/045 (its
// NOT NULL, held behind a read-back gate). The SQL-only checks. The schema harness (pg-harness/test-044.mjs, outside
// the repo, PGlite 0.5.10 = PostgreSQL 18.6) proves the rest by behaviour, on the 2026-11-11b capture with the real
// backup rows: run 1 applies; run 2 says PASS; every guard aborts with nothing changed; the door works both ways
// (owner + declared + logged + its own log row opens it; the anon role, outcome_filler, a missing log row and another
// sale's log row do not); GREATEST and NULL both ways; the fill exemption; an older build's insert lands until db/045
// and is refused after it; db/045 refuses before its gate and applies after it; the rollback is exact on a clean apply
// and refuses once anything was recorded. 12 SQL mutants were killed by it.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { run, readSource } = require('./_lib');

const norm = f => readSource(f).replace(/\r\n/g, '\n');
const run1 = norm('db/044_peak_rsi_sampled.sql');
const run2 = norm('db/044-run-2-behaviour.sql');
const undo = norm('db/044-rollback.sql');
const s045 = norm('db/045_peak_rsi_provenance_not_null.sql');
// Changing a file the harness proved means proving it again: move a pin only after test-044 passes on the new text.
const PINS = {
  'db/044_peak_rsi_sampled.sql': 'bbdf91daf59492b04aaafff0831e6b0b2bb077d33618c13949b3aea751bce73a',
  'db/044-run-2-behaviour.sql': 'c3faee9fcf28ddb268875e2f7238723d24d3a849424c545f310b5340411362c3',
  'db/044-rollback.sql': 'f5df1cc397105e9403b6256c622340817a6fccec2022176c85de9ce4e78b57ce',
  'db/045_peak_rsi_provenance_not_null.sql': '8645b87bd596bd0cefc80bd26dd6661a6ac7efc8dc5cba02ceab769aded2fa76',
};
const VALUES = ['sampled_since', 'not_sampled', 'not_established', 'corrected'];
const valuesIn = (text, anchor) => {
  const i = text.indexOf(anchor); assert.ok(i >= 0, anchor);
  const m = text.slice(i, text.indexOf(';', i)).match(/in \(([^)]*)\)/); assert.ok(m, `no value list after ${anchor}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
};

(async () => {
await run('PINS names each file exactly once, read from this file\'s own text', () => {
  const self = norm('tests/db044-sql.test.js');
  const body = self.slice(self.indexOf('const PINS = {'), self.indexOf('};', self.indexOf('const PINS = {')));
  assert.deepStrictEqual([...body.matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]), Object.keys(PINS));
});

await run('the four files are the ones the harness proved (sha256 pins)', () => {
  for (const [f, pin] of Object.entries(PINS)) {
    const got = crypto.createHash('sha256').update(norm(f)).digest('hex');
    assert.strictEqual(got, pin, `${f} changed (or its pin was never set): re-run test-044, then pin ${got}`);
  }
});

await run('one value list, everywhere: run 1\'s CHECK, db/045\'s CHECK, run 2\'s probes, the comments', () => {
  assert.deepStrictEqual(valuesIn(run1, 'add constraint trades_v2_peak_rsi_provenance_chk'), VALUES);
  assert.deepStrictEqual(valuesIn(s045, 'add constraint trades_v2_peak_rsi_provenance_chk'), VALUES);
  for (const v of VALUES) assert.ok(run2.includes(`'${v}'`), `run 2 probes ${v}`);
  for (const t of [run1, s045]) for (const v of VALUES) assert.ok(t.includes(`${v}:`), `the column comment defines ${v}`);
  assert.ok(!/measured_since|measured_whole_hold|not_measured/.test(run1 + run2 + s045), 'the ruled names: sampled, never measured');
});

await run('NO DEFAULT on any provenance column, ever; NULL is allowed only until db/045, which removes it', () => {
  // DDL only: a column comment saying "No default, ever" is not a default
  for (const t of [run1, s045]) assert.ok(!/add column peak_rsi_\w+[^;\n]*\bdefault\b|alter column peak_rsi_\w+ set default/i.test(t), 'no default');
  assert.ok(/add column peak_rsi_provenance text;/.test(run1), 'the column is added bare');
  assert.ok(/peak_rsi_provenance is null   -- only until db\/045/.test(run1), 'run 1 allows NULL, and says until when');
  assert.ok(!/peak_rsi_provenance is null\s+or/.test(s045.slice(s045.indexOf('add constraint'))), 'db/045\'s CHECK has no NULL clause');
  assert.ok(s045.includes('alter table trades_v2 alter column peak_rsi_provenance set not null;'));
});

await run('db/045\'s gate is a read-back, enforced in the SQL, and its header says why a build stamp is not enough', () => {
  assert.ok(/THE GATE IS A READ-BACK, NOT A DEPLOY/.test(s045) && /A build stamp says what was\s+-- served/.test(s045));
  assert.ok(s045.includes("select count(*) into n_new from trades_v2 where peak_rsi_provenance in ('sampled_since', 'not_sampled');"));
  assert.ok(/if \(n_new < 1\) is not false then\s+raise exception 'db\/045 ABORTED, nothing changed: THE GATE IS NOT MET/.test(s045));
});

await run('GREATEST and NULL: stated in run 1 both ways, and probed both ways by run 2', () => {
  assert.ok(/GREATEST\(NULL, 5\) = 5 and GREATEST\(5, NULL\) = 5/.test(run1), 'the column comment section states both');
  assert.ok(/GREATEST\(NULL, x\) = x \(a first sample is taken\), GREATEST\(x, NULL\) = x/.test(run1), 'the trigger comment states both');
  assert.ok(run2.includes("[GREATEST(NULL, 60) is not 60]") && run2.includes("[GREATEST(60, NULL) is not 60]"));
});

await run('the door: three conditions, its own log row, the old and new values; anon and outcome_filler probed', () => {
  assert.ok(/pg_has_role\(current_user, \(select relowner from pg_class where oid = tbl\), 'MEMBER'\)/.test(run1), 'the owner');
  assert.ok(/current_setting\('edge2\.correction', true\)/.test(run1), 'the declaration');
  assert.ok(/c\.old_value is not distinct from old_v and c\.new_value is not distinct from new_v/.test(run1), 'old and new recorded and matched');
  assert.ok(/and \(log_id is null or c\.id = log_id\)\) then/.test(run1) && run1.includes('new.peak_rsi_correction_id) = \'open\''), 'the sale row points at its own log row');
  assert.ok(/old_value\s+numeric,\s+new_value\s+numeric,/.test(run1), 'the log keeps both values');
  assert.ok(run1.includes('revoke all on peak_corrections from anon, authenticated;') && run1.includes('alter table peak_corrections enable row level security;'));
  assert.ok(run2.includes("execute 'set local role anon';") && run2.includes("execute 'set local role outcome_filler';"));
});

await run('the correction log\'s time and author are FORCED by a trigger, never defaulted (the reviewer, 2026-11-14)', () => {
  assert.ok(/corrected_at\s+timestamptz not null,\s+corrected_by\s+text not null\s*\n\);/.test(run1), 'no default on either');
  assert.ok(/new\.corrected_at := now\(\);/.test(run1) && /new\.corrected_by := current_user;/.test(run1), 'overwritten unconditionally');
  assert.ok(run1.includes('create trigger peak_corrections_stamp before insert on peak_corrections'));
});

await run('the fill exemption is exactly the NULL -> value transition, and the peak_price asymmetry is written down', () => {
  assert.ok(run1.includes('  if old.filled_at is null and new.filled_at is not null then return new; end if;'));
  assert.ok(/peak_price has no provenance column, so a reset here leaves no\s+-- trace in the row/.test(run1));
});

await run('the rollback drops exactly what run 1 creates, and refuses once anything was recorded', () => {
  const created = [...run1.matchAll(/(?:add constraint|create (?:function|trigger|table)) (\w+)/g)].map(m => m[1]).sort();
  const dropped = [...undo.matchAll(/drop (?:constraint|function|trigger|table) (\w+)/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(dropped, created);
  const cols = t => [...t.matchAll(/(?:add|drop) column (\w+)/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(cols(undo), cols(run1));
  assert.ok(/would destroy recorded data/.test(undo));
});
})();
