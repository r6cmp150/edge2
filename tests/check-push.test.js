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

await run('pending migrations: a commit declaring any is refused, and so is a stale declaration; none declared may proceed', async () => {
  const { judgePending } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/check-push.mjs')).href);
  const cap = JSON.stringify({ _migrations: { applied: [37, 40], not_applied: [38, 41] } });
  assert.strictEqual(judgePending('abc', null, cap).ok, true, 'no file: nothing pending');
  assert.strictEqual(judgePending('abc', '{"pending": []}', cap).ok, true);
  const p = judgePending('abc', '{"pending": [38]}', cap);
  assert.strictEqual(p.ok, false);
  assert.ok(p.line.startsWith('PUSH REFUSED') && p.line.includes('db/038') && p.line.includes('not yet confirmed applied live'), p.line);
  const s = judgePending('abc', '{"pending": [38, 40]}', cap);
  assert.ok(!s.ok && s.line.includes('stale') && s.line.includes('db/040'), s.line);
  assert.strictEqual(judgePending('abc', 'not json', cap).ok, false, 'an unreadable declaration is not "nothing pending"');
  assert.strictEqual(judgePending('abc', '{"pending": [38]}', null).ok, false, 'nor is a declaration with no capture to judge it by');
  const src = readSource('scripts/check-push.mjs');
  assert.ok(/if \(process\.argv\.includes\('--before'\)\)[^\n]*process\.exit\(pend\.ok \? 0 : 1\)/.test(src), '--before exits on the pending verdict alone');
  assert.ok(/if \(!pend\.ok\) \{[^\n]*process\.exit\(1\)/.test(src), 'and the after-push check fails on it first');
});

await run('the pre-push hook runs --before on every commit pushed to main, refuses on its verdict, and says what it is not', () => {
  const hook = readSource('scripts/git-hooks/pre-push');
  assert.ok(hook.startsWith('#!/bin/sh'));
  assert.ok(/\[ "\$remote_ref" = "refs\/heads\/main" \] \|\| continue/.test(hook), 'pushes to main');
  assert.ok(/node "[^"]*scripts\/check-push\.mjs" "\$local_sha" --before \|\| status=1/.test(hook), 'each pushed commit, --before, and a refusal fails the push');
  assert.ok(/exit \$status\s*$/.test(hook));
  assert.ok(hook.includes('A SEATBELT, NOT A BARRIER') && hook.includes('--no-verify') && hook.includes('not a CI gate'));
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('A SEATBELT, NOT A BARRIER: it is local to the clone that set core.hooksPath, `git push --no-verify` skips it, and it is not a CI gate.'), 'its limits, where it is defined');
});

await run('a green run that a newer failed one replaced is not green', () => {
  assert.strictEqual(judgePush('abc', [run1('completed', 'failure'), run1('completed', 'success')]).ok, false, 'runs are newest first');
});

await run('the script exits non-zero on anything but green, and if gh can\'t answer, that isn\'t green', () => {
  const src = readSource('scripts/check-push.mjs');
  assert.ok(/process\.exit\(verdict\.ok \? 0 : 1\)/.test(src));
  // CHANGED 2026-11-12, declared: the line now names the commit whose runs it could not read.
  assert.ok(/PUSH NOT CONFIRMED: could not read the \$\{WORKFLOW\} runs for \$\{full\.slice\(0, 12\)\}[\s\S]{0,80}process\.exit\(1\)/.test(src));
  assert.ok(src.includes("'--commit', sha"), 'for this exact commit');
  const bad = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-push.mjs'), 'not-a-sha'], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(bad.status, 2);
});

