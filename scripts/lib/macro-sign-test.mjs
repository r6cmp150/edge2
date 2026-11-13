// scripts/lib/macro-sign-test.mjs -- the primary pre-committed macro test
// (phase-10 spec, restated 2026-11-04), written before any data exists. Per day,
// the predicted sign of the condition's adjustment for OTHER, against the day-mean
// close return of the logger's shown signals. One-sided, in the direction the table
// claims, by day-level permutation at p < 0.05. It tests what a pass would make us
// do: apply the adjustment. A day is one observation, whatever its row count.
//
// No network and no reads: the data is handed in, so tests/macro-sign-test.test.js
// can hold it, and scripts/macro-sign-horizon.mjs plans with the same statistic.
export const MIN_DAYS = 20;
// A correlation needs the sign to vary, not every sign to appear: the replay's rule gave
// + on 0 to 3 of 56 days, so "5 of each" could never be met. A sign seen on fewer days
// than this earns nothing even on a pass (signsSupported).
export const MIN_DAYS_AWAY_FROM_COMMON_SIGN = 5;
export const MIN_DAYS_TO_SUPPORT_A_SIGN = 5;
export const ALPHA = 0.05;
export const SHUFFLES = 10000;
// signal_log's ret_* columns are FRACTIONS (0.0123 is 1.23%): fill-outcomes writes
// (price - reference) / reference. This test, its minimum effect and the planning table
// all work in percentage points of return, through this one function. A second copy of
// the 100 is how a threshold ends up a hundredfold off. tests/macro-sign-test.test.js
// pins the unit against real prices.
export const retToPoints = ret => 100 * ret;
// PRE-REGISTERED, PRIMARY: blocks of consecutive days are shuffled, not days, so any run
// of conditions survives under the null. History shows no clustering; forward data may.
// 3: about 8 blocks at 25 days, costing 0 to 4 points of power. The day-shuffled p is
// reported as supporting and never decides: choosing between them after seeing both would
// undo the pre-registration. BLIND SPOT: signs repeating exactly every 3 days can't be told
// from their own shuffles, so p can't fall below about 1/3 (signAutocorrelation flags it).
export const BLOCK_DAYS = 3;
// The smallest gap, in points of day-mean close return, that may move anything. A pass
// below it earns nothing: it is the gap the test can see, not one the table implies.
export const MIN_EFFECT_POINTS = 1;
// Written before there is a result (phase-10 spec). A miss is not a null finding.
export const MISS_READING = 'No effect of about 2 points or larger was detected; smaller effects remain UNMEASURED. This does not mean the condition carries no information.';

// +1, -1, or 0 for CHOPPY. null for a label the table doesn't know: never a guess.
export function predictedSign(condition, adjustments) {
  const row = adjustments[condition];
  if (!row || typeof row.OTHER !== 'number') return null;
  return Math.sign(row.OTHER);
}

// Each trading day's label: Groq's first answer that day that was given the moves
// (app.js macroGroqDayLabel holds the same rule, and the test compares them). Given
// without the full moves is a different mechanism, and labels nothing.
export function firstLabel(dayObservations) {
  const asked = dayObservations.slice().sort((a, b) => String(a.fetched_at).localeCompare(String(b.fetched_at)))
    .find(r => !r.pattern_incomplete && r.pattern_condition && r.groq_condition);
  return asked ? { condition: asked.groq_condition, at: asked.fetched_at } : null;
}

// One row per trading day (outcome in points), and every day left out with why. The outcome counts only
// signals first shown AT OR AFTER the label: a signal shown earlier has part of its
// return inside the moves the label was given, which would correlate with the label
// mechanically (the same look-ahead as a later Groq ask). Moves that hit a split are
// not returns.
export function buildDays(observations, signals, adjustments) {
  const obsByDay = {}, sigByDay = {};
  for (const r of observations) (obsByDay[r.trading_date] = obsByDay[r.trading_date] || []).push(r);
  for (const s of signals) {
    if (s.engine_source === 'EDGE' && s.tier === 'SHOWN') (sigByDay[s.signal_date] = sigByDay[s.signal_date] || []).push(s);
  }
  const days = [], dropped = [];
  for (const date of Object.keys(obsByDay).sort()) {
    const label = firstLabel(obsByDay[date]);
    if (!label) { dropped.push({ date, reason: 'no Groq answer given the moves' }); continue; }
    const sign = predictedSign(label.condition, adjustments);
    if (sign == null) { dropped.push({ date, reason: `label ${label.condition} is not in the table` }); continue; }
    const usable = (sigByDay[date] || []).filter(s => s.ret_close != null && s.ret_close_split_in_window !== true);
    const after = usable.filter(s => new Date(s.first_shown_at).getTime() >= new Date(label.at).getTime());
    if (!after.length) {
      dropped.push({ date, reason: usable.length ? `all ${usable.length} signal(s) were first shown before the label` : 'no shown signal with a close return' });
      continue;
    }
    days.push({ date, condition: label.condition, sign, outcome: retToPoints(after.reduce((a, s) => a + s.ret_close, 0) / after.length), signals: after.length });
  }
  return { days, dropped };
}

