// tests/mutants-wip.test.js -- 2026-11-19 (the reviewer). scripts/mutants-wip.mjs mutation-checks work in progress in a
// clone, and its one property is that it NEVER WRITES TO THE REAL TREE. Held here on a real git repo in a temp dir, with
// work in progress (a changed tracked file, an untracked file, an untracked test), run as a real child process:
//   - a run: the mutants run against the work in progress (an untracked file's mutant is killed in the clone), and the
//     real tree is byte-identical after, its git status unchanged, no journal, and the clone deleted;
//   - a run KILLED outright mid-mutant (no handler runs: the case a journal exists for): the real tree byte-identical;
//   - a run INTERRUPTED mid-mutant by SIGINT and SIGTERM (POSIX: the harness's handler runs and exits): the real tree
//     byte-identical, and the clone deleted on the way out.
// "Mid-mutant" is observed, not assumed: the mutant is in the CLONE's source and its journal exists there.
// W6 (the exit handler that deletes the clone when the harness exits from its SIGINT/SIGTERM handler) can only be
// killed where those signals have handlers: POSIX. On Windows the interrupt cases do not run and W6 is unverified there
// (DECLARED, 2026-11-19). It is held instead by the last case below, which runs on CI's linux: the W6 mutant, built in a
// temporary copy of the script (never the real one), interrupted mid-mutant, LEAVES its clone, which is exactly what
// the interrupt cases assert against. So the mutant is killed on every CI run, not only when someone runs a mutant set.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { run, REPO_ROOT } = require('./_lib');

