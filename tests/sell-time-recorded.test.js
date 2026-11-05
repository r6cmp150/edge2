// tests/sell-time-recorded.test.js — 2026-11-05. sell_time means "recorded at", for every row
// ever written. The fill goes in its own column, so the mistake of reading one as the other
// is impossible rather than guarded.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

run('sell_time is the clock at recording, never anything the form was given', () => {
  const confirm = grab('confirmMarkSold');
  assert.ok(/sellTime: \(\(\) => \{\s*const pt = getPT\(\);/.test(confirm), 'read from the clock');
  assert.ok(!/sellTime:\s*sale/.test(confirm), 'not from the form');
  assert.ok(grab('writeTradeToSupabase').includes('sell_time: record.sellTime,'), 'and written as it is');
});

run('the ratio question is recorded as open, with both populations', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('The win/loss ratio question is OPEN AGAIN'));
  assert.ok(spec.includes('| Before v2 | 292 |') && spec.includes('| Scoring v2 | 249 |'), 'both');
  assert.ok(spec.includes("**That doesn't show v2 fixed it.**"));
  assert.ok(spec.includes('48 of the 249 v2 buys, 19%'), 'and the buys in the blocked window');
  assert.ok(spec.includes('the effective sample is seven days'), 'seven days, not 249 trades');
  assert.ok(spec.includes('may understate how early he is buying'), 'and which way the stamp errs');
});

run('the gap and the decision are stated in the spec', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('means "recorded at", for every row ever written'));
  assert.ok(spec.includes('THE GAP, stated: between now and db/038, sales store no fill time at all.'));
  assert.ok(spec.includes("sale_code_version.app = '20261105033000'"), 'and the one build that is the exception');
});