// 2026-11-12 (the reviewer's rule): a check's verdict names what it checked, and a check that cannot identify its
// subject fails rather than passes. Each form below once printed only a usage line, a stack trace, or (a bad
// --wait-seconds) polled forever. Now: exit 2, nothing on stdout, and stderr says what could not be identified.
await run('a check that cannot identify its subject fails, and says what it could not identify', () => {
  const cli = args => spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-push.mjs'), ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 30000 }); // a hang is a failure, not a wait;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT }).stdout.trim();
  for (const [args, says] of [
    [[], 'no commit SHA given'],
    [['--before'], '"--before" is not a commit SHA'],
    [['not-a-sha', '--before'], '"not-a-sha" is not a commit SHA'],
    [['0000000', '--before'], '0000000 is not a commit in this clone'],
    [[head, '--wait-seconds'], '--wait-seconds needs a number of seconds, got null'],
    [[head, '--wait-seconds', 'abc'], '--wait-seconds needs a number of seconds, got "abc"'],
  ]) {
    const r = cli(args);
    assert.strictEqual(r.status, 2, `${JSON.stringify(args)}: exit 2`);
    assert.strictEqual(r.stdout, '', `${JSON.stringify(args)}: no verdict on stdout`);
    assert.ok(r.stderr.startsWith(`CHECK NOT RUN: ${says}; nothing was checked.`), `${JSON.stringify(args)}: ${r.stderr}`);
  }
  // judgePending's lines name the commit themselves (tested below, per branch), so `${pend.line}` is not an escape hatch.
  // and every verdict the script can emit names its subject: each PUSH line carries the commit (short or full)
  const src = readSource('scripts/check-push.mjs');
  const verdicts = src.match(/`PUSH [^`]*`/g) || [];
  assert.ok(verdicts.length >= 9, `found ${verdicts.length} verdict lines`);
  for (const v of verdicts) assert.ok(/\$\{(short|full\.slice\(0, 12\))\}|\$\{pend\.line\}/.test(v), `names no subject: ${v}`);
});

// 2026-11-12 (reviewer, check-push clearance (b)): `PUSH MAY PROCEED: ${pend.line}` delegates its subject to
// judgePending, so every line judgePending can return must carry the commit. One input per branch, and the branch
// count is pinned: a new branch fails here until it is added to this list.
await run('every line judgePending can return names the commit it judged', async () => {
  const { judgePending } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/check-push.mjs')).href);
  const sha = '0123456789abcdef0123456789abcdef01234567', short = sha.slice(0, 12);
  const cap = JSON.stringify({ _migrations: { applied: [37, 40] } });
  const cases = [[null, cap], ['not json', cap], ['{"x": 1}', cap], ['{"pending": [38]}', null], ['{"pending": [38, 40]}', cap], ['{"pending": [38]}', cap], ['{"pending": []}', cap]];
  const lines = new Set();
  for (const [pending, capture] of cases) {
    const { line } = judgePending(sha, pending, capture);
    assert.ok(line.includes(short), `names no commit: ${line}`);
    lines.add(line.replace(/\(.*\)/, '()'));
  }
  const src = readSource('scripts/check-push.mjs');
  const body = src.slice(src.indexOf('export function judgePending('), src.indexOf('\n}\n', src.indexOf('export function judgePending(')));
  const branches = (body.match(/line: `/g) || []).length;
  assert.strictEqual(lines.size, branches, `${branches} branches, ${lines.size} reached by the cases: each branch needs a case`);
});

// 2026-11-12 (reviewer, check-push clearance (a)): a regex over source cannot see an unbound name. The gh-failure
// line is EXECUTED here: a fake `gh` first on PATH that fails (a shell script; on Windows, node itself under the
// name gh.exe, which exits 1 on `run list ...`), so readRuns throws and the line that reaches stderr is asserted.
// The fake is one that can fail: that is the path under test.
await run('if gh cannot answer, the line that reaches stderr names the commit, and the push is not confirmed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-fake-gh-'));
  try {
    if (process.platform === 'win32') {
      const fake = path.join(dir, 'gh.exe');
      try { fs.linkSync(process.execPath, fake); } catch { fs.copyFileSync(process.execPath, fake); }
    } else {
      fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "fake gh: failing on purpose" >&2\nexit 1\n', { mode: 0o755 });
    }
    const env = { ...process.env };
    const k = Object.keys(env).find(x => x.toUpperCase() === 'PATH') || 'PATH';
    env[k] = dir + path.delimiter + (env[k] || '');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT }).stdout.trim();
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-push.mjs'), head], { encoding: 'utf8', cwd: REPO_ROOT, env, timeout: 30000 });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.strictEqual(r.stdout, '', 'no verdict on stdout');
    // gh's own stderr passes through first (execFileSync's default, as with the real gh); the verdict is the one PUSH line
    const verdicts = r.stderr.split(/\r?\n/).filter(l => l.startsWith('PUSH '));
    assert.strictEqual(verdicts.length, 1, r.stderr);
    assert.ok(verdicts[0].startsWith(`PUSH NOT CONFIRMED: could not read the Tests runs for ${head.slice(0, 12)} (Command failed: gh run list`), r.stderr);
    assert.ok(!/ReferenceError|TypeError/.test(r.stderr), r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/run-tests.mjs'), tests, ...extra], { encoding: 'utf8', env: { ...clean, ...env }, timeout: 600000 });
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
