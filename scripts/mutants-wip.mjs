// scripts/mutants-wip.mjs -- mutation-check work in progress WITHOUT EVER WRITING TO THE REAL TREE (2026-11-19, the
// reviewer). The committed harness (scripts/lib/mutants.cjs) refuses a dirty tree, which is right, but mutants are
// wanted BEFORE the commit, and that gap is what sent five probes into the working tree with "I will put it back"
// (spec §7.7, "A probe reads", and "A rule is not a mechanism"). This closes the gap by construction:
//
//   1. clone the repository's HEAD into a new temporary directory;
//   2. apply the working tree's changes there (the diff against HEAD, and every untracked, not-ignored file);
//   3. commit them THERE (a throwaway commit in the clone, never pushed: the clone has no remote of ours to push to);
//   4. run runMutants in the clone, which now sees a clean tree, and print its report;
//   5. delete the clone.
//
// THE PROPERTY THAT MATTERS IS NOT THAT IT RESTORES: IT IS THAT IT NEVER WRITES TO THE REAL TREE AT ALL. The real
// repository is only ever READ (git rev-parse, diff, ls-files, status, and the files themselves), with
// GIT_OPTIONAL_LOCKS=0 so not even git's opportunistic index refresh writes there. An interrupted run, a killed
// process, a mistake in a mutant: none of them can reach the repository, because nothing here holds a path into it
// for writing. DO NOT "SIMPLIFY" THIS BY WORKING IN PLACE. Working in place is the thing this file exists to replace;
// the clone is not overhead, it is the mechanism. (tests/mutants-wip.test.js holds the real tree byte-identical after
// a run, after a run killed outright mid-mutant, and after one interrupted mid-mutant.)
//
// A killed run can leave its clone in the OS temp directory (named in the CLONE line); that is the cost of a kill, and
// it is outside the repository. Ignored files (node_modules, …) are not copied: a test that needs one is not runnable
// here, and its baseline says so.
//
//   node scripts/mutants-wip.mjs <test> <mutants>     mutants: an array of [file, from, to, name] (or {file, from, to, name})
//   node scripts/mutants-wip.mjs <mutants>            mutants: { "<test>": [ ...mutants ], ... }
//   options: --timeout <ms> (per mutant, default 120000), --repo <dir> (default: this script's repository)
// <mutants> is a .json file, or a .cjs module exporting either shape (so an anchor can be built from the source, e.g.
// a whole function from `git show`). Exit 0 only if every set had a passing baseline and every mutant was killed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.GIT_OPTIONAL_LOCKS = '0'; // reading the real repository must not write its index
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { runMutants } = require(path.join(HERE, 'lib/mutants.cjs'));
const { treeState } = require(path.join(HERE, 'lib/tree-state.cjs'));

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const timeoutMs = Number(opt('--timeout') || 120000);
const repo = path.resolve(opt('--repo') || path.dirname(HERE));
if (!(args.length === 1 || args.length === 2)) {
  console.error('usage: node scripts/mutants-wip.mjs [<test>] <mutants.json|.cjs> [--timeout ms] [--repo dir]');
  process.exit(2);
}
const file = path.resolve(args[args.length - 1]);
const loaded = file.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf8')) : require(file);
const norm = m => (Array.isArray(m) ? m : [m.file, m.from, m.to, m.name]);
const sets = args.length === 2 ? [[args[0], loaded]] : Object.entries(loaded);
if (!sets.length || sets.some(([t, ms]) => typeof t !== 'string' || !Array.isArray(ms) || !ms.length)) {
  console.error('mutants: an array (with <test>), or an object of test -> non-empty array');
  process.exit(2);
}

// READS of the real repository: nothing below writes to `repo`.
const readGit = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'buffer', maxBuffer: 2e9, stdio: ['ignore', 'pipe', 'pipe'] });
const head = readGit('rev-parse', 'HEAD').toString().trim();
const realState = treeState(repo);
const diff = readGit('diff', 'HEAD', '--binary');
const untracked = readGit('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean);

// Everything that writes happens under `clone`.
const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-mutants-wip-'));
const removeClone = () => { try { fs.rmSync(clone, { recursive: true, force: true }); } catch (_) { /* reported by the CLONE line */ } };
process.on('exit', removeClone); // the harness exits from its SIGINT/SIGTERM handler; this still runs then
console.log(`REAL TREE: ${realState} (read only)`);
console.log(`CLONE: ${clone}`);
const inClone = (...a) => execFileSync('git', a, { cwd: clone, stdio: ['pipe', 'pipe', 'pipe'] });
let ok = false;
try {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', repo, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  inClone('checkout', '--quiet', '--detach', head);
  if (diff.length) execFileSync('git', ['apply', '--binary', '--whitespace=nowarn'], { cwd: clone, input: diff, stdio: ['pipe', 'pipe', 'pipe'] });
  for (const f of untracked) {
    const to = path.join(clone, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(repo, f), to);
  }
  inClone('add', '-A');
  inClone('-c', 'user.name=mutants-wip', '-c', 'user.email=mutants-wip@localhost', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', `mutants-wip: the working tree of ${realState}, never pushed`);
  const results = [];
  for (const [test, ms] of sets) results.push(await runMutants(test, ms.map(norm), { cwd: clone, timeoutMs }));
  ok = results.every(r => r.baseline && !r.survived.length && !r.timedOut.length && !r.broken.length);
} finally {
  removeClone();
}
process.exitCode = ok ? 0 : 1;
