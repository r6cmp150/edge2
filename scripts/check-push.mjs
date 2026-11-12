#!/usr/bin/env node
// scripts/check-push.mjs -- a push is declared done by this script's output (2026-11-05). "I check the
// Tests run before I report a push" is a verification habit with nothing verifying it: six pushes went
// red on 2026-11-05 while each was reported from a local runner. Exit 0 only if the Tests run for that
// exact commit finished green. It fails if that run is missing, failed, or still going.
//   node scripts/check-push.mjs <sha> --before        run AHEAD of the push: refuses a commit that isn't deployable
//   node scripts/check-push.mjs <sha> [--wait-seconds N]
// --wait-seconds polls until the run finishes or the time is up, and a run still going then is a failure.
// Pending migrations (2026-11-06): main is deployable at every commit, and pushing main deploys it. A commit whose
// db/pending-migrations.json lists any migration depends on columns the live database doesn't have: --before refuses it,
// and so does the after-push check (by then as an alarm: the deploy has happened). A declaration listing a migration the
// capture (db/live-columns.json) shows applied is stale, and refused too.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WORKFLOW = 'Tests';

// pendingJson / captureJson: the two files' text at the commit (null when absent).
export function judgePending(sha, pendingJson, captureJson) {
  const short = String(sha).slice(0, 12);
  const pad = n => `db/${String(n).padStart(3, '0')}`;
  if (pendingJson == null) return { ok: true, line: `no pending migrations declared at ${short}.` };
  let pending, applied;
  try { pending = JSON.parse(pendingJson).pending; } catch (e) { return { ok: false, line: `PUSH REFUSED: db/pending-migrations.json at ${short} does not parse (${e.message}).` }; }
  if (!Array.isArray(pending)) return { ok: false, line: `PUSH REFUSED: db/pending-migrations.json at ${short} has no "pending" list.` };
  try { applied = JSON.parse(captureJson)._migrations.applied; } catch (e) { return { ok: false, line: `PUSH REFUSED: db/live-columns.json at ${short} can't be read (${e.message}), so no pending declaration can be judged.` }; }
  const stale = pending.filter(n => applied.includes(n));
  if (stale.length) return { ok: false, line: `PUSH REFUSED: ${short} declares ${stale.map(pad).join(', ')} pending, but the capture shows ${stale.length > 1 ? 'them' : 'it'} applied: a stale declaration. Remove ${stale.length > 1 ? 'them' : 'it'} from db/pending-migrations.json.` };
  if (pending.length) return { ok: false, line: `PUSH REFUSED: ${short} depends on ${pending.map(pad).join(', ')}, not yet confirmed applied live (db/pending-migrations.json). Main is deployable at every commit: Roman runs the migration, its run 2 passes, a new capture shows it, and only then does this code go to main.` };
  return { ok: true, line: `no pending migrations at ${short}.` };
}

function fileAt(sha, file) {
  try { return execFileSync('git', ['show', `${sha}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e8 }); } catch { return null; }
}

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

const USAGE = 'usage: node scripts/check-push.mjs <sha> --before | node scripts/check-push.mjs <sha> [--wait-seconds N]';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  // 2026-11-12: every line this script prints names what it checked, and when it cannot identify its subject it says
  // so and fails: exit 2, nothing checked. A usage message names nothing, so it must never pass for a verdict.
  const notRun = why => { console.error(`CHECK NOT RUN: ${why}; nothing was checked.`); console.error(USAGE); process.exit(2); };
  if (!/^[0-9a-f]{7,40}$/.test(sha || '')) notRun(sha === undefined ? 'no commit SHA given' : `${JSON.stringify(sha)} is not a commit SHA`);
  let full;
  try { full = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { full = ''; }
  if (!full) notRun(`${sha} is not a commit in this clone`);
  const pend = judgePending(full, fileAt(full, 'db/pending-migrations.json'), fileAt(full, 'db/live-columns.json'));
  if (process.argv.includes('--before')) { console.log(pend.ok ? `PUSH MAY PROCEED: ${pend.line}` : pend.line); process.exit(pend.ok ? 0 : 1); }
  if (!pend.ok) { console.log(pend.line.replace('PUSH REFUSED', 'PUSH FAILED (already deployed)')); process.exit(1); }
  const i = process.argv.indexOf('--wait-seconds');
  const wait = i > 0 ? Number(process.argv[i + 1]) : 0;
  if (!(wait >= 0)) notRun(`--wait-seconds needs a number of seconds, got ${JSON.stringify(process.argv[i + 1] ?? null)}`); // NaN would poll forever
  const deadline = Date.now() + wait * 1000;
  let verdict;
  for (;;) {
    let runs = null;
    try { runs = readRuns(full); } catch (e) {
      // gh failing isn't a green run. It can't tell, so the push isn't confirmed.
      console.error(`PUSH NOT CONFIRMED: could not read the ${WORKFLOW} runs for ${full.slice(0, 12)} (${String(e.message).split('\n')[0]}).`);
      process.exit(1);
    }
    verdict = judgePush(full, runs);
    if (verdict.ok || verdict.state === 'FAILED' || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 15000));
  }
  console.log(verdict.line);
  process.exit(verdict.ok ? 0 : 1);
}
