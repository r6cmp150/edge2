// scripts/lib/mutants.cjs -- run mutants against a test (2026-11-04). A mutation run against a
// failing baseline proves nothing: every mutant "kills". So the baseline runs first, its result
// is a required line of the report, and a failing one stops the run.
// mutants: [[file, oldText, newText, name], ...]; each oldText must occur exactly once.
const fs = require('fs');
const { spawnSync } = require('child_process');

function runMutants(test, mutants, { cwd = process.cwd(), print = console.log } = {}) {
  const runTest = () => spawnSync('node', [test], { cwd, encoding: 'utf8' }).status === 0;
  if (!runTest()) {
    print(`BASELINE: FAILED (${test}). No mutants run: a failing test "kills" everything.`);
    return { baseline: false, killed: 0, total: mutants.length, survived: [] };
  }
  print(`BASELINE: passed (${test}).`);
  const survived = [];
  for (const [file, a, b, name] of mutants) {
    const path = require('path').join(cwd, file);
    const orig = fs.readFileSync(path, 'utf8');
    const from = orig.includes('\r\n') ? a.replace(/\n/g, '\r\n') : a;
    if (orig.split(from).length !== 2) { print(`NO ANCHOR ${name}`); survived.push(name); continue; }
    fs.writeFileSync(path, orig.replace(from, () => b));
    let killed;
    try { killed = !runTest(); } finally { fs.writeFileSync(path, orig); }
    print(`${killed ? 'killed  ' : 'SURVIVED'} ${name}`);
    if (!killed) survived.push(name);
  }
  print(`${mutants.length - survived.length}/${mutants.length} killed`);
  return { baseline: true, killed: mutants.length - survived.length, total: mutants.length, survived };
}
module.exports = { runMutants };
