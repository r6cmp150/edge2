// scripts/lib/forward-declaration.mjs -- the forward test's declared numbers and its state machine, in one place, so
// measure A (measure-selection-differential.mjs) and measures B and C (measure-forward-test.mjs) cannot disagree on them.
// Declared in STATUS: 4428ed0, amended 30ef1ac (qualifying days, backstop, measure C), and the futility look (2026-11-25).
export const QUALIFYING_DAYS = 60, FUTILITY_AT = 30, BACKSTOP_TRADING_DAYS = 180, FIRST_QUALIFYING = '2026-11-24', HURDLE = 0.291;

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
