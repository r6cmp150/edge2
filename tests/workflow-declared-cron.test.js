// tests/workflow-declared-cron.test.js — workflow_runs.declared_cron is NULL
// when there was no cron, never '' (2026-10-22). db/023 measures delivery
// delay against the declared fire time, so "no cron" must be a state a
// query excludes naturally (is not null), not a value that parses.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT, run } = require('./_lib');

run('every workflow that inserts workflow_runs sends declared_cron as NULL-or-quoted, never a quoted empty schedule', () => {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  let inserting = 0;
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/rest\/v1\/workflow_runs"/.test(s) || !s.includes('declared_cron')) continue;
    inserting++;
    assert.ok(!s.includes('declared_cron\\": \\"${{ github.event.schedule }}'), `${f}: declared_cron is quoted directly from github.event.schedule, which is '' on a dispatch`);
    assert.ok(s.includes('declared_cron\\": $CRON_JSON'), `${f}: declared_cron must come from CRON_JSON`);
    assert.ok(s.includes('else CRON_JSON=null; fi'), `${f}: CRON_JSON must be null when there is no schedule`);
  }
  assert.ok(inserting >= 6, `found ${inserting} workflows inserting workflow_runs`);
});
