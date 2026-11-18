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
  const r = spawnSync(process.execPath, [RUNNER, dir, '--json', ...extra], { encoding: 'utf8', timeout: 600000 });
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

run('an error is never truncated: a crash\'s whole output, path included, and a long FAIL message in full', () => {
  // a crash whose path comes after the third line (as the 2026-11-05 DEAD's did), and a 3,000-character message
  // it ends in an "s" on purpose: a mistyped trim (/s+$/ for /\s+$/) once ate trailing letters here, 2026-11-06
  const longMsg = 'x'.repeat(3000) + ' END-OF-MESSAGE ends in tests';
  const d = dirWith({
    'a-dies.test.js': "console.error('one');\nconsole.error('two');\nconsole.error('three');\nrequire('fs').readFileSync('/no/such/dir/the-missing-path.json');\n",
    // process.stderr.write, no trailing newline: the output's very last character is the message's last "s"
    'b-long-fail.test.js': "console.log('\\nPASS: one');\nconsole.error('\\nFAIL: long');\nprocess.stderr.write('" + longMsg + "');\nprocess.exitCode = 1;\n",
  });
  const text = spawnSync(process.execPath, [RUNNER, d], { encoding: 'utf8', timeout: 600000 }).stdout;
  assert.ok(/===== FULL OUTPUT: DEAD a-dies\.test\.js/.test(text), 'a full-output section for the dead file');
  assert.ok(text.includes('the-missing-path.json'), 'the path the crash failed on is in the runner\'s output');
  assert.ok(text.includes(longMsg), 'the long FAIL message, whole');
  const { report } = runner(d);
  const dead = report.results.find(r => r.file === 'a-dies.test.js');
  assert.ok(dead.output.includes('the-missing-path.json') && dead.output.includes('ENOENT'), '--json carries the whole output too');
  assert.ok(report.results.find(r => r.file === 'b-long-fail.test.js').output.includes('END-OF-MESSAGE'));
  const good = spawnSync(process.execPath, [RUNNER, dirWith({ 'g.test.js': GOOD })], { encoding: 'utf8', timeout: 600000 }).stdout;
  assert.ok(!/FULL OUTPUT/.test(good), 'a passing file prints no output section');
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

// 2026-11-18 (the reviewer): "a test that does not run cannot fail, and an empty run looks exactly like a clean one."
// A case whose promise never settles leaves node with nothing to do: it exits 0, early, the rest unrun, no FAIL line.
// tests/_lib.js now counts every case registered (or declared with expectTests) against every case settled, and a
// shortfall is a FAIL line and a failing exit. These fixtures load the REAL _lib by absolute path.
run('a test that never settles is a FAIL, through run() and through an own queue with a declared total', () => {
  const lib = JSON.stringify(path.join(REPO_ROOT, 'tests', '_lib.js'));
  const d = dirWith({
    'a-never-settles.test.js': `const { run } = require(${lib});\nrun('one', () => {});\nrun('two hangs', () => new Promise(() => {}));\nrun('three never starts', () => {});\n`,
    'b-own-queue-never-settles.test.js': `const { run: runNow, expectTests } = require(${lib});\nconst queue = []; const run = (n, f) => queue.push([n, f]);\nrun('one', () => {}); run('two hangs', () => new Promise(() => {})); run('three', () => {});\nexpectTests(queue.length);\n(async () => { for (const [n, f] of queue) await runNow(n, f); })();\n`,
    'c-all-settle.test.js': `const { run } = require(${lib});\nrun('one', () => {});\nrun('two', async () => { await new Promise(r => setTimeout(r, 5)); });\n`,
  });
  const { exit, report } = runner(d);
  assert.strictEqual(exit, 1);
  assert.deepStrictEqual(verdicts(report), { 'a-never-settles.test.js': 'FAIL', 'b-own-queue-never-settles.test.js': 'FAIL', 'c-all-settle.test.js': 'PASS' });
  for (const f of ['a-never-settles.test.js', 'b-own-queue-never-settles.test.js']) {
    const out = report.results.find(r => r.file === f).output;
    assert.ok(/FAIL: 2 of 3 test\(s\) never settled \(1 started and never finished, 1 never started\)/.test(out), `${f}: ${out}`);
    assert.notStrictEqual(report.results.find(r => r.file === f).exit, 0, `${f}: a check that reads only the exit code must see it too`);
  }
});
