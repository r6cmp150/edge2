// scripts/macro-sign-horizon.mjs -- how long the primary macro test takes, and what
// it could detect by then (phase-10 spec, 2026-11-04). PLANNING ONLY.
//
// It reads two things from pinned data and NEVER joins them, on purpose: the spread
// of the outcome's day means (signal_log) and how the predicted signs split (stored
// conditions, or a --plus/--minus/--zero split from the replay). Computing the
// sign-to-return relationship on history would be running the test on data it is
// barred from (the 422 prohibition), and then pre-registering it.
//   node scripts/macro-sign-horizon.mjs [--rev <sha>] [--before 10] [--plus .2 --minus .4]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { retToPoints, predictedSign, shuffleBlocks, BLOCK_DAYS, MIN_DAYS, MIN_DAYS_AWAY_FROM_COMMON_SIGN, ALPHA } from './lib/macro-sign-test.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REV = arg('--rev', 'HEAD');
const rows = t => { const j = JSON.parse(execSync(`git show ${REV}:data/backups/${t}.json`, { cwd: ROOT, maxBuffer: 4e9 })); return Array.isArray(j) ? j : j.rows; };
const c = {};
vm.createContext(c);
const src = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8');
const i = src.indexOf('const MACRO_ADJUSTMENTS = {');
vm.runInContext(src.slice(i, src.indexOf('\n};\n', i) + 4) + ';globalThis.T = MACRO_ADJUSTMENTS;', c);

// The outcome's spread: EDGE SHOWN, day-mean ret_close, in percent. It depends on when
// the scan ran: a noon scan's close is under an hour away. --before 10 keeps rows first
// shown before 10:00 PT, the window the crons are aimed at and the label can precede.
const BEFORE = arg('--before', null) == null ? null : Number(arg('--before', null));
const ptHour = iso => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
const byDay = {};
for (const s of rows('signal_log')) {
  if (s.engine_source !== 'EDGE' || s.tier !== 'SHOWN' || s.ret_close == null || s.ret_close_split_in_window === true) continue;
  if (BEFORE != null && ptHour(s.first_shown_at) >= BEFORE) continue;
  (byDay[s.signal_date] = byDay[s.signal_date] || []).push(retToPoints(s.ret_close));
}
const means = Object.values(byDay).map(a => a.reduce((x, y) => x + y, 0) / a.length);
const mean = means.reduce((a, b) => a + b, 0) / means.length;
const sd = Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / (means.length - 1));
console.log(`Outcome spread (signal_log at ${REV}${BEFORE != null ? `, first shown before ${BEFORE}:00 PT` : ''}): ${means.length} days, day-mean ret_close sd ${sd.toFixed(2)} pts, mean ${mean.toFixed(2)}.`);

// The sign split: stored conditions per buy day, first of the day (planning rate, not
// evidence: it mixes sources), unless the replay's split is passed.
const firstByDay = {};
for (const t of rows('trades_v2').slice().sort((a, b) => String(a.buy_time).localeCompare(String(b.buy_time)))) {
  const d = String(t.buy_date).slice(0, 10);
  if (t.macro_condition && !firstByDay[d]) firstByDay[d] = t.macro_condition;
}
const stored = Object.values(firstByDay).map(k => predictedSign(k, c.T));
const frac = s => stored.filter(x => x === s).length / stored.length;
console.log(`Stored first-of-day conditions (trades_v2 at ${REV}): ${stored.length} buy days: + ${stored.filter(x => x > 0).length}, - ${stored.filter(x => x < 0).length}, CHOPPY ${stored.filter(x => x === 0).length}.`);
const pPlus = Number(arg('--plus', frac(1))), pMinus = Number(arg('--minus', frac(-1)));
console.log(`Split used: + ${(100 * pPlus).toFixed(0)}%, - ${(100 * pMinus).toFixed(0)}%, CHOPPY ${(100 * (1 - pPlus - pMinus)).toFixed(0)}%.\n`);

// What the table implies, in the outcome's units. MACRO_ADJUSTMENTS is in score points,
// so it needs a rate: return per score point, within a day (the day's level removed, so
// the market's move doesn't count). Score against return, no condition anywhere.
const scored = rows('signal_log').filter(s => s.engine_source === 'EDGE' && (s.tier === 'SHOWN' || s.tier === 'BELOW_THRESHOLD') && s.ret_close_split_in_window !== true)
  .map(s => { const o = (typeof s.signal_snapshot === 'string' ? JSON.parse(s.signal_snapshot) : s.signal_snapshot) || {}; return { d: s.signal_date, score: o.score, rc: s.ret_close, r1: s.ret_1d, h: ptHour(s.first_shown_at) }; })
  .filter(x => typeof x.score === 'number');
