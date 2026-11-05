// tests/check-push.test.js — 2026-11-05. A push is declared done by a script, not a person remembering, and
// the local runner has CI's environment by default, so green here means more than it did.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

(async () => {
const { judgePush } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/check-push.mjs')).href);
const run1 = (status, conclusion) => ({ status, conclusion, url: 'u', createdAt: 'x' });

await run('a push is done only when the Tests run for that commit finished green', () => {
  assert.strictEqual(judgePush('abc', [run1('completed', 'success')]).ok, true);
  assert.ok(judgePush('abc', [run1('completed', 'success')]).line.startsWith('PUSH OK'));
  for (const [runs, state] of [[[], 'MISSING'], [null, 'MISSING'], [[run1('in_progress', null)], 'RUNNING'], [[run1('queued', null)], 'RUNNING'], [[run1('completed', 'failure')], 'FAILED'], [[run1('completed', 'cancelled')], 'FAILED'], [[run1('completed', 'skipped')], 'FAILED'], [[run1('completed', 'timed_out')], 'FAILED']]) {
    const v = judgePush('abc', runs);
    assert.strictEqual(v.ok, false, state);
    assert.strictEqual(v.state, state);
    assert.ok(!v.line.startsWith('PUSH OK'));
  }
});

await run('a green run that a newer failed one replaced is not green', () => {
  assert.strictEqual(judgePush('abc', [run1('completed', 'failure'), run1('completed', 'success')]).ok, false, 'runs are newest first');
});

await run('the script exits non-zero on anything but green, and if gh can\'t answer, that isn\'t green', () => {
  const src = readSource('scripts/check-push.mjs');
  assert.ok(/process\.exit\(verdict\.ok \? 0 : 1\)/.test(src));
  assert.ok(/PUSH NOT CONFIRMED: could not read the runs[\s\S]{0,60}process\.exit\(1\)/.test(src));
  assert.ok(src.includes("'--commit', sha"), 'for this exact commit');
  const bad = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-push.mjs'), 'not-a-sha'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
});

const dirWith = files => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-env-'));
  const t = path.join(d, 'tests');
  fs.mkdirSync(t);
  for (const [n, s] of Object.entries(files)) fs.writeFileSync(path.join(t, n), s);
  return t;
};
const runner = (tests, extra = [], env = {}) => {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('GITHUB_') || k === 'CI' || k === 'TZ') delete clean[k];
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/run-tests.mjs'), tests, ...extra], { encoding: 'utf8', env: { ...clean, ...env } });
};
const PROBE = "const fs = require('fs'); if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || process.env.TZ !== 'UTC' || !fs.existsSync(process.env.GITHUB_ENV || 'none')) { console.log('FAIL: no CI environment'); process.exit(1); } console.log('PASS: CI environment');\n";

await run('the runner gives tests CI\'s environment by default, with the files CI has', () => {
  const r = runner(dirWith({ 'x.test.js': PROBE }));
  assert.strictEqual(r.status, 0, r.stdout);
  assert.ok(/^ENV: CI's variables and TZ=UTC; node v\d+/m.test(r.stdout), r.stdout);
  assert.ok(r.stdout.includes('CI is node 20 on linux'), 'and says what still differs');
});

await run('a test that only passes without CI\'s environment now fails here, not six pushes later', () => {
  const leaky = "const { run } = require(" + JSON.stringify(path.join(REPO_ROOT, 'tests/_lib.js')) + "); run('t', () => { delete process.env.GITHUB_ENV; });\n";
  assert.notStrictEqual(runner(dirWith({ 'x.test.js': leaky })).status, 0, 'the 2026-11-05 leak, by default');
  assert.strictEqual(runner(dirWith({ 'x.test.js': leaky }), ['--local-env']).status, 0, 'which is exactly what the old default hid');
});

await run('--local-env says plainly what a pass there is worth; real CI values win', () => {
  const r = runner(dirWith({ 'x.test.js': "console.log('PASS: x');\n" }), ['--local-env']);
  assert.ok(r.stdout.includes('so a pass here says nothing about CI'));
  const real = path.join(os.tmpdir(), `edge2-real-env-${process.pid}`);
  fs.writeFileSync(real, '');
  const keep = runner(dirWith({ 'x.test.js': `if (process.env.GITHUB_ENV !== ${JSON.stringify(real)}) { console.log('FAIL: overwritten'); process.exit(1); } console.log('PASS: kept');\n` }), [], { GITHUB_ENV: real });
  assert.strictEqual(keep.status, 0, keep.stdout);
});

await run('the spec says the leak detector was right, beside the fix', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('The leak detector did its job'));
  assert.ok(spec.includes('Do not weaken it for being noisy'));
  assert.ok(spec.includes('node scripts/check-push.mjs'));
});
})();
