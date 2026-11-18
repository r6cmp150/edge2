// scripts/lib/test-verdict.cjs -- the ONE classification of a test file's run (2026-11-18). It was inline in
// scripts/run-tests.mjs; the mutation harness (scripts/lib/mutants.cjs) judged a mutant by exit code alone, a second,
// weaker verdict. Three throwaway harnesses in six days re-derived it badly, the last one unable to see a LOST file,
// so a real survivor passed as killed (the reviewer: "a throwaway harness ... is an unreviewed reimplementation of the
// thing being trusted"). Now both call this, and a file means the same thing to each.
//   PASS     exit 0, at least one "PASS:" line, no "FAIL:" line, and as many PASS lines as tests it says it ran
//   FAIL     at least one "FAIL:" line (whatever the exit code), or PASS lines and a non-zero exit
//   DEAD     non-zero exit and no PASS/FAIL line: it crashed before reporting
//   SILENT   exit 0 and no PASS/FAIL line: it ran nothing it reported
//   TIMEOUT  killed after the time limit
//   LOST     it said it ran N tests and N result lines didn't arrive
// { out, status, timedOut } -> { verdict, passes, detail, firstFail, failNames }
function testVerdict({ out, status, timedOut }) {
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
  if (timedOut) verdict = 'TIMEOUT';
  else if (fails.length || bareFails) verdict = 'FAIL';
  else if (declared != null && declared !== passes) verdict = 'LOST';
  else if (passes === 0) verdict = status === 0 ? 'SILENT' : 'DEAD';
  else verdict = status === 0 ? 'PASS' : 'FAIL'; // PASS lines but a non-zero exit: something failed unreported
  const detail = verdict === 'PASS' ? null
    : verdict === 'LOST' ? `ran ${declared} test(s), ${passes} result line(s)`
    : verdict === 'FAIL' ? (fails.join(' | ') || (bareFails && `${bareFails} FAIL line(s)`) || `exit ${status} after ${passes} PASS line(s)`)
    : (out.trim().split('\n').filter(Boolean).slice(0, 3).join(' / ') || '(no output at all)');
  const first = out.match(/^FAIL: ([^\r\n]*)/m);
  // the failing tests by name, for a caller that weighs WHICH test failed (mutate-portfolio-sort's behavioural / lint
  // split): it reads them here instead of parsing the output itself
  const failNames = [...out.matchAll(/^FAIL: ([^\r\n]*)$/gm)].map(m => m[1]);
  return { verdict, passes, detail, firstFail: first ? first[1] : null, failNames };
}
module.exports = { testVerdict };
