// tests/global-state-leaks.test.js — 2026-11-04. Any test that mutates global state restores
// it, and the apparatus detects a leak rather than trusting discipline. Runs real files through
// the real runner, because a test of the harness from inside the harness can't see this.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { run, REPO_ROOT } = require('./_lib');

const LIB = JSON.stringify(path.join(REPO_ROOT, 'tests', '_lib.js'));
function runner(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-leak-'));
  const tests = path.join(dir, 'tests');
  fs.mkdirSync(tests);
  for (const [n, src] of Object.entries(files)) fs.writeFileSync(path.join(tests, n), src);
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/run-tests.mjs'), tests, '--json'], { cwd: dir, encoding: 'utf8', timeout: 600000 });
  return { exit: r.status, ...JSON.parse(r.stdout) };
}
const file = body => `const { run } = require(${LIB});\n${body}\n`;
const verdict = body => runner({ 'x.test.js': file(body) }).results[0];

(async () => {

await run('a test that restores what it changes passes', () => {
  const v = verdict("run('t', async () => { const l = console.log; console.log = () => {}; try { await 0; } finally { console.log = l; } });");
  assert.strictEqual(v.verdict, 'PASS', JSON.stringify(v));
});

await run('every kind of leak fails the test that left it, and names it', () => {
  for (const [code, name] of [
    ['console.log = () => {};', 'console.log'],
    ['console.error = () => {};', 'console.error'],
    ['console.warn = () => {};', 'console.warn'],
    ['global.fetch = async () => {};', 'fetch'],
    ['Date.now = () => 1;', 'Date.now'],
    ['global.Date = class extends Date {};', 'Date'],
    ['global.setTimeout = () => {};', 'setTimeout'],
    ['process.env.LEAK_TEST = "1";', 'process.env.LEAK_TEST'],
  ]) {
    const v = verdict(`run('t', () => { ${code} });`);
    assert.strictEqual(v.verdict, 'FAIL', `${name}: ${JSON.stringify(v)}`);
    assert.ok(v.detail.includes(name), `${name} named: ${v.detail}`);
  }
});

await run('a removed env var is a leak too, and the next test gets everything back', () => {
  const v = verdict("run('a', () => { delete process.env.PATH; }); run('b', () => { if (!process.env.PATH) throw new Error('not restored'); });");
  assert.strictEqual(v.verdict, 'FAIL');
  assert.ok(v.detail.includes('process.env.PATH'), v.detail);
  assert.ok(!v.detail.includes('not restored'), v.detail);
});

await run('a muted console can\'t hide a result, in the test that mutes it or the next', () => {
  const v = verdict("const l = console.log; run('a', async () => { console.log = () => {}; console.error = () => {}; throw new Error('boom'); }); run('b', () => {});");
  assert.strictEqual(v.verdict, 'FAIL');
  assert.ok(v.detail.includes('a'), v.detail);
  assert.strictEqual(v.passes, 1, 'the other test still reported');
  const t = verdict("const m = () => { console.log = () => {}; }; run('c', () => { const l = console.log; m(); console.log = l; }); run('d', () => {});");
  assert.strictEqual(t.verdict, 'PASS');
  assert.strictEqual(t.passes, 2);
});

await run('a stub left by one test does not reach the next', () => {
  const v = verdict("run('a', () => { global.fetch = 'stub'; }); run('b', () => { if (global.fetch === 'stub') throw new Error('it carried over'); });");
  assert.ok(!v.detail.includes('it carried over'), v.detail);
  assert.strictEqual(v.passes, 1, 'b passed');
});

await run('a console muted for the whole file still can\'t hide PASS or FAIL', () => {
  const v = verdict("console.log = () => {}; console.error = () => {}; run('a', () => {}); run('b', () => { throw new Error('boom'); });");
  assert.strictEqual(v.verdict, 'FAIL', JSON.stringify(v));
  assert.strictEqual(v.passes, 1, 'the PASS arrived');
  assert.ok(v.detail.includes('b'), `the FAIL arrived: ${v.detail}`);
});

await run('tests in a file run one at a time, even when nothing awaits them', () => {
  const v = verdict("let busy = false; const t = async () => { if (busy) throw new Error('overlap'); busy = true; await new Promise(r => setTimeout(r, 20)); busy = false; }; run('a', t); run('b', t); run('c', t);");
  assert.strictEqual(v.verdict, 'PASS', JSON.stringify(v));
  assert.strictEqual(v.passes, 3);
});

await run('a file whose result lines don\'t add up is LOST, and the runner exits non-zero', () => {
  const r = runner({ 'x.test.js': "console.log('PASS: only one');\nconsole.log('TESTS RUN: 2');\n" });
  assert.strictEqual(r.results[0].verdict, 'LOST', JSON.stringify(r.results[0]));
  assert.notStrictEqual(r.exit, 0);
  assert.ok(r.results[0].detail.includes('ran 2 test(s), 1 result line(s)'));
});

await run('every test file reports through the harness, so none is outside this', () => {
  const dir = path.join(REPO_ROOT, 'tests');
  // These hold the words in fixtures they hand to the runner.
  const fixtures = ['global-state-leaks.test.js', 'run-tests-checker.test.js', 'tree-record.test.js', 'check-push.test.js'];
  const bare = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && !fixtures.includes(f)).filter(f => !/require\('\.\/_lib'\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')) || /console\.(log|error)\(`?['"\\n]*(PASS|FAIL): /.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepStrictEqual(bare, []);
});

await run('a file that touches the variables CI sets for real passes with them set, as on CI', () => {
  // Five pushes went red on CI and green here: the leak needs GITHUB_ENV to exist before the test.
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_ENV: path.join(os.tmpdir(), `edge2-ci-env-${process.pid}`), GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '1', CI: 'true' };
  fs.writeFileSync(env.GITHUB_ENV, '');
  const dir = path.join(REPO_ROOT, 'tests');
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && /GITHUB_|process\.env\.CI\b/.test(fs.readFileSync(path.join(dir, f), 'utf8')) && f !== 'global-state-leaks.test.js');
  assert.ok(names.includes('workflow-instrumentation.test.js'), 'the enumeration sees the file that leaked');
  for (const f of names) {
    const r = spawnSync(process.execPath, [path.join(dir, f)], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 120000 });
    assert.strictEqual(r.status, 0, `${f} fails with CI's variables set:\n${(r.stdout + r.stderr).split('\n').filter(l => /FAIL|left global/.test(l)).join('\n')}`);
  }
});

await run('the rule is in §7.7, beside the others', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs/phase-10-entry-gate-spec.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(spec.indexOf('ANY TEST THAT MUTATES GLOBAL STATE') > spec.indexOf('### 7.7'));
  assert.ok(spec.includes('Whether cross-test interference could explain the queue-pacing failure'));
});

})();
