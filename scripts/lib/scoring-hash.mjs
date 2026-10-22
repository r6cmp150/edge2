// scripts/lib/scoring-hash.mjs -- the identity of the EDGE scoring formula
// (phase-10 spec §7.6 step 1d, db/028 code_version.scoring_hash).
//
// The hash covers exactly the source that decides a score and its label:
// the macro table, the macro lookup, the point function, the two helper
// point tables, scoreStock (which detects the setups it prices) and, from
// step 2 on, the dated threshold table and scoreLabel. Comments and
// whitespace are normalised away, so a comment edit is not a new formula,
// but any change to a term, a bucket or a threshold is.
//
// Used by tests/score-components.test.js to pin core/edge-scoring.js's
// SCORING_HASH and SCORING_VERSION, so the formula can't change without
// both changing. It's in scripts/lib so the same function also hashes old
// revisions read from git.
import { createHash } from 'node:crypto';

export const FORMULA_SECTIONS = [
  ['const', 'MACRO_ADJUSTMENTS'],
  ['function', 'getMacroAdjustment'],
  ['function', 'scoreComponents'],
  ['function', 'consUpPoints'],
  ['function', 'relStrengthPoints'],
  ['function', 'scoreStock'],
  ['const', 'SCORE_THRESHOLDS_BY_VERSION'],
  ['function', 'scoreLabel'],
];

function section(src, kind, name) {
  const re = kind === 'function'
    ? new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)
    : new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`);
  const m = src.match(re);
  return m ? m[0] : null;
}

// Strip // and /* */ comments, then collapse whitespace. The scoring code
// has no string literal containing "//" or "/*" (checked: bucket ids and
// labels only), so this can't eat code.
function normalise(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
}

// Sections absent from a revision (the threshold table and scoreLabel
// before step 2) hash as an explicit marker, never silently skipped.
export function scoringHash(src) {
  const parts = FORMULA_SECTIONS.map(([kind, name]) => {
    const s = section(src, kind, name);
    return `${name}:${s == null ? '<absent>' : normalise(s)}`;
  });
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
