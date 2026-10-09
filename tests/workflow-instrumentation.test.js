// tests/workflow-instrumentation.test.js — reportNoopDecision (2026-10-09):
// one call per run writes WORKFLOW_IS_NOOP=true|false to $GITHUB_ENV; never
// calling it leaves the variable unset ("not determined"). Each case imports
// a fresh module instance (query string) because the once-per-run guard is
// module state.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

const MOD = pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/workflow-instrumentation.mjs')).href;
let n = 0;
const fresh = () => import(`${MOD}?case=${++n}`);
const envFile = () => { const f = path.join(os.tmpdir(), `gh-env-${process.pid}-${n}-${Date.now()}`); fs.writeFileSync(f, ''); process.env.GITHUB_ENV = f; return f; };

run('reportNoopDecision: true|false to GITHUB_ENV, once, booleans only', async () => {
  let m = await fresh(); let f = envFile();
  m.reportNoopDecision(true, 'market closed\nat 9pm');
  let out = fs.readFileSync(f, 'utf8');
  assert.match(out, /^WORKFLOW_IS_NOOP=true\n/);
  assert.match(out, /WORKFLOW_NOOP_REASON<<NOOP_EOF_\d+\nmarket closed at 9pm\nNOOP_EOF_\d+\n$/);

  m = await fresh(); f = envFile();
  m.reportNoopDecision(false);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'WORKFLOW_IS_NOOP=false\n'); // no reason line for a real-work run

  m = await fresh(); envFile();
  m.reportNoopDecision(false);
  assert.throws(() => m.reportNoopDecision(true, 'x'), /called twice/);

  m = await fresh(); envFile();
  for (const bad of [undefined, null, 'true', 0, 1]) assert.throws(() => m.reportNoopDecision(bad), /must be a boolean/);

  m = await fresh(); delete process.env.GITHUB_ENV;
  m.reportNoopDecision(false); // local run: no env file, no throw
});
