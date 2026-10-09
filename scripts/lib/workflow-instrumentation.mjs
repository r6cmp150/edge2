// Phase 9 §2.7 -- each scheduled script reports its no-op DECISION, once,
// at the single point where that decision exists. Writes to the GitHub
// Actions env file ($GITHUB_ENV) so the workflow's LAST step (after this
// script has returned) can PATCH the workflow_runs row the FIRST step
// inserted -- see db/023's header for the insert/update split.
//
// ONE FUNCTION, BOTH ANSWERS (2026-10-09). This was reportNoop(reason),
// which only ever wrote WORKFLOW_IS_NOOP=true; the YAML filled every other
// case with `:-false`. So a run that crashed before deciding anything was
// recorded as "determined: did real work" -- the storage asserting a value
// the computation never produced. Now:
//   reportNoopDecision(true, reason) -> WORKFLOW_IS_NOOP=true + reason
//   reportNoopDecision(false)        -> WORKFLOW_IS_NOOP=false
//   never called (crashed first)     -> unset -> YAML sends null ->
//                                       is_noop NULL, "not determined",
//                                       which is true.
// One call site per script, at the decision -- not a reportWork() beside a
// reportNoop() that each script must remember to pair correctly ("a
// function that must be called and wasn't" is how evaluateSetupsBatch went
// missing from the logger path). Workflows with no no-op concept
// (backup-tables, build-float-table) call it with false once they commit
// to real work, so NULL keeps ONE meaning: the run died before deciding.
//
// The env-file write was verified to reach the final step (2026-10-09:
// the outcome step's environment printout in past no-op runs shows
// WORKFLOW_IS_NOOP: true) -- process.env would NOT survive the node
// process; $GITHUB_ENV does.
//
// Guards are loud: a non-boolean or a second call in the same run throws
// (two decisions in one run is a bug at the call site). The env-file WRITE
// itself stays best-effort -- if it fails, the variable is unset and the
// row honestly says "not determined"; it must never be the reason a
// scheduled job fails.
import { appendFileSync } from 'node:fs';

let decided = false;

export function reportNoopDecision(isNoop, reason = null) {
  if (typeof isNoop !== 'boolean') throw new TypeError(`reportNoopDecision: isNoop must be a boolean, got ${JSON.stringify(isNoop)}`);
  if (decided) throw new Error('reportNoopDecision: called twice in one run -- one decision per run, at the single point it exists');
  decided = true;
  if (!process.env.GITHUB_ENV) return; // local / non-Actions run: nothing to persist
  try {
    let out = `WORKFLOW_IS_NOOP=${isNoop}\n`;
    if (isNoop && reason != null) {
      // Heredoc form (KEY<<DELIM ... DELIM): safe for any characters in the reason.
      const oneLine = String(reason).replace(/\r?\n/g, ' ').slice(0, 900);
      const delim = `NOOP_EOF_${Date.now()}`;
      out += `WORKFLOW_NOOP_REASON<<${delim}\n${oneLine}\n${delim}\n`;
    }
    appendFileSync(process.env.GITHUB_ENV, out);
  } catch (e) {
    console.error(`[workflow-instrumentation] failed to write GITHUB_ENV (non-fatal; is_noop will record as not determined): ${e.message}`);
  }
}
