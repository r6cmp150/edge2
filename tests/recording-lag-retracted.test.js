// tests/recording-lag-retracted.test.js -- 2026-11-22 (the reviewer: "a check that cannot fail is not a check, and its
// passing result is worse than no result, because people act on it"). scripts/audit-recording-lag.cjs compares the
// entered dates with the recording dates, and the entered dates default to today, so it cannot see a late recording
// with the default left in place. Its "0 late" is RETRACTED wherever it was stated, and the audit's own output says
// what it can and cannot see. This holds both: the retraction stays, and the old claim does not come back unmarked.
'use strict';
const assert = require('assert');
const { run, readSource } = require('./_lib');

const audit = readSource('scripts/audit-recording-lag.cjs');
const spec = readSource('docs/phase-10-entry-gate-spec.md');

run('the audit says it cannot see recording lag, in its header and in every count it prints', () => {
  assert.ok(audit.includes('THIS AUDIT CANNOT SEE RECORDING LAG.'));
  assert.ok(!/^\/\/ Result at b4620bc: 0 late sales/m.test(audit), 'the old result line is not standing as a result');
  assert.ok(!audit.includes('console.log(`  sale recorded on a different day from sell_date: '), 'no count printed as recording lag');
  assert.ok(!audit.includes('console.log(`  buy recorded on a different day from buy_date: '));
  assert.strictEqual((audit.match(/recording lag is not measured here/g) || []).length, 2, 'both counts carry the limit');
});

run('the spec: every statement of the zero is struck through and RETRACTED, and the tape test carries its limit', () => {
  for (const claim of ['0 of 292 sales and 0 of', '0 of 292 sales. `created_at` is a real recording stamp', 'no\n  sale and no datable buy was recorded on a different day']) {
    const i = spec.indexOf(claim);
    assert.ok(i >= 0, `still found: ${claim.slice(0, 40)}`);
    const around = spec.slice(Math.max(0, i - 400), i + 900);
    assert.strictEqual((spec.slice(0, i).match(/~~/g) || []).length % 2, 1, `inside a struck-through span: ${claim.slice(0, 40)}`);
    assert.ok(/RETRACTED[\s>]+2026-11-22/.test(around), `retracted beside it: ${claim.slice(0, 40)}`);
  }
  assert.ok(spec.includes('**LIMIT, FLAGGED 2026-11-22 for the reviewer\'s ruling'), 'the tape test\'s limit is flagged');
  assert.ok(spec.includes('[2026-11-22: NOT ESTABLISHED. Its first test is RETRACTED and its\n> second is LIMITED to typed prices, both below.]'));
});
