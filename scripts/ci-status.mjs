#!/usr/bin/env node
// scripts/ci-status.mjs -- the Tests workflow's verdict on one commit, as ONE of: PASSED, FAILED, NO RUN, NOT PASSED
// (cancelled, timed out, skipped...) or STILL RUNNING. Each has its own exit code, so "no run was found" can never be
// read as "the run failed". (2026-11-25, the reviewer: a check that returns failure for "no run found" cannot be told
// apart from "the run failed". My own `gh run watch $(gh run list ...)` printed "CI exit 1" for a commit that was never
// pushed.)
//   node scripts/ci-status.mjs <commit> [--appear-seconds 90] [--finish-seconds 1200] [--workflow Tests]
// Waits up to --appear-seconds for a run of the commit to exist, then up to --finish-seconds for it to complete.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXIT = { PASSED: 0, FAILED: 1, 'NO RUN': 2, 'NOT PASSED': 3, 'STILL RUNNING': 4 };

// runs: gh's JSON for the commit's runs of the workflow, newest first. The verdict is the NEWEST run's.
export function classify(runs) {
  if (!runs || !runs.length) return { verdict: 'NO RUN' };
  const r = runs[0];
  if (r.status !== 'completed') return { verdict: 'STILL RUNNING', id: r.databaseId, status: r.status };
  if (r.conclusion === 'success') return { verdict: 'PASSED', id: r.databaseId };
  if (r.conclusion === 'failure') return { verdict: 'FAILED', id: r.databaseId };
  return { verdict: 'NOT PASSED', id: r.databaseId, conclusion: r.conclusion };
}
export function line(c, sha) {
  const tail = c.verdict === 'NO RUN' ? 'no workflow run exists for this commit (was it pushed?); this is not a failed build'
    : c.verdict === 'NOT PASSED' ? `run ${c.id} concluded ${c.conclusion}, which is neither a pass nor a test failure`
    : c.verdict === 'STILL RUNNING' ? `run ${c.id} is ${c.status}; no verdict yet`
    : `run ${c.id}`;
  return `CI ${c.verdict}: ${sha} -- ${tail}`;
}

async function main() {
  const sha = process.argv[2];
  if (!sha || sha.startsWith('--')) { console.error('usage: node scripts/ci-status.mjs <commit> [--appear-seconds N] [--finish-seconds N] [--workflow NAME]'); process.exit(64); }
  const arg = (k, d) => (i => (i < 0 ? d : process.argv[i + 1]))(process.argv.indexOf(k));
  const appear = Number(arg('--appear-seconds', 90)) * 1000, finish = Number(arg('--finish-seconds', 1200)) * 1000, wf = arg('--workflow', 'Tests');
  const full = execFileSync('git', ['rev-parse', sha]).toString().trim();
  const runs = () => JSON.parse(execFileSync('gh', ['run', 'list', '--commit', full, '--workflow', wf, '--limit', '5', '--json', 'databaseId,status,conclusion,createdAt']).toString())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  let c = classify(runs());
  while (c.verdict === 'NO RUN' && Date.now() - t0 < appear) { await sleep(10000); c = classify(runs()); }
  while (c.verdict === 'STILL RUNNING' && Date.now() - t0 < appear + finish) { await sleep(15000); c = classify(runs()); }
  console.log(line(c, full.slice(0, 7)));
  process.exit(EXIT[c.verdict]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