const SCRIPT = path.join(REPO_ROOT, 'scripts/mutants-wip.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 30000) { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(50); } }

// A repo with work in progress: x.js committed and changed; y.js and its test untracked. ok.test.js needs the CHANGED
// x.js (so a clone without the diff fails its baseline); wip.test.js needs the untracked y.js; slow.test.js sleeps
// when y.js is mutated (so a run can be caught mid-mutant).
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-wip-real-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  fs.writeFileSync(path.join(d, 'x.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(d, 'ok.test.js'), "if (require('./x.js') === 2) console.log('\\nPASS: x is 2 (the work in progress)'); else { console.error('\\nFAIL: x is not the WIP'); process.exitCode = 1; }\n");
  fs.writeFileSync(path.join(d, '.gitignore'), 'ignored/\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(d, 'x.js'), 'module.exports = 2;\n'); // tracked, changed
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub/y.js'), "module.exports = 'y';\n"); // untracked
  fs.writeFileSync(path.join(d, 'wip.test.js'), "if (require('./sub/y.js') === 'y') console.log('\\nPASS: y'); else { console.error('\\nFAIL: y changed'); process.exitCode = 1; }\n");
  fs.writeFileSync(path.join(d, 'slow.test.js'), "if (require('./sub/y.js') === 'y') console.log('\\nPASS: y'); else setTimeout(() => process.exit(1), 60000);\n");
  fs.mkdirSync(path.join(d, 'ignored'));
  fs.writeFileSync(path.join(d, 'ignored/z.txt'), 'ignored\n');
  // read as the script reads: GIT_OPTIONAL_LOCKS=0, or this test's own `git status` refreshes .git/index (found
  // 2026-11-19: the first byte check failed on .git/index, written by this call, not by the script)
  const status = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
  return { d, status };
}
// Every byte under the repo, .git included except git's own scratch (index.lock cannot exist after a run, and
// nothing else in .git may change: no commit, no ref, no index write).
function snapshot(d) {
  const out = {};
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else out[path.relative(d, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } };
  walk(d);
  return out;
}
function mutantsFile(m) { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-wip-m-')), 'm.json'); fs.writeFileSync(f, JSON.stringify(m)); return f; }
function wip(d, mfile, extra = [], script = SCRIPT) {
  const child = spawn(process.execPath, [script, mfile, '--repo', d, '--timeout', '30000', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
  // its own kill timer, so a run that hangs cannot outlive this test (tests/spawn-timeouts.test.js names it)
  const killer = setTimeout(() => child.kill('SIGKILL'), 240000);
  const exited = new Promise(r => child.on('exit', (code, signal) => { clearTimeout(killer); r({ code, signal }); }));
  const clone = () => (out.match(/^CLONE: (.+)$/m) || [])[1];
  return { child, exited, out: () => out, clone };
}
const Y = ['sub/y.js', "module.exports = 'y';", "module.exports = 'Y';", 'y changes'];

(async () => {

await run('a run checks the work in progress in a clone, and the real tree is byte-identical after (status, no journal, clone gone)', async () => {
  const r = repo();
  const before = snapshot(r.d), status = r.status();
  const h = wip(r.d, mutantsFile({ 'ok.test.js': [['x.js', 'module.exports = 2;', 'module.exports = 3;', 'x changes']], 'wip.test.js': [Y] }));
  const { code } = await h.exited;
  const out = h.out();
  assert.strictEqual(code, 0, out);
  assert.match(out, /^REAL TREE: [0-9a-f]{12} dirty [0-9a-f]{12} \(read only\)$/m);
  assert.match(out, /BASELINE: passed \(ok\.test\.js\)/, 'the clone has the changed tracked file');
  assert.match(out, /killed {3}x changes/);
  assert.match(out, /BASELINE: passed \(wip\.test\.js\)/, 'the clone has the untracked files');
  assert.match(out, /killed {3}y changes/);
  assert.match(out, /^TREE: [0-9a-f]{12} clean$/m, 'the harness saw a clean tree: the clone, committed');
  assert.deepStrictEqual(snapshot(r.d), before, 'not one byte of the real repository changed');
  assert.strictEqual(r.status(), status);
  assert.deepStrictEqual(snapshot(r.d), before, 'and reading its status wrote nothing either');
  assert.ok(h.clone() && !fs.existsSync(h.clone()), 'the clone is deleted');
});

await run('a survivor fails the run (exit 1), and the real tree is still byte-identical', async () => {
  const r = repo();
  const before = snapshot(r.d);
  const h = wip(r.d, mutantsFile({ 'wip.test.js': [['sub/y.js', "module.exports = 'y';", "module.exports = 'y'; // same", 'an equivalent rewrite']] }));
  const { code } = await h.exited;
  assert.strictEqual(code, 1, h.out());
  assert.match(h.out(), /SURVIVED an equivalent rewrite/);
  assert.deepStrictEqual(snapshot(r.d), before);
});

await run('a run KILLED outright mid-mutant: the real tree is byte-identical (the kill reaches only the clone)', async () => {
  const r = repo();
  const before = snapshot(r.d);
  const h = wip(r.d, mutantsFile({ 'slow.test.js': [Y] }));
  await until(() => { const c = h.clone(); return c && fs.existsSync(path.join(c, '.mutant-journal.json')) && fs.readFileSync(path.join(c, 'sub/y.js'), 'utf8').includes("'Y'"); });
  h.child.kill('SIGKILL');
  await h.exited;
  assert.deepStrictEqual(snapshot(r.d), before, 'not one byte of the real repository changed');
  assert.ok(!fs.existsSync(path.join(r.d, '.mutant-journal.json')), 'no journal in the real tree');
  fs.rmSync(h.clone(), { recursive: true, force: true }); // the cost of a kill: a clone left in the temp directory
});

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  await run(`a run INTERRUPTED mid-mutant by ${sig}: exits ${code}, the real tree byte-identical, the clone deleted`, async () => {
    if (process.platform === 'win32') { console.log(`  (${sig} has no handler on Windows, so it is the outright kill above; this runs on CI's linux)`); return; }
    const r = repo();
    const before = snapshot(r.d);
    const h = wip(r.d, mutantsFile({ 'slow.test.js': [Y] }));
    await until(() => { const c = h.clone(); return c && fs.existsSync(path.join(c, '.mutant-journal.json')) && fs.readFileSync(path.join(c, 'sub/y.js'), 'utf8').includes("'Y'"); });
    h.child.kill(sig);
    const { code: got } = await h.exited;
    assert.strictEqual(got, code, h.out());
    assert.ok(h.out().includes(`INTERRUPTED by ${sig}: the source is restored.`), h.out());
    assert.deepStrictEqual(snapshot(r.d), before, 'not one byte of the real repository changed');
    assert.ok(!fs.existsSync(h.clone()), 'the clone is deleted on the way out');
  });
}

await run('the script writes nothing through a path into the real repository (structural: every write is under the clone)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // the only writes: mkdtemp (the clone), and mkdir/copyFile/rmSync whose TARGET is the clone or `to` (a path under it).
  // Each write is judged by its whole line, the target being the last argument for a copy and the first otherwise.
  const writes = code.split('\n').filter(l => /fs\.(writeFileSync|appendFileSync|copyFileSync|mkdirSync|rmSync|renameSync|unlinkSync|mkdtempSync)\(/.test(l));
  assert.deepStrictEqual(writes.map(l => l.match(/fs\.(\w+)\(/)[1]).sort(), ['copyFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync'], 'the writes, by name: ' + writes.join(' | '));
  for (const l of writes) {
    if (/fs\.copyFileSync\(/.test(l)) assert.ok(/fs\.copyFileSync\(path\.join\(repo, f\), to\);/.test(l), `a copy whose target is not \`to\`: ${l}`);
    else if (/fs\.mkdirSync\(/.test(l)) assert.ok(/fs\.mkdirSync\(path\.dirname\(to\)/.test(l), l);
    else if (/fs\.rmSync\(/.test(l)) assert.ok(/fs\.rmSync\(clone,/.test(l), l);
    else assert.ok(/const clone = fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), /.test(l), l);
  }
  assert.ok(/const to = path\.join\(clone, f\)/.test(code), 'copies land under the clone');
  assert.ok(/process\.env\.GIT_OPTIONAL_LOCKS = '0'/.test(code), 'git reads of the real repository do not refresh its index');
  assert.ok(!/cwd: repo[^}]*input|execFileSync\('git', \['(apply|add|commit|checkout|stash|reset)[^\]]*\][^)]*cwd: repo/.test(code), 'no writing git command runs in the real repository');
  assert.ok(/runMutants\(test, ms\.map\(norm\), \{ cwd: clone,/.test(code), 'the harness runs in the clone');
});

await run('W6, held where it can be: without the exit handler, a run interrupted mid-mutant LEAVES its clone (what the interrupt cases fail on)', async () => {
  if (process.platform === 'win32') { console.log('  (DECLARED: SIGINT has no handler on Windows, so W6 cannot be shown there; the linux CI runs this)'); return; }
  // the mutant, in a temporary copy of the script and the harness it loads: the real script is never written
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-wip-w6-'));
  fs.mkdirSync(path.join(tmp, 'scripts/lib'), { recursive: true });
  for (const lib of ['mutants.cjs', 'tree-state.cjs', 'test-verdict.cjs']) fs.copyFileSync(path.join(REPO_ROOT, 'scripts/lib', lib), path.join(tmp, 'scripts/lib', lib));
  const src = fs.readFileSync(SCRIPT, 'utf8'), anchor = "process.on('exit', removeClone);";
  assert.strictEqual(src.split(anchor).length, 2, 'the W6 anchor matches the script once (or this case proves nothing)');
  const mutant = path.join(tmp, 'scripts/mutants-wip.mjs');
  fs.writeFileSync(mutant, src.replace(anchor, ''));
  const r = repo();
  const before = snapshot(r.d);
  const h = wip(r.d, mutantsFile({ 'slow.test.js': [Y] }), [], mutant);
  await until(() => { const c = h.clone(); return c && fs.existsSync(path.join(c, '.mutant-journal.json')) && fs.readFileSync(path.join(c, 'sub/y.js'), 'utf8').includes("'Y'"); });
  h.child.kill('SIGINT');
  await h.exited;
  assert.ok(fs.existsSync(h.clone()), 'the W6 mutant left its clone: the interrupt cases above would fail on it');
  assert.deepStrictEqual(snapshot(r.d), before, 'and even the mutant never wrote to the real repository');
  fs.rmSync(h.clone(), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

})();
