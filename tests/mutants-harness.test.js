// tests/mutants-harness.test.js — 2026-11-05. The mutation harness must never leave a mutant in the source.
// A run killed mid-mutant once did, in the spec. One test per guard: a clean tree first, a timeout per mutant,
// restore on SIGINT and SIGTERM, and a journal that recovers from a kill no handler sees. Real git repos in
// temp dirs, and real child processes, because the point is what happens when a process dies.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { run, REPO_ROOT } = require('./_lib');
const HARNESS = path.join(REPO_ROOT, 'scripts/lib/mutants.cjs');
const { runMutants, JOURNAL } = require(HARNESS);

const ORIG = 'module.exports = 1;\n';
// x.js, and a test that passes on the original. slow.test.js passes too, but sleeps when x.js is mutated.
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-mutants-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  fs.writeFileSync(path.join(d, 'x.js'), ORIG);
  fs.writeFileSync(path.join(d, 'ok.test.js'), "process.exit(require('./x.js') === 1 ? 0 : 1);\n");
  fs.writeFileSync(path.join(d, 'slow.test.js'), "if (require('./x.js') === 1) process.exit(0); setTimeout(() => process.exit(1), 60000);\n");
  fs.writeFileSync(path.join(d, 'loop.test.js'), "if (require('./x.js') === 1) process.exit(0); for (;;) {}\n");
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'x');
  return { d, x: path.join(d, 'x.js'), journal: path.join(d, JOURNAL), clean: () => git('status', '--porcelain') === '' };
}
const MUT = [['x.js', 'module.exports = 1;', 'module.exports = 2;', 'changes it']];
const quiet = lines => ({ print: l => lines.push(l) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 20000) { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(50); } }
// A separate process running the harness, so it can be killed. Its script lives outside the repo: it must stay clean.
function harnessProcess(d, test, timeoutMs) {
  const driver = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-driver-')), 'drive.cjs');
  fs.writeFileSync(driver, `require(${JSON.stringify(HARNESS)}).runMutants(${JSON.stringify(test)}, ${JSON.stringify(MUT)}, { cwd: ${JSON.stringify(d)}, timeoutMs: ${timeoutMs} });\n`);
  const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', b => { out += b; });
  const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, exited, out: () => out };
}

(async () => {

await run('a dirty tree is refused before anything runs, and nothing is touched', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.d, 'stray.txt'), 'left over\n');
  const lines = [];
  const res = await runMutants('ok.test.js', MUT, { cwd: r.d, ...quiet(lines) });
  assert.strictEqual(res.refused, true);
  assert.match(lines[1], /^REFUSED: the tree is not clean/);
  assert.ok(!lines.some(l => /BASELINE/.test(l)), 'not even the baseline');
  assert.strictEqual(fs.readFileSync(r.x, 'utf8'), ORIG);
});

await run('a mutant that never finishes times out, is reported apart from the kills, and is restored', async () => {
  const r = repo();
  const lines = [];
  const t0 = Date.now();
  const res = await runMutants('loop.test.js', MUT, { cwd: r.d, timeoutMs: 1500, ...quiet(lines) });
  assert.ok(Date.now() - t0 < 30000, 'bounded by the timeout');
  assert.deepStrictEqual(res.timedOut, ['changes it']);
  assert.strictEqual(res.killed, 0, 'a hang is not a kill');
  assert.ok(lines.some(l => /^TIMED OUT changes it .*no termination guard/.test(l)), lines.join('\n'));
  assert.match(lines[lines.length - 1], /^0\/1 killed, 1 timed out$/);
  assert.strictEqual(fs.readFileSync(r.x, 'utf8'), ORIG);
  assert.ok(r.clean(), 'and the tree is as it was, journal included');
});

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  await run(`${sig} restores the mutant in the source and exits ${code}`, async () => {
    if (process.platform === 'win32') { console.log(`  (${sig} has no handler on Windows: a kill there is covered by the journal test; this runs on CI's linux)`); return; }
    const r = repo();
    const h = harnessProcess(r.d, 'slow.test.js', 30000);
    await until(() => fs.existsSync(r.journal) && fs.readFileSync(r.x, 'utf8') !== ORIG);
    h.child.kill(sig);
    const { code: got } = await h.exited;
    assert.strictEqual(got, code);
    assert.ok(h.out().includes(`INTERRUPTED by ${sig}: the source is restored.`), h.out());
    assert.strictEqual(fs.readFileSync(r.x, 'utf8'), ORIG);
    assert.ok(r.clean(), 'journal gone too');
  });
}

await run('a kill no handler sees leaves the journal, and the next run restores from it and stops', async () => {
  const r = repo();
  const h = harnessProcess(r.d, 'slow.test.js', 30000);
  await until(() => fs.existsSync(r.journal) && fs.readFileSync(r.x, 'utf8') !== ORIG);
  h.child.kill('SIGKILL');
  await h.exited;
  assert.notStrictEqual(fs.readFileSync(r.x, 'utf8'), ORIG, 'the kill left the mutant: the case this guards');
  const lines = [];
  const res = await runMutants('ok.test.js', MUT, { cwd: r.d, ...quiet(lines) });
  assert.strictEqual(res.recovered, true);
  assert.match(lines[0], /^RECOVERED: a previous run was killed during the mutant "changes it"; x\.js is restored/);
  assert.strictEqual(fs.readFileSync(r.x, 'utf8'), ORIG);
  assert.ok(r.clean());
  const again = [];
  assert.strictEqual((await runMutants('ok.test.js', MUT, { cwd: r.d, ...quiet(again) })).killed, 1, 'and then it runs');
});

await run('the rule and its finding are in §7.7', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs/phase-10-entry-gate-spec.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(spec.includes('THE MUTATION HARNESS CANNOT LEAVE A MUTANT IN THE SOURCE'));
  assert.ok(spec.includes('a mutant that never finishes means the mutated code has no termination guard of its own: a finding about the code.'));
});

})();
