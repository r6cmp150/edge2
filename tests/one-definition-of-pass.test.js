// tests/one-definition-of-pass.test.js -- 2026-11-18, the reviewer: "One definition of pass. Anything that judges whether
// a test passed calls the same code. Two independent definitions means a mutant can be killed by one and alive by the
// other, and the one you happen to be running decides what you believe." The definition is scripts/lib/test-verdict.cjs.
// Three were found in one day: the mutation harness (exit code alone), scripts/mutate-portfolio-sort.js (exit code and
// its own FAIL parse) and the CI-variables re-run in tests/global-state-leaks.test.js (exit code alone). Held two ways:
//   1. NO SECOND PARSER: the result-line idiom (an anchored match on a PASS / FAIL / TESTS RUN line) appears nowhere
//      outside test-verdict.cjs;
//   2. EVERY FILE THAT RUNS TEST FILES IS DECLARED: a file that spawns a process and names test files is either a
//      RUNNER (it decides an outcome, so it calls testVerdict) or declared as not judging one, with the reason. A new
//      such file fails until it is declared; a declaration whose file no longer matches fails as stale.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, REPO_ROOT } = require('./_lib');

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory()
  ? (e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const SOURCES = ['scripts', 'tests', 'core', 'engines', 'shell'].filter(d => fs.existsSync(path.join(REPO_ROOT, d)))
  .flatMap(d => walk(path.join(REPO_ROOT, d))).concat([path.join(REPO_ROOT, 'app.js')])
  .filter(f => /\.(m?js|cjs)$/.test(f)).map(f => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
const code = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const DEFINITION = 'scripts/lib/test-verdict.cjs';

// Built from parts, so this file does not itself contain the idiom it bans.
const IDIOM = new RegExp(['\\/\\^PASS', '\\/\\^FAIL', '\\/\\^TESTS RUN'].join('|'));

run('no second parser: the result-line idiom appears only in scripts/lib/test-verdict.cjs', () => {
  const found = SOURCES.filter(f => f !== DEFINITION && IDIOM.test(code(f)));
  assert.deepStrictEqual(found, [], 'judge a test result with scripts/lib/test-verdict.cjs (testVerdict), not a second parse: ' + found.join(', '));
  assert.ok(IDIOM.test(code(DEFINITION)), 'the definition itself is found (a blind search would pass everything)');
});

// Files that spawn a process and name test files.
const RUNS_TESTS = f => {
  const s = code(f);
  return /\b(spawnSync|spawn|execFileSync|execSync|execFile|fork)\s*\(/.test(s)
    && (/endsWith\(\s*['"`]\.test\.js['"`]\s*\)/.test(s) || /['"`][\w./-]*\.test\.js['"`]/.test(s));
};
// They decide whether a test passed: each must call testVerdict. lib/mutants.cjs spawns its `test` argument, so the
// detector cannot see it; it is named here, and held all the same.
const RUNNERS = {
  'scripts/run-tests.mjs': 'the suite runner',
  'scripts/lib/mutants.cjs': 'the mutation harness (spawns its test argument: not detectable, declared)',
  'scripts/mutate-portfolio-sort.js': 'an older mutation script (its baseline and each kill)',
  'tests/global-state-leaks.test.js': 'its re-run of the files that read CI\'s variables, under CI\'s variables',
};
const NOT_JUDGING = {
  'tests/check-push.test.js': 'hands fixture test files to the runner and reads the runner\'s exit and output',
  'tests/mutants-harness.test.js': 'hands fixture test files to the harness and reads its report',
  'tests/paged-reads-ordered.test.js': 'hands fixture test files to the harness and reads its report',
  'tests/run-tests-checker.test.js': 'hands fixture test files to the runner and reads its verdicts',
  'tests/spawn-timeouts.test.js': 'reads sources for spawn calls; runs no test file',
  'tests/tree-record.test.js': 'hands fixture test files to the runner and the harness and reads their first lines',
};

run('every file that runs test files is declared: runners call testVerdict; the rest say why they judge nothing', () => {
  const detected = SOURCES.filter(RUNS_TESTS).sort();
  const declared = [...Object.keys(RUNNERS).filter(f => f !== 'scripts/lib/mutants.cjs'), ...Object.keys(NOT_JUDGING)].sort();
  const problems = [
    ...detected.filter(f => !declared.includes(f)).map(f => `${f}: runs test files, undeclared (a runner calls testVerdict; otherwise say why it judges nothing)`),
    ...declared.filter(f => !detected.includes(f)).map(f => `${f}: declared, but no longer runs test files (stale)`),
  ];
  assert.deepStrictEqual(problems, [], problems.join('\n'));
  for (const f of Object.keys(RUNNERS)) {
    assert.ok(/\btestVerdict\(/.test(code(f)) && /test-verdict\.cjs/.test(code(f)), `${f} (${RUNNERS[f]}) judges a test without testVerdict`);
  }
});

run('the principle is in §7.7, above the rule it generalises', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs/phase-10-entry-gate-spec.md'), 'utf8');
  const one = spec.indexOf('**ONE DEFINITION OF PASS'), harness = spec.indexOf('**MUTATION RUNS GO THROUGH');
  assert.ok(one > 0 && harness > one, 'the principle, then the throwaway rule as its consequence');
});
