// scripts/lib/forward-declaration.mjs -- the forward test's declared numbers and its state machine, in one place, so
// measure A (measure-selection-differential.mjs) and measures B and C (measure-forward-test.mjs) cannot disagree on them.
// Declared in STATUS: 4428ed0, amended 30ef1ac (qualifying days, backstop, measure C), and the futility look (2026-11-25).
export const QUALIFYING_DAYS = 60, FUTILITY_AT = 30, BACKSTOP_TRADING_DAYS = 180, FIRST_QUALIFYING = '2026-11-27', HURDLE = 0.291;
// RESTARTED 2026-11-26 (b86d5c3): FIRST_QUALIFYING is the first trading day after the new start line (11-26 is
// Thanksgiving, closed); the count is 0 of 60 again and the futility look's fixed set is the first 30 from the new line.

// THE BUILD RULE (the reviewer, CC-the-date-was-mine-and-three-rulings §2; declared 2026-11-26, before any position
// after the start line existed): "The test includes positions opened on the build shipped at b86d5c3 or later, read
// from the buy snapshot's buildVersion. A position opened after the start line on an earlier build is outside it, by
// that fact and not by judgement. If buildVersion is absent on any position, it is NOT ESTABLISHED and named, never
// assumed either way." The start line was always about the instrument; the timestamp stood in for it, and a phone still
// running the cached old build breaks that. START_BUILD is b86d5c3's VERSION stamp (index.html ?v=, sw.js CACHE_NAME
// edge2-20261126210000). Stamps are YYYYMMDDHHMMSS, so a later build compares greater as a string of the same length;
// a value that is not 14 digits is not a stamp and is NOT ESTABLISHED too.
// Where: signal_snapshot_at_buy.snapshot.buildVersion, joined by position_id (the signal object copied at the tap).
// Checked 2026-11-26 at backup ca79153: all 168 positions bought since 2026-11-12 have it, and on every one it equals
// the row's own code_version.app.
export const START_BUILD = '20261126210000';
export function buildOf(snapRow) {
  const v = snapRow && snapRow.snapshot && snapRow.snapshot.buildVersion;
  return typeof v === 'string' && /^\d{14}$/.test(v) ? v : null;
}
// splits positions already past the start line: IN (START_BUILD or later), OLD BUILD (outside, by fact) and NOT
// ESTABLISHED (no readable buildVersion: held out of every computed figure and NAMED at every run, never counted in or
// out silently; whether one belongs is the reviewer's). snaps: Map of String(position_id) -> signal_snapshot_at_buy row.
export function byBuild(positions, snaps) {
  const out = { in: [], oldBuild: [], notEstablished: [] };
  for (const p of positions) {
    const b = buildOf(snaps.get(String(p.position_id)));
    (b == null ? out.notEstablished : b >= START_BUILD ? out.in : out.oldBuild).push(p);
  }
  return out;
}
const nameOf = p => `${p.ticker} ${String(p.buy_date).slice(0, 10)} ${p.buy_time ?? ''} (position ${p.position_id ?? 'none'})`.replace('  ', ' ');
// THE CAPTURE TRIPWIRE (the reviewer, CC-the-inputs-were-free-and-the-check-only-covers-one-direction §2, declared
// 2026-11-27, the first possible qualifying day, before any position after the start line was read): if NOT
// ESTABLISHED exceeds 10% of the positions in the test, it is reported as a CAPTURE FAILURE to be fixed, not absorbed as
// a footnote. The denominator is the positions the test would count if every build were known: IN plus NOT ESTABLISHED
// (old-build positions are outside by fact and in neither). Expected to sit at zero (168 of 168 carried buildVersion,
// 2026-11-26); it stops a slow drift from quietly shrinking the sample. It changes no state and no figure.
export const NOT_ESTABLISHED_MAX = 0.10;
export function captureFailure(split) {
  const n = split.in.length + split.notEstablished.length;
  return n > 0 && split.notEstablished.length / n > NOT_ESTABLISHED_MAX;
}
// the line every run prints, so the exclusion is visible rather than silent (reported at the first reading)
export function buildLine(split) {
  const names = xs => (xs.length ? `: ${xs.map(nameOf).join('; ')}` : '');
  const line = `THE BUILD RULE (build ${START_BUILD}, b86d5c3, or later): ${split.in.length} in; ${split.oldBuild.length} opened after the start line on an earlier build, OUTSIDE by that fact${names(split.oldBuild)}; ${split.notEstablished.length} NOT ESTABLISHED (no buildVersion in the buy snapshot), held out and named${names(split.notEstablished)}.`;
  if (!captureFailure(split)) return line;
  const n = split.in.length + split.notEstablished.length;
  return `${line}\n::error::CAPTURE FAILURE: ${split.notEstablished.length} of ${n} positions (${(100 * split.notEstablished.length / n).toFixed(1)}%) have no buildVersion, above the declared ${100 * NOT_ESTABLISHED_MAX}%. The buy snapshot is not being captured: a defect to fix, not a footnote. Take it to the reviewer.`;
}

const dayOf = p => String(p.buy_date).slice(0, 10);
// the qualifying days (a day with at least one position opened after the start line), in order, and the positions on
// the first `n` of them
export function qualifying(positions, n = QUALIFYING_DAYS) {
  const days = [...new Set(positions.map(dayOf))].sort();
  const keep = new Set(days.slice(0, n));
  return { days, positions: positions.filter(p => keep.has(dayOf(p))) };
}

// THE FUTILITY LOOK: one, on one fixed set -- the positions of the first 30 qualifying days -- taken at the first run on
// which every one of them has every measured horizon closed. It can only STOP the test: FUTILE when, for A and B both,
// the point estimate is at or below zero AND the upper end of its 95% interval is below the hurdle. Otherwise CONTINUE.
// It never concludes a positive, never extends the test and never changes the bar: those words are not in its range.
export function futility(a, b) {
  const futileOne = m => m.mean <= 0 && m.hi < HURDLE;
  return futileOne(a) && futileOne(b) ? 'FUTILE' : 'CONTINUE';
}
// whether the look can be taken: not before 30 qualifying days; then only once its fixed set is complete
export function lookState(qualifyingDays, setComplete) {
  if (qualifyingDays < FUTILITY_AT) return 'NOT YET';
  return setComplete ? 'TAKE' : 'PENDING';
}
// the test's state. FUTILE is final once the look returns it; then EVALUATE at 60; then the backstop; else INTERIM
export function testState(qualifyingDays, tradingDaysElapsed, look = null) {
  if (look === 'FUTILE') return 'FUTILE';
  if (qualifyingDays >= QUALIFYING_DAYS) return 'EVALUATE';
  if (tradingDaysElapsed > BACKSTOP_TRADING_DAYS) return 'NOT ESTABLISHED FOR WANT OF DAYS';
  return 'INTERIM';
}
