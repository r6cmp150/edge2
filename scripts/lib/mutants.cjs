// scripts/lib/mutants.cjs -- run mutants against a test (2026-11-04). A mutation run against a
// failing baseline proves nothing: every mutant "kills". So the baseline runs first, its result
// is a required line of the report, and a failing one stops the run.
// mutants: [[file, oldText, newText, name], ...]; each oldText must occur exactly once.
//
// It must never leave a mutant in the source (2026-11-05: a run killed by `timeout` mid-mutant
// skipped its restore and left one in the spec; the baseline check and the runner caught it).
// Four guards, because no single one covers every way a run ends:
//   - a clean tree before it starts: a leftover mutant shows as a change, and the report names a commit;
//   - a journal written before each mutant and removed after its restore: a run killed outright
//     (SIGKILL, or any kill on Windows, where no handler runs) leaves it, and the next run restores
//     from it and stops;
//   - SIGINT and SIGTERM kill the running test, restore the current mutant and exit (POSIX). The tests
//     run asynchronously so the handler runs at once: under spawnSync it could only run after the test
//     returned, by which time it had been removed;
//   - a timeout per mutant. A mutant that never finishes is reported as TIMED OUT, not as a kill:
//     it means the mutated code has no termination guard of its own, which is a finding about the code.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { treeState } = require('./tree-state.cjs');

const JOURNAL = '.mutant-journal.json';

async function runMutants(test, mutants, { cwd = process.cwd(), print = console.log, timeoutMs = 120000 } = {}) {
  const none = extra => ({ baseline: false, killed: 0, total: mutants.length, survived: [], timedOut: [], ...extra });
  const journal = path.join(cwd, JOURNAL);
  if (fs.existsSync(journal)) {
    const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
    fs.writeFileSync(j.path, j.orig);
    fs.unlinkSync(journal);
    print(`RECOVERED: a previous run was killed during the mutant "${j.name}"; ${j.file} is restored from the journal. Nothing run: check the tree, then run again.`);
    return none({ recovered: true });
  }
  const tree = treeState(cwd);
  print(`TREE: ${tree}`);
  if (!/ clean$/.test(tree)) {
    print('REFUSED: the tree is not clean. Commit first, so a mutant left behind shows as a change and this report names a commit.');
    return none({ refused: true });
  }
  let child = null;
  const runTest = () => new Promise(resolve => {
    child = spawn(process.execPath, [test], { cwd, stdio: 'ignore' });
    let timedOutNow = false;
    const timer = setTimeout(() => { timedOutNow = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', code => { clearTimeout(timer); child = null; resolve(timedOutNow ? 'timeout' : code === 0 ? 'pass' : 'fail'); });
  });
  const baseline = await runTest();
  if (baseline !== 'pass') {
    print(`BASELINE: FAILED (${test})${baseline === 'timeout' ? `, timed out after ${timeoutMs} ms` : ''}. No mutants run: a failing test "kills" everything.`);
    return none();
  }
  print(`BASELINE: passed (${test}).`);

  let current = null; // { path, orig } while a mutant is in the source
  const restore = () => {
    if (current) { fs.writeFileSync(current.path, current.orig); current = null; }
    if (fs.existsSync(journal)) fs.unlinkSync(journal);
  };
  const onSignal = (sig, code) => () => { if (child) child.kill('SIGKILL'); restore(); print(`INTERRUPTED by ${sig}: the source is restored.`); process.exit(code); };
  const handlers = [['SIGINT', onSignal('SIGINT', 130)], ['SIGTERM', onSignal('SIGTERM', 143)]];
  for (const [s, h] of handlers) process.on(s, h);

  const survived = [], timedOut = [];
  try {
    for (const [file, a, b, name] of mutants) {
      const p = path.join(cwd, file);
      const orig = fs.readFileSync(p, 'utf8');
      const from = orig.includes('\r\n') ? a.replace(/\n/g, '\r\n') : a;
      if (orig.split(from).length !== 2) { print(`NO ANCHOR ${name}`); survived.push(name); continue; }
      fs.writeFileSync(journal, JSON.stringify({ file, path: p, orig, name }));
      current = { path: p, orig };
      fs.writeFileSync(p, orig.replace(from, () => b));
      let result;
      try { result = await runTest(); } finally { restore(); }
      if (result === 'timeout') { timedOut.push(name); print(`TIMED OUT ${name} (no result in ${timeoutMs} ms: the mutated code has no termination guard)`); }
      else print(`${result === 'fail' ? 'killed  ' : 'SURVIVED'} ${name}`);
      if (result === 'pass') survived.push(name);
    }
  } finally {
    restore();
    for (const [s, h] of handlers) process.removeListener(s, h);
  }
  const killed = mutants.length - survived.length - timedOut.length;
  print(`${killed}/${mutants.length} killed${timedOut.length ? `, ${timedOut.length} timed out` : ''}`);
  return { baseline: true, killed, total: mutants.length, survived, timedOut };
}
module.exports = { runMutants, JOURNAL };
