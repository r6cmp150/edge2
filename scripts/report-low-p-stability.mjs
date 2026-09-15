#!/usr/bin/env node
// Task 3 (Roman, 2026-09-15): absolute percentage points is the wrong
// ruler for a low-probability cell. 30.5% -> 15.7% is 14.8pp but a
// HALVING, and it's exactly the kind of cell that gives cut advice (a
// low p_recover_2d) or "peak's already in" advice (a low p_peak_already_in)
// -- those are the ones that must be stable, on the ruler that matches
// what the number actually means to someone reading it.
//
// Reads artifacts/exit-model-dataset/oos-diffs.json (written by
// build-exit-model-tables.mjs's most recent run) -- no re-streaming.
// For every OOS-comparable cell whose PRODUCTION (full-period, shipped)
// value is < 35, reports relative change = (second_half - first_half) /
// first_half, and flags anything where the second half is less than half
// or more than double the first (a genuine order-of-magnitude-adjacent
// swing, not just "moved a few points").
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const diffs = JSON.parse(readFileSync(path.join(REPO_ROOT, 'artifacts', 'exit-model-dataset', 'oos-diffs.json'), 'utf8'));

function report(modelName, metricName, branches) {
  console.log(`\n=== ${modelName} (${metricName}), cells with shipped (full-period) value < 35 ===`);
  for (const [branch, rows] of Object.entries(branches)) {
    const lowP = rows.filter(r => r.full != null && r.full < 35);
    const withRelChange = lowP.map(r => {
      // relative change measured from the LOWER of the two halves as
      // denominator would always inflate; use first_half as the anchor
      // (matches "fit then validate" direction -- what changed relative
      // to what was originally measured).
      const base = r.first_half;
      const relChange = base !== 0 ? ((r.second_half - base) / base) * 100 : null;
      const ratio = base !== 0 ? r.second_half / base : null;
      return { ...r, relChangePct: relChange != null ? +relChange.toFixed(1) : null, ratio: ratio != null ? +ratio.toFixed(2) : null };
    });
    const failing = withRelChange.filter(r => r.ratio != null && (r.ratio <= 0.5 || r.ratio >= 2.0));
    withRelChange.sort((a, b) => {
      const ea = a.ratio == null ? 0 : Math.abs(Math.log(a.ratio));
      const eb = b.ratio == null ? 0 : Math.abs(Math.log(b.ratio));
      return eb - ea;
    });
    console.log(`\n-- ${branch}: ${lowP.length} low-p cells (of ${rows.length} OOS-comparable), ${failing.length} fail the halve/double test --`);
    console.log(JSON.stringify(withRelChange.slice(0, 10), null, 2));
  }
}

report('Model A', 'p_recover_2d', diffs.modelA);
report('Model B', 'p_peak_already_in', diffs.modelB);