export function barState(days) {
  const plus = days.filter(d => d.sign > 0).length, minus = days.filter(d => d.sign < 0).length, zero = days.length - plus - minus;
  const awayFromCommon = days.length - Math.max(plus, minus, zero);
  return {
    n: days.length, plus, minus, zero, awayFromCommon,
    met: days.length >= MIN_DAYS && awayFromCommon >= MIN_DAYS_AWAY_FROM_COMMON_SIGN,
    signsSupported: [plus >= MIN_DAYS_TO_SUPPORT_A_SIGN ? '+' : null, minus >= MIN_DAYS_TO_SUPPORT_A_SIGN ? '-' : null].filter(Boolean),
  };
}

function pearson(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
function rng(seed) { // mulberry32: a stated seed gives a repeatable p
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// The signs, cut into blocks from a random starting day (wrapping round) and the blocks
// shuffled. The random start means no day is always at a block's edge.
export function shuffleBlocks(signs, blockDays, rand) {
  const n = signs.length, start = Math.floor(rand() * n), turned = signs.slice(start).concat(signs.slice(0, start)), blocks = [];
  for (let i = 0; i < n; i += blockDays) blocks.push(turned.slice(i, i + blockDays));
  for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; }
  return blocks.flat();
}

// The sign series against itself at lags 1 to 5, no outcome involved. A strong value at
// BLOCK_DAYS is the blind spot above, so the result says so rather than leaving a high p
// to read as "nothing there".
export function signAutocorrelation(signs, maxLag = 5) {
  const n = signs.length, m = signs.reduce((a, b) => a + b, 0) / n;
  const q = signs.reduce((a, s) => a + (s - m) ** 2, 0);
  return Array.from({ length: maxLag }, (_, k) => {
    let c = 0;
    for (let i = k + 1; i < n; i++) c += (signs[i] - m) * (signs[i - k - 1] - m);
    return q > 0 ? c / q : 0;
  });
}

// The gap between the highest and lowest predicted groups that have enough days to mean
// anything, in points. null when fewer than two do.
function gapOf(days) {
  const groups = [1, 0, -1].map(s => days.filter(d => d.sign === s)).filter(g => g.length >= MIN_DAYS_TO_SUPPORT_A_SIGN);
  if (groups.length < 2) return null;
  const mean = g => g.reduce((a, d) => a + d.outcome, 0) / g.length;
  return mean(groups[0]) - mean(groups[groups.length - 1]);
}

// Under a permutation the means and variances don't change, so r moves with
// sum(sign * outcome) alone: that is compared, and r is reported. Below the bar
// there is no result at all, not a weak one.
export function signTest(days, { shuffles = SHUFFLES, seed = 1 } = {}) {
  const bar = barState(days);
  if (!bar.met) return { state: 'NOT_ENOUGH_DAYS', ...bar };
  const signs = days.map(d => d.sign), out = days.map(d => d.outcome);
  const r = pearson(signs, out);
  if (r == null) return { state: 'NOT_ENOUGH_DAYS', reason: 'no variation in the outcome', ...bar };
  const sum = s => s.reduce((a, v, i) => a + v * out[i], 0);
  const observed = sum(signs), rand = rng(seed);
  let atLeast = 0;
  for (let k = 0; k < shuffles; k++) if (sum(shuffleBlocks(signs, BLOCK_DAYS, rand)) >= observed) atLeast++;
  const p = (atLeast + 1) / (shuffles + 1), pass = p < ALPHA, gap = gapOf(days);
  // Supporting only: nothing below reads it.
  const randDays = rng(seed + 1);
  let atLeastDays = 0;
  for (let k = 0; k < shuffles; k++) if (sum(shuffleBlocks(signs, 1, randDays)) >= observed) atLeastDays++;
  const supportingDayShuffledP = (atLeastDays + 1) / (shuffles + 1);
  const autocorrelation = signAutocorrelation(signs);
  const blindSpot = Math.abs(autocorrelation[BLOCK_DAYS - 1]) > 2 / Math.sqrt(days.length);
  const earnsReview = pass && gap != null && gap >= MIN_EFFECT_POINTS && bar.signsSupported.length > 0;
  const reading = !pass ? MISS_READING
    : earnsReview ? `Passed with a gap of ${gap.toFixed(2)} points. Speaks only for: ${bar.signsSupported.join(' and ')}. Size any effect from this gap, not from the table, and re-run at 60 days before it ships.`
    : `Passed, but earns nothing: the gap is ${gap == null ? 'not measurable (too few days on one side)' : `${gap.toFixed(2)} points, under the ${MIN_EFFECT_POINTS}-point minimum`}.`;
  return { state: 'RESULT', r, p, supportingDayShuffledP, shuffles, seed, blockDays: BLOCK_DAYS, pass, gap, earnsReview, reading: blindSpot ? `${reading} CAUTION: the signs show structure at lag ${BLOCK_DAYS}, the block length, where this test is blind.` : reading, signAutocorrelation: autocorrelation, blindSpot, ...bar };
}
