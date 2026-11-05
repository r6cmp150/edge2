#!/usr/bin/env node
// The test runner, with a verdict of its own (2026-11-02). Before this, the
// suite was run by a shell loop that counted a file as passing unless it
// printed "FAIL", so a file that crashed on load (a syntax error), was empty,
// or exited 0 having run nothing counted as a pass. One edit this session did
// exactly that, silently. This runner classifies every file, and only one
// class passes:
//   PASS     exit 0, at least one "PASS:" line, no "FAIL:" line
//   FAIL     at least one "FAIL:" line (whatever the exit code)
//   DEAD     non-zero exit and no PASS/FAIL line: it crashed before reporting
//   SILENT   exit 0 and no PASS/FAIL line: it ran nothing it reported
//   TIMEOUT  killed after the time limit
//   LOST     it said it ran N tests and N result lines didn't arrive
// Exit 0 only if every file is PASS and there is at least one file; else 1.
// Its own failure modes are tested: tests/run-tests-checker.test.js runs it
// on a directory of deliberately broken files and expects each class.
//
//   node scripts/run-tests.mjs [dir=tests] [--timeout-ms N] [--json]
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const dir = path.resolve(args.find(a => !a.startsWith('--') && a !== flag('--timeout-ms')) || 'tests');
const timeoutMs = Number(flag('--timeout-ms') || 600000);
const json = args.includes('--json');

const files = readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();
const results = files.map(f => {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { cwd: path.dirname(dir), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1e8 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passes = (out.match(/^PASS: /gm) || []).length;
  // The line after FAIL is the assertion's message: its numbers. Keep it. A failure
  // reported by name alone can't be explained later (2026-11-03: queue-pacing).
  const fails = [...out.matchAll(/^FAIL: (.*)\r?\n(?:\s*\n)*(?!FAIL: |PASS: )([^\r\n]*)/gm)].map(m => (m[2] ? `${m[1]} :: ${m[2].slice(0, 400)}` : m[1]));
  const bareFails = (out.match(/^FAIL: /gm) || []).length;
  // tests/_lib.js says how many tests it ran. A file whose result lines don't add up
  // lost one (2026-11-04: a muted console swallowed a PASS line, and the file still passed).
  const declaredMatch = out.match(/^TESTS RUN: (\d+)$/m);
  const declared = declaredMatch ? Number(declaredMatch[1]) : null;
  let verdict;
  if (r.error && r.error.code === 'ETIMEDOUT') verdict = 'TIMEOUT';
  else if (fails.length || bareFails) verdict = 'FAIL';
  else if (declared != null && declared !== passes) verdict = 'LOST';
  else if (passes === 0) verdict = r.status === 0 ? 'SILENT' : 'DEAD';
  else verdict = r.status === 0 ? 'PASS' : 'FAIL'; // PASS lines but a non-zero exit: something failed unreported
  const detail = verdict === 'PASS' ? null
    : verdict === 'LOST' ? `ran ${declared} test(s), ${passes} result line(s)`
    : verdict === 'FAIL' ? (fails.join(' | ') || (bareFails && `${bareFails} FAIL line(s)`) || `exit ${r.status} after ${passes} PASS line(s)`)
    : (out.trim().split('\n').filter(Boolean).slice(0, 3).join(' / ') || '(no output at all)');
  return { file: f, verdict, passes, exit: r.status, detail };
});

const bad = results.filter(r => r.verdict !== 'PASS');
if (json) console.log(JSON.stringify({ dir, files: results.length, bad: bad.length, results }, null, 1));
else {
  for (const r of results) console.log(`${r.verdict.padEnd(7)} ${r.file}${r.verdict === 'PASS' ? ` (${r.passes})` : `  -- ${r.detail}`}`);
  const counts = results.reduce((c, r) => (c[r.verdict] = (c[r.verdict] || 0) + 1, c), {});
  console.log(`\n${results.length} files: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
}
process.exitCode = (results.length > 0 && bad.length === 0) ? 0 : 1;
