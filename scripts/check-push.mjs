#!/usr/bin/env node
// scripts/check-push.mjs -- a push is declared done by this script's output (2026-11-05). "I check the
// Tests run before I report a push" is a verification habit with nothing verifying it: six pushes went
// red on 2026-11-05 while each was reported from a local runner. Exit 0 only if the Tests run for that
// exact commit finished green. It fails if that run is missing, failed, or still going.
//   node scripts/check-push.mjs <sha> [--wait-seconds N]
// --wait-seconds polls until the run finishes or the time is up, and a run still going then is a failure.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WORKFLOW = 'Tests';

// runs: the workflow's runs for this commit, newest first, with { status, conclusion, databaseId, url }.
export function judgePush(sha, runs) {
  const short = String(sha).slice(0, 12);
  if (!runs || !runs.length) return { ok: false, state: 'MISSING', line: `PUSH NOT CONFIRMED: no ${WORKFLOW} run for ${short}.` };
  const latest = runs[0];
  if (latest.status !== 'completed') return { ok: false, state: 'RUNNING', line: `PUSH NOT CONFIRMED: the ${WORKFLOW} run for ${short} is still ${latest.status} (${latest.url}).` };
  if (latest.conclusion !== 'success') return { ok: false, state: 'FAILED', line: `PUSH FAILED: the ${WORKFLOW} run for ${short} concluded ${latest.conclusion} (${latest.url}).` };
  return { ok: true, state: 'GREEN', line: `PUSH OK: the ${WORKFLOW} run for ${short} succeeded (${latest.url}).` };
}

function readRuns(sha) {
  const out = execFileSync('gh', ['run', 'list', '--commit', sha, '--workflow', WORKFLOW, '--limit', '5', '--json', 'status,conclusion,databaseId,url,createdAt'], { encoding: 'utf8' });
  return JSON.parse(out).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  if (!/^[0-9a-f]{7,40}$/.test(sha || '')) { console.error('usage: node scripts/check-push.mjs <sha> [--wait-seconds N]'); process.exit(2); }
  const full = execFileSync('git', ['rev-parse', sha], { encoding: 'utf8' }).trim();
  const i = process.argv.indexOf('--wait-seconds');
  const deadline = Date.now() + (i > 0 ? Number(process.argv[i + 1]) : 0) * 1000;
  let verdict;
  for (;;) {
    let runs = null;
    try { runs = readRuns(full); } catch (e) {
      // gh failing isn't a green run. It can't tell, so the push isn't confirmed.
      console.error(`PUSH NOT CONFIRMED: could not read the runs (${String(e.message).split('\n')[0]}).`);
      process.exit(1);
    }
    verdict = judgePush(full, runs);
    if (verdict.ok || verdict.state === 'FAILED' || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 15000));
  }
  console.log(verdict.line);
  process.exit(verdict.ok ? 0 : 1);
}
