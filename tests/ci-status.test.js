// tests/ci-status.test.js -- 2026-11-25. The CI check names which of its outcomes it saw, each with its own exit code:
// "no run found" can never read as "the run failed" (the reviewer, after "CI exit 1" for a commit never pushed).
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/ci-status.mjs')).href);
const r = (status, conclusion, id = 7) => ({ databaseId: id, status, conclusion });

await run('each outcome is named, and the exit codes are all different', () => {
  assert.strictEqual(M.classify([]).verdict, 'NO RUN');
  assert.strictEqual(M.classify(undefined).verdict, 'NO RUN');
  assert.strictEqual(M.classify([r('completed', 'success')]).verdict, 'PASSED');
  assert.strictEqual(M.classify([r('completed', 'failure')]).verdict, 'FAILED');
  assert.deepStrictEqual(M.classify([r('completed', 'cancelled')]), { verdict: 'NOT PASSED', id: 7, conclusion: 'cancelled' });
  assert.strictEqual(M.classify([r('in_progress', null)]).verdict, 'STILL RUNNING');
  assert.strictEqual(M.classify([r('queued', null)]).verdict, 'STILL RUNNING');
  const codes = Object.values(M.EXIT);
  assert.strictEqual(new Set(codes).size, codes.length, 'no two outcomes share an exit code');
  assert.strictEqual(M.EXIT.PASSED, 0); assert.notStrictEqual(M.EXIT['NO RUN'], M.EXIT.FAILED);
});

await run('the newest run decides: a re-run that passed after a failure is PASSED', () => {
  assert.strictEqual(M.classify([r('completed', 'success', 9), r('completed', 'failure', 8)]).verdict, 'PASSED');
  assert.strictEqual(M.classify([r('completed', 'failure', 9), r('completed', 'success', 8)]).verdict, 'FAILED');
});

await run('the printed line says which, and NO RUN says it is not a failed build', () => {
  assert.ok(/^CI NO RUN: abc1234 -- .*this is not a failed build/.test(M.line({ verdict: 'NO RUN' }, 'abc1234')));
  assert.strictEqual(M.line({ verdict: 'FAILED', id: 5 }, 'abc1234'), 'CI FAILED: abc1234 -- run 5');
  assert.ok(/concluded cancelled, which is neither a pass nor a test failure/.test(M.line({ verdict: 'NOT PASSED', id: 5, conclusion: 'cancelled' }, 'x')));
});
})();