function perScorePoint(list, key) {
  const by = {};
  for (const x of list) if (x[key] != null) (by[x.d] = by[x.d] || []).push(x);
  const slopes = [];
  for (const a of Object.values(by)) {
    if (a.length < 3) continue;
    const ms = a.reduce((p, x) => p + x.score, 0) / a.length, mr = a.reduce((p, x) => p + x[key], 0) / a.length;
    const xy = a.reduce((p, x) => p + (x.score - ms) * retToPoints(x[key] - mr), 0), xx = a.reduce((p, x) => p + (x.score - ms) ** 2, 0);
    if (xx > 0) slopes.push(xy / xx);
  }
  const m = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const se = Math.sqrt(slopes.reduce((a, b) => a + (b - m) ** 2, 0) / (slopes.length - 1) / slopes.length);
  return { m, se, upper: m + 2 * se, days: slopes.length };
}
const others = Object.entries(c.T).filter(([k]) => k !== 'CHOPPY').map(([k, v]) => `${k} ${v.OTHER > 0 ? '+' : ''}${v.OTHER}`);
console.log(`The table (OTHER, score points): ${others.join(', ')}.`);
const onSign = s => { const v = Object.values(firstByDay).filter(k => predictedSign(k, c.T) === s).map(k => c.T[k].OTHER); return v.reduce((a, b) => a + b, 0) / v.length; };
const scoreGap = onSign(1) - onSign(-1), widest = Math.max(...Object.values(c.T).map(v => v.OTHER)) - Math.min(...Object.values(c.T).map(v => v.OTHER));
console.log(`Gap the table puts between + and - days: ${scoreGap.toFixed(1)} score points on the stored labels, ${widest} at its widest.`);
for (const [n, f] of [['all rows', () => true], ['first shown before 10:00 PT', x => x.h < 10]]) for (const [k, lab] of [['rc', 'ret_close'], ['r1', 'ret_1d']]) {
  const s = perScorePoint(scored.filter(f), k);
  console.log(`  ${n}, ${lab}: ${s.m.toFixed(4)} pts per score point (se ${s.se.toFixed(4)}, ${s.days} days): implies ${(s.m * scoreGap).toFixed(2)} pts, at most ${(s.upper * scoreGap).toFixed(2)} (at its widest ${(s.upper * widest).toFixed(2)}).`);
}
console.log('');

// Days until the bar can be met: expected, and the 90th percentile by simulation.
let seed = 12345;
const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const draw = () => { const u = rand(); return u < pPlus ? 1 : u < pPlus + pMinus ? -1 : 0; };
const waits = [];
for (let k = 0; k < 4000; k++) {
  let n = 0, a = 0, b = 0;
  while (n < 400 && !(n >= MIN_DAYS && n - Math.max(a, b, n - a - b) >= MIN_DAYS_AWAY_FROM_COMMON_SIGN)) { const s = draw(); n++; if (s > 0) a++; else if (s < 0) b++; }
  waits.push(n);
}
waits.sort((a, b) => a - b);
console.log(`Trading days until the bar is met (${MIN_DAYS}+ days, ${MIN_DAYS_AWAY_FROM_COMMON_SIGN}+ away from the most common sign): median ${waits[2000]}, 90th percentile ${waits[3600]}.\n`);

// Power: resample real day means, shift by the effect, permute. delta = how much higher
// a +1 day's mean is than a -1 day's, in points. 2,000 worlds, 1,000 shuffles each.
function power(n, delta, worlds = 2000, shuffles = 1000) {
  let passed = 0, run = 0;
  for (let w = 0; w < worlds; w++) {
    const signs = Array.from({ length: n }, draw);
    const a = signs.filter(s => s > 0).length, b = signs.filter(s => s < 0).length;
    if (n - Math.max(a, b, n - a - b) < MIN_DAYS_AWAY_FROM_COMMON_SIGN) continue;
    run++;
    const out = signs.map(s => means[Math.floor(rand() * means.length)] + s * delta / 2);
    const sum = x => x.reduce((a, v, j) => a + v * out[j], 0);
    const obs = sum(signs);
    let geq = 0;
    for (let k = 0; k < shuffles; k++) if (sum(shuffleBlocks(signs, BLOCK_DAYS, rand)) >= obs) geq++;
    if ((geq + 1) / (shuffles + 1) < ALPHA) passed++;
  }
  return run ? { power: passed / run, runnable: run / worlds } : { power: null, runnable: 0 };
}
const NS = [25, 60];
const DELTAS = [0, 0.25, 0.5, 1, 2];
console.log(`Chance of passing, given a true +/- gap (points). delta 0 is the control: must sit near ${ALPHA}.`);
console.log(`  days  ${DELTAS.map(d => `delta ${d}`.padEnd(10)).join('')}bar met by then`);
for (const n of NS) {
  const cells = DELTAS.map(d => power(n, d));
  console.log(`  ${String(n).padEnd(6)}${cells.map(x => (x.power == null ? 'n/a' : `${(100 * x.power).toFixed(0)}%`).padEnd(10)).join('')}${(100 * cells[0].runnable).toFixed(0)}%`);
}
