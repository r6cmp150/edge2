// tests/run-tests-checker.test.js — 2026-11-02. The test runner must be able
// to FAIL. scripts/run-tests.mjs replaced a shell loop that counted a file as
// passing unless it printed "FAIL", so a syntax error, an empty file or a
// file that ran nothing all "passed". Here the runner is given a directory
// of deliberately broken files (built in a temp dir, never under tests/,
// where the suite would run them) and must classify each and exit 1; given
// only good files it must exit 0; given none it must exit 1.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { run, REPO_ROOT } = require('./_lib');

const RUNNER = path.join(REPO_ROOT, 'scripts', 'run-tests.mjs');
function dirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-runner-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
  return d;
}
function runner(dir, extra = []) {
  const r = spawnSync(process.execPath, [RUNNER, dir, '--json', ...extra], { encoding: 'utf8' });
  return { exit: r.status, report: JSON.parse(r.stdout) };
}
const verdicts = report => Object.fromEntries(report.results.map(r => [r.file, r.verdict]));

const GOOD = "console.log('\\nPASS: works');\n";
const BROKEN = {
  'a-good.test.js': GOOD,
  'b-syntax-error.test.js': "console.log('\\nPASS: never reached');\nconst x = ;\n",
  'c-empty.test.js': '',
  'd-silent-exit0.test.js': "console.log('hello, I ran nothing');\n",
  'e-fail-line.test.js': "console.log('\\nPASS: one');\nconsole.error('\\nFAIL: two');\nprocess.exitCode = 1;\n",
  'e2-fail-with-reason.test.js': "console.log('\\nPASS: one');\nconsole.error('\\nFAIL: two');\nconsole.error(new Error('rate 12/min against 170'));\nprocess.exitCode = 1;\n",
  'f-fail-but-exit0.test.js': "console.error('\\nFAIL: reported, but exit code left at 0');\n",
  'g-crash-after-pass.test.js': "console.log('\\nPASS: first');\nthrow new Error('boom after a pass');\n",
  'h-exitcode-after-pass.test.js': "console.log('\\nPASS: first');\nprocess.exitCode = 3;\n",
  'i-require-missing.test.js': "require('./does-not-exist');\nconsole.log('\\nPASS: never');\n",
  'not-a-test.js': "throw new Error('the runner must ignore files that are not *.test.js');\n",
};

run('the runner FAILS on each kind of broken test file, and says which kind', () => {
  const { exit, report } = runner(dirWith(BROKEN));
  assert.strictEqual(exit, 1, 'any non-PASS file fails the run');
  assert.deepStrictEqual(verdicts(report), {
    'a-good.test.js': 'PASS',
    'b-syntax-error.test.js': 'DEAD',
    'c-empty.test.js': 'SILENT',
    'd-silent-exit0.test.js': 'SILENT',
    'e-fail-line.test.js': 'FAIL',
    'e2-fail-with-reason.test.js': 'FAIL',
    'f-fail-but-exit0.test.js': 'FAIL',
    'g-crash-after-pass.test.js': 'FAIL',
    'h-exitcode-after-pass.test.js': 'FAIL',
    'i-require-missing.test.js': 'DEAD',
  });
  assert.strictEqual(report.bad, 9);
  // A failure keeps its numbers: reported by name alone it can't be explained later.
  const reason = report.results.find(r => r.file === 'e2-fail-with-reason.test.js').detail;
  assert.ok(/two :: .*rate 12\/min against 170/.test(reason), reason);
});

run('the runner kills a hung file and reports TIMEOUT', () => {
  const { exit, report } = runner(dirWith({ 'a-good.test.js': GOOD, 'hang.test.js': 'setInterval(() => {}, 1000);\n' }), ['--timeout-ms', '1500']);
  assert.strictEqual(exit, 1);
  assert.strictEqual(verdicts(report)['hang.test.js'], 'TIMEOUT');
});

run('all good -> exit 0; no test files at all -> exit 1 (an empty suite is not a pass)', () => {
  assert.strictEqual(runner(dirWith({ 'a.test.js': GOOD, 'b.test.js': GOOD })).exit, 0);
  const none = runner(dirWith({ 'readme.txt': 'no tests here' }));
  assert.strictEqual(none.exit, 1);
  assert.strictEqual(none.report.files, 0);
});

run('CI runs this runner on every push, and nothing else decides the suite', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'tests.yml'), 'utf8');
  assert.ok(/on:\s*\n\s*push:/.test(wf) && /pull_request:/.test(wf), 'runs on push and pull request');
  assert.ok(wf.includes('node scripts/run-tests.mjs tests'), 'the strict runner is the step');
  assert.ok(/fetch-depth:\s*0/.test(wf), 'full history: several tests read pinned backups with git show');
  assert.ok(!/continue-on-error:\s*true/.test(wf), 'a failure is never swallowed');
});
