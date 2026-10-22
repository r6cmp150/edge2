// scripts/lib/code-version.mjs -- db/028 code_version for rows written by
// the cron scripts (phase-10 spec §7.6 step 1d).
//
//   app          = the app.js ?v= stamp in index.html at this checkout: the
//                  same identifier the browser reports for the app.js it
//                  loaded. Never a hand-maintained constant (build_version
//                  was app.js's VERSION, which said v2.18.0 for a month).
//   scoring      = SCORING_VERSION read from core/edge-scoring.js.
//   scoring_hash = COMPUTED from the scoring source this script is
//                  running, not copied from SCORING_HASH. If the two ever
//                  disagree, the row says what actually ran.
//
// NEVER THROWS (2026-10-22). The observer must not break the observed: a
// thrown version lookup would cost a whole run of signal_log rows, which
// can't be recovered, and only 18 of 28 days have any rows as it is. So it
// returns the most honest value it can, and the row is still written:
//   - stamp unreadable            -> app: 'unavailable'
//   - version or hash unreadable  -> scoring: 0 / scoring_hash: 'unavailable'
//     (0 is not a version: versions start at 1, so ">= 1" filters these
//     out). This is a code-integrity failure, so it's also reported loudly
//     by the caller (problems[], printed as a GitHub ::error:: annotation).
// Never NULL: NULL means "recorded before db/028", and "version unreadable"
// is a third state, kept distinct. Every value passes db/028's CHECK (app
// string, scoring number, scoring_hash string).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scoringHash } from './scoring-hash.mjs';

export function readCodeVersion(root) {
  const problems = [];
  let app = 'unavailable', scoring = 0, scoring_hash = 'unavailable';
  try {
    const stamp = readFileSync(path.join(root, 'index.html'), 'utf8').match(/<script src="app\.js\?v=([^"&]+)"/);
    if (stamp) app = stamp[1]; else problems.push('no <script src="app.js?v=..."> in index.html');
  } catch (e) { problems.push(`index.html unreadable: ${e.message}`); }
  try {
    const src = readFileSync(path.join(root, 'core', 'edge-scoring.js'), 'utf8');
    const v = src.match(/^const SCORING_VERSION = (\d+);/m);
    if (v) scoring = Number(v[1]); else problems.push('no SCORING_VERSION in core/edge-scoring.js');
    scoring_hash = scoringHash(src);
  } catch (e) { problems.push(`scoring source unreadable or unhashable: ${e.message}`); }
  return { codeVersion: { app, scoring, scoring_hash }, problems };
}

// For the loggers: the value to write, with any problem printed as a GitHub
// Actions ::error:: annotation (it shows on the run's summary page) and on
// stderr. Never fails the run.
export function codeVersionForRun(root, who) {
  const { codeVersion, problems } = readCodeVersion(root);
  for (const p of problems) {
    console.log(`::error title=${who}: code_version degraded::${p} -- rows are still written, with code_version ${JSON.stringify(codeVersion)}`);
    console.error(`${who}: code_version degraded: ${p}`);
  }
  return codeVersion;
}

// db/030: which kind of trigger started this run. github.event_name inside
// GitHub Actions ('schedule', 'workflow_dispatch', ...), 'local' outside it.
// Never throws and never guesses: 'unavailable' if Actions didn't set it. It
// makes a hand-dispatched scan excludable from delivery and time-of-day
// analyses by construction.
export function triggerTypeForRun() {
  if (process.env.GITHUB_ACTIONS !== 'true') return 'local';
  return process.env.GITHUB_EVENT_NAME || 'unavailable';
}
