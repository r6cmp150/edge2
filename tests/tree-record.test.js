// tests/tree-record.test.js — 2026-11-04. Any test run whose result may be reported records the
// tree it ran against: the commit, or dirty plus a hash of the changes. A real git repo in a
// temp dir, because the point is what git says.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { run, REPO_ROOT } = require('./_lib');
const { treeState } = require('../scripts/lib/tree-state.cjs');
const { runMutants } = require('../scripts/lib/mutants.cjs');

const repo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-tree-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'x');
  return { d, head: git('rev-parse', '--short=12', 'HEAD').trim() };
};

(async () => {

await run('clean names the commit; a changed file makes it dirty, and the hash follows the content', () => {
  const { d, head } = repo();
  assert.strictEqual(treeState(d), `${head} clean`);
  fs.writeFileSync(path.join(d, 'a.txt'), 'two\n');
  const first = treeState(d);
  assert.match(first, new RegExp(`^${head} dirty [0-9a-f]{12}$`));
  assert.strictEqual(treeState(d), first, 'the same changes, the same hash');
  fs.writeFileSync(path.join(d, 'a.txt'), 'three\n');
  assert.notStrictEqual(treeState(d), first, 'different changes, a different hash');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  assert.strictEqual(treeState(d), `${head} clean`, 'back to clean');
});

await run('a new untracked file counts, and so does its content', () => {
  const { d, head } = repo();
  fs.writeFileSync(path.join(d, 'new.txt'), 'a\n');
  const first = treeState(d);
  assert.match(first, new RegExp(`^${head} dirty `));
  fs.writeFileSync(path.join(d, 'new.txt'), 'b\n');
  assert.notStrictEqual(treeState(d), first);
});

await run('outside a git checkout it says so, rather than a commit or nothing', () => {
  assert.match(treeState(fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-notree-'))), /^unknown \(not a git checkout\)/);
});

await run('the runner states the tree before any result, in both output forms', () => {
  const { d, head } = repo();
  const tests = path.join(d, 'tests');
  fs.mkdirSync(tests);
  fs.writeFileSync(path.join(tests, 'x.test.js'), "console.log('PASS: x');\n");
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: d });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'y'], { cwd: d });
  const headNow = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
  assert.notStrictEqual(headNow, head);
  const runner = path.join(REPO_ROOT, 'scripts/run-tests.mjs');
  const text = spawnSync(process.execPath, [runner, tests], { cwd: d, encoding: 'utf8', timeout: 600000 }).stdout;
  assert.strictEqual(text.split('\n')[0], `TREE: ${headNow} clean`, 'its first line');
  const json = JSON.parse(spawnSync(process.execPath, [runner, tests, '--json'], { cwd: d, encoding: 'utf8', timeout: 600000 }).stdout);
  assert.strictEqual(json.tree, `${headNow} clean`);
});

await run('a mutation report opens with the tree, then the baseline', async () => {
  const { d, head } = repo();
  fs.writeFileSync(path.join(d, 'ok.test.js'), 'process.exit(0);\n');
  const lines = [];
  await runMutants('ok.test.js', [], { cwd: d, print: l => lines.push(l) });
  assert.match(lines[0], new RegExp(`^TREE: ${head} dirty `));
  assert.match(lines[1], /^REFUSED: the tree is not clean/, 'a dirty tree is refused, after the tree line');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('add', '.'); git('commit', '-qm', 'y');
  lines.length = 0;
  await runMutants('ok.test.js', [], { cwd: d, print: l => lines.push(l) });
  assert.strictEqual(lines[0], `TREE: ${git('rev-parse', '--short=12', 'HEAD').trim()} clean`);
  assert.match(lines[1], /^BASELINE: passed/);
});

await run('the verdict definitions are in the spec, with the choice and the reservation', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs/phase-10-entry-gate-spec.md'), 'utf8').replace(/\s+/g, ' ');
  for (const s of ["Roman's choice, 2026-11-05: A.", 'CAPTURED_BEFORE_FILL', 'CAPTURED_AFTER_FILL', 'CAPTURED_FILL_UNKNOWN', 'NOT_DISPLAYED', 'every captured card is `CAPTURED_FILL_UNKNOWN`', "It isn't published before db/038", 'NOT COMMISSIONED', "reserved for a verdict whose every input comes from the fill moment", 'The normal case, not a defect', 'recording minus fill', "A doesn't depend on step 2.5.", 'Sizes, estimated from reading the code'])
    assert.ok(spec.includes(s), s);
});

await run('a departure from an approved scope is said in the delivery: in §7.7', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs/phase-10-entry-gate-spec.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(spec.indexOf('IF A BUILD DEPARTS FROM AN APPROVED SCOPE, THE REPORT THAT DELIVERS IT SAYS SO') > spec.indexOf('### 7.7'));
  assert.ok(!spec.includes('TWO ERAS OF sell_time'), 'and the two-eras design is gone');
});

await run('the rule is in §7.7', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs/phase-10-entry-gate-spec.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(spec.indexOf('ANY TEST RUN WHOSE RESULT MAY BE REPORTED RECORDS THE TREE IT RAN AGAINST') > spec.indexOf('### 7.7'));
});

})();
