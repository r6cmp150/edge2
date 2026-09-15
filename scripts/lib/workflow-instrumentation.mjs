// Phase 9 §2.7 -- called by a scheduled script at the EXACT point it
// already self-diagnoses a no-op (found live 2026-09-10/09-14, console-
// only until now: log-signals-edge/warrior's DST-mismatch checks,
// fill-outcomes' market-still-open clock check, capture-movers-
// snapshot's market-closed marker). Writes to the GitHub Actions env
// file so a LATER step in the same job (after this script has already
// returned) can read it and PATCH the workflow_runs row a separate,
// EARLY step already inserted -- see db/023's header for why the
// insert/update split exists (actual_fired_at must be captured before
// this script even starts running, not after it decides it's a no-op).
//
// Best-effort, deliberately: a failure to WRITE the instrumentation
// record must never be the reason a scheduled job fails. Every call site
// already logs the same reason to console (unchanged) -- this adds a
// second, queryable copy, it doesn't replace the first.
import { appendFileSync } from 'node:fs';

export function reportNoop(reason) {
  const oneLine = String(reason).replace(/\r?\n/g, ' ').slice(0, 900);
  try {
    if (process.env.GITHUB_ENV) {
      // Heredoc form (KEY<<DELIM ... DELIM) rather than KEY=value: safe
      // even if a reason ever contains a character GITHUB_ENV's plain
      // form would misparse, at the cost of a few extra lines.
      const delim = `NOOP_EOF_${Date.now()}`;
      appendFileSync(process.env.GITHUB_ENV, `WORKFLOW_IS_NOOP=true\nWORKFLOW_NOOP_REASON<<${delim}\n${oneLine}\n${delim}\n`);
    }
  } catch (e) {
    console.error(`[workflow-instrumentation] failed to write GITHUB_ENV (non-fatal, the job continues): ${e.message}`);
  }
}
