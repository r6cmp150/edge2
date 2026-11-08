#!/usr/bin/env node
// scripts/prereg-pnl.mjs -- is Roman's trading, as practised, profitable? Read-only. (2026-11-08)
//
// PRE-REGISTERED. The design was fixed in CC-PREREG-pnl-question.md and its amendment 1, both
// written 2026-11-08 before any P&L was read, and this script was written and committed to
// them before it was first run. Nothing below may be changed after seeing its output without
// saying so in the commit that changes it.
//
// THE CALLS (amendment 1):
//   - Primary outcome: mean realized P&L per BUY DAY (the batch of decisions made together),
//     whole book, the trades Roman's Sold tab counts: sell_price_unverified false.
//   - Direction > 0. Bar: the lower bound of a moving-block bootstrap over buy days in date
//     order, blocks of 3, above zero. Interval level: 95% two-sided percentile (2.5th / 97.5th).
//     The pre-registration did not state a level; 95% two-sided was fixed here, before the run.
//     10,000 resamples, seed 20261108.
//   - A verdict needs at least 20 buy days (the spec's floor for the macro test). No sub-period
//     reaches it, so every sub-period is DESCRIPTIVE ONLY: no interval, no verdict.
//   - Null clause, in the pre-registration's words: if the interval includes zero, "we cannot
//     distinguish the current method from break-even or worse, and -$300 stands as the best
//     available estimate of what it produces."
//   - The whole book mixes several methods: the verdict is about Roman's trading as practised,
//     not about any version of the app's advice. And these splits are changes to the app's
//     ADVICE; nothing records whether Roman followed it.
//   - Sub-periods: by buy date at the dated advice changes (A to 09-14; B 09-15 loss floor;
//     C 10-21 gate; D 10-22 scoring v2; E 11-01 gate on stale scans), and by the recorded
//     code_version.scoring in three states: recorded v2, recorded v1, unrecorded (treated as v1
//     by the code's own rule). Scoring v2 carries: "this split was chosen after its figures had
//     been seen; it is not a test, and no interval here is a confidence statement."
//   - The app-signal split is NOT reported: trades_v2.source is the SALE form's "Why did you
//     sell?", defaulted to "App Signal", and reads "App Signal" on 608 of 608; no buy is linked
//     to a signal (signal_log_id set on 0). The stop rule applies.
//
// DECIDED HERE, BEFORE THE RUN, NOT IN THE PRE-REGISTRATION: one sensitivity line removes the
// known-contaminated subsets named in scripts/rederive-hold-length-finding.mjs (the 9 duplicate
// pairs, the dead-stock trades, NEOG 2026-08-19). It is printed beside the primary, never
// instead of it, and carries no verdict.
//
// Three states for every trade: WIN (pnl_dollars > 0), LOSS (< 0), BREAK-EVEN (= 0), and
// UNKNOWN (no pnl_dollars), never folded into another. Unverified trades are their own tier.
//
// Source: data/backups/trades_v2.json at a pinned commit, so every figure is re-derivable.
//   node scripts/prereg-pnl.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DESIGN = {
  minDaysForVerdict: 20, blockLength: 3, resamples: 10000, seed: 20261108, lowerPct: 2.5, upperPct: 97.5,
  periods: [
    ['A  buy <= 09-14', '0000-00-00', '2026-09-14'],
    ['B  09-15..10-20 (loss floor)', '2026-09-15', '2026-10-20'],
    ['C  10-21 (gate)', '2026-10-21', '2026-10-21'],
    ['D  10-22..10-31 (scoring v2 deployed)', '2026-10-22', '2026-10-31'],
    ['E  >= 11-01 (gate: stale scans)', '2026-11-01', '9999-99-99'],
  ],
};
const V2_SENTENCE = 'this split was chosen after its figures had been seen; it is not a test, and no interval here is a confidence statement.';

const day = v => (v == null ? null : String(v).slice(0, 10));
const num = v => (v == null || v === '' ? null : Number(v));
export const outcome = r => { const p = num(r.pnl_dollars); return p == null || !Number.isFinite(p) ? 'UNKNOWN' : p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'BE'; };

// A deterministic generator, so the interval is reproducible.
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Moving-block bootstrap of the mean over a series in date order.
export function blockBootstrapMean(series, { blockLength, resamples, seed, lowerPct, upperPct }) {
  const n = series.length;
  if (n < blockLength) return null;
  const rand = rng(seed), means = [];
  const starts = n - blockLength + 1;
  for (let b = 0; b < resamples; b++) {
    let sum = 0, k = 0;
    while (k < n) {
      const s = Math.floor(rand() * starts);
      for (let j = 0; j < blockLength && k < n; j++, k++) sum += series[s + j];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const q = p => means[Math.min(means.length - 1, Math.max(0, Math.floor((p / 100) * means.length)))];
  return { lower: q(lowerPct), upper: q(upperPct) };
}

export function perDay(rows) {
  const m = new Map();
  for (const r of rows) { const d = day(r.buy_date); m.set(d, (m.get(d) || 0) + num(r.pnl_dollars)); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function asymmetry(rows) {
  const p = rows.map(r => num(r.pnl_dollars));
  const wins = p.filter(x => x > 0).sort((a, b) => b - a), losses = p.filter(x => x < 0).sort((a, b) => a - b);
  const sum = a => a.reduce((s, x) => s + x, 0);
  const q = (a, f) => (a.length ? a[Math.floor(f * (a.length - 1))] : null);
  const avgW = wins.length ? sum(wins) / wins.length : null, avgL = losses.length ? sum(losses) / losses.length : null;
  return {
    n: p.length, wins: wins.length, losses: losses.length, be: p.filter(x => x === 0).length,
    total: sum(p), avgWin: avgW, avgLoss: avgL, ratio: avgW != null && avgL ? avgW / Math.abs(avgL) : null,
    winQuartiles: [...wins].sort((a, b) => a - b).length ? [0.25, 0.5, 0.75].map(f => q([...wins].sort((a, b) => a - b), f)) : null,
    lossQuartiles: losses.length ? [0.25, 0.5, 0.75].map(f => q([...losses].sort((a, b) => b - a), f)) : null,
    top5LossShare: losses.length ? sum(losses.slice(0, 5)) / sum(losses) : null,
    top5WinShare: wins.length ? sum(wins.slice(0, 5)) / sum(wins) : null,
    top5Losses: losses.slice(0, 5), top5Wins: wins.slice(0, 5),
  };
}

const $ = x => (x == null ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const pc = x => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function describe(label, rows, note = '') {
  const a = asymmetry(rows), days = perDay(rows);
  const pcts = rows.map(r => num(r.pnl_pct)).filter(x => x != null && Number.isFinite(x));
  console.log(`  ${label.padEnd(40)} trades ${String(rows.length).padStart(3)}  buy days ${String(days.length).padStart(2)}  W/L/BE ${a.wins}/${a.losses}/${a.be}  win ${a.n ? pc(a.wins / a.n) : '—'}  avgW ${$(a.avgWin)}  avgL ${$(a.avgLoss)}  ratio ${a.ratio == null ? '—' : a.ratio.toFixed(2)}  total ${$(a.total)}  per day ${days.length ? $(a.total / days.length) : '—'}  per trade ${a.n ? $(a.total / a.n) : '—'}  pct mean ${pcts.length ? (pcts.reduce((s, x) => s + x, 0) / pcts.length).toFixed(2) + '%' : '—'} median ${pcts.length ? median(pcts).toFixed(2) + '%' : '—'}${note ? `\n      ${note}` : ''}`);
}

async function main() {
  const revArg = process.argv.indexOf('--rev');
  const REV = revArg > 0 ? process.argv[revArg + 1] : '314f6e0';
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  console.log(`SOURCE: data/backups/trades_v2.json @ ${REV}: ${all.length} rows (sells ${all.map(r => day(r.sell_date)).sort()[0]} to ${all.map(r => day(r.sell_date)).sort().at(-1)})`);
  console.log('CAVEAT, first: the splits below are changes to the app\'s ADVICE; nothing records whether Roman followed it.');

  const verified = all.filter(r => r.sell_price_unverified === false);
  const unverified = all.filter(r => r.sell_price_unverified === true);
  const flagUnknown = all.filter(r => r.sell_price_unverified !== true && r.sell_price_unverified !== false);
  const outcomeUnknown = verified.filter(r => outcome(r) === 'UNKNOWN');
  const book = verified.filter(r => outcome(r) !== 'UNKNOWN');
  // Positive control: the Sold tab's own figures (586 trades, 326W / 256L / 4BE, -$300).
  const a0 = asymmetry(book);
  console.log(`CONTROL against Roman's Sold tab (586, 326W/256L/4BE, about -$300): verified ${verified.length}, W/L/BE ${a0.wins}/${a0.losses}/${a0.be}, total ${$(a0.total)}; verified with no pnl (UNKNOWN) ${outcomeUnknown.length}; flag neither true nor false ${flagUnknown.length}`);

  // 1. EXCLUSIONS
  console.log('\n1. EXCLUSIONS: verified / unverified / unknown');
  console.log(`  verified ${verified.length}, unverified ${unverified.length}, flag unknown ${flagUnknown.length}`);
  console.log(`  unverified buy dates: ${[...new Set(unverified.map(r => day(r.buy_date)))].sort().join(', ')}`);
  const uvDays = new Set(unverified.map(r => day(r.buy_date)));
  describe('unverified (recorded P&L, NOT verified)', unverified.filter(r => outcome(r) !== 'UNKNOWN'), 'their recorded sell price is unverified, so these figures are what was recorded, not what happened');
  describe('verified trades on the same buy days', book.filter(r => uvDays.has(day(r.buy_date))), 'the like-for-like comparison: same days, so the period does not explain a difference');
  describe('book incl. unverified as recorded', all.filter(r => outcome(r) !== 'UNKNOWN'), 'sensitivity only: what the totals would be if the recorded unverified figures were right');

  // 2. ASYMMETRY
  console.log('\n2. ASYMMETRY (whole verified book)');
  console.log(`  avg win ${$(a0.avgWin)}, avg loss ${$(a0.avgLoss)}, ratio ${a0.ratio?.toFixed(3)}`);
  console.log(`  wins  quartiles (25/50/75): ${a0.winQuartiles?.map($).join(' / ')}`);
  console.log(`  losses quartiles (25/50/75, by size): ${a0.lossQuartiles?.map($).join(' / ')}`);
  console.log(`  largest 5 losses: ${a0.top5Losses.map($).join(', ')} = ${pc(a0.top5LossShare)} of all loss dollars`);
  console.log(`  largest 5 wins:   ${a0.top5Wins.map($).join(', ')} = ${pc(a0.top5WinShare)} of all win dollars`);

  // 3. PRIMARY
  console.log('\n3. PRIMARY OUTCOME: mean realized P&L per buy day, whole verified book');
  const days = perDay(book), series = days.map(([, v]) => v);
  const mean = series.reduce((s, x) => s + x, 0) / series.length;
  const ci = series.length >= DESIGN.minDaysForVerdict ? blockBootstrapMean(series, DESIGN) : null;
  console.log(`  buy days ${series.length}, trades ${book.length}; mean per buy day ${$(mean)}; per trade ${$(a0.total / book.length)}`);
  if (!ci) console.log(`  fewer than ${DESIGN.minDaysForVerdict} buy days: no interval, no verdict`);
  else {
    console.log(`  95% moving-block bootstrap (blocks of ${DESIGN.blockLength}, ${DESIGN.resamples} resamples, seed ${DESIGN.seed}): ${$(ci.lower)} to ${$(ci.upper)}`);
    console.log(ci.lower > 0
      ? '  VERDICT: the lower bound is above zero. Roman\'s trading as practised has positive expected value per buy day, bounded by the largest-contributor test below.'
      : '  VERDICT (null, in the pre-registration\'s words): we cannot distinguish the current method from break-even or worse, and -$300 stands as the best available estimate of what it produces. It is not "promising but needs more data", and it is not a reason to keep the method on the grounds that the sample is small.');
  }
  console.log('  sub-periods, DESCRIPTIVE ONLY (no interval, no verdict: none reaches 20 buy days):');
  for (const [label, a, b] of DESIGN.periods) describe(label, book.filter(r => day(r.buy_date) >= a && day(r.buy_date) <= b));
  const sv = r => r.code_version?.scoring;
  describe('scoring: recorded v2', book.filter(r => sv(r) === 2), `v2: ${V2_SENTENCE}`);
  describe('scoring: recorded v1', book.filter(r => sv(r) === 1));
  describe('scoring: unrecorded (treated as v1)', book.filter(r => sv(r) == null));

  // Sensitivity decided before the run: known-contaminated subsets removed.
  const cnt = {}; const keyOf = r => `${r.ticker}|${day(r.buy_date)}`;
  for (const r of all) cnt[keyOf(r)] = (cnt[keyOf(r)] || 0) + 1;
  const PAIR = new Set(['GPGI', 'HTZ', 'VISN', 'RR', 'TDAY', 'GO', 'CXM', 'SOUN', 'SNXX']);
  const DEAD = { AREN: 3, TWO: 3, HLX: 3, GBTG: 2, BRR: 2, ATAI: 1, CCRN: 1, DOMO: 1, LC: 1 };
  const contaminated = r => (PAIR.has(r.ticker) && cnt[keyOf(r)] >= 2) || (r.ticker in DEAD && Number(r.buy_price) === Number(r.sell_price)) || (r.ticker === 'NEOG' && day(r.buy_date) === '2026-08-19');
  const clean = book.filter(r => !contaminated(r));
  const cs = perDay(clean).map(([, v]) => v);
  console.log(`  SENSITIVITY (decided before the run; no verdict): known-contaminated rows removed (${book.length - clean.length}): mean per buy day ${$(cs.reduce((s, x) => s + x, 0) / cs.length)} over ${cs.length} days; total ${$(clean.reduce((s, r) => s + num(r.pnl_dollars), 0))}`);

  // 4. LARGEST CONTRIBUTOR
  console.log('\n4. LARGEST-CONTRIBUTOR TEST');
  if (!ci || !(ci.lower > 0)) console.log('  not applicable: no period cleared the bar.');
  else {
    const best = days.reduce((m, d) => (d[1] > m[1] ? d : m)), bestTrade = book.reduce((m, r) => (num(r.pnl_dollars) > num(m.pnl_dollars) ? r : m));
    const noDay = series.filter((_, i) => days[i][0] !== best[0]);
    console.log(`  without the best buy day (${best[0]}, ${$(best[1])}): mean per day ${$(noDay.reduce((s, x) => s + x, 0) / noDay.length)}`);
    console.log(`  without the best trade (${bestTrade.ticker} ${day(bestTrade.buy_date)}, ${$(num(bestTrade.pnl_dollars))}): total ${$(a0.total - num(bestTrade.pnl_dollars))}`);
  }

  // 5. DOLLARS AND PERCENT: in every describe() line above (pct mean / median per trade).
  console.log('\n5. DOLLARS AND PERCENT: each line above carries per-trade mean and median pnl_pct beside the dollars.');

  // 6. HOLD LENGTH (the app's holdSpan, closes as shown: 0 = same day)
  console.log('\n6. HOLD LENGTH: core/clock.js holdSpan, closes held (0 = same day), whole verified book');
  const ctx = { console, Date, Math, Intl, Number, String, Set, Map, Array, Object, JSON, isNaN };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'core/clock.js'), 'utf8') + '\n;globalThis.__holdSpan = holdSpan;', ctx);
  const holdSpan = ctx.__holdSpan;
  const buckets = {};
  for (const r of book) {
    const h = holdSpan({ filledAt: r.filled_at ?? null, buyDate: day(r.buy_date), orderType: r.order_type ?? null }, day(r.sell_date));
    const k = `${h.closes == null ? 'no hold' : h.closes === 0 ? 'same day' : h.closes === 1 ? '1 close' : '2+ closes'} | ${h.basis}`;
    (buckets[k] = buckets[k] || []).push(r);
  }
  for (const k of Object.keys(buckets).sort()) describe(k, buckets[k]);
  const all3 = { 'same day': [], '1 close': [], '2+ closes': [] };
  for (const r of book) { const c = holdSpan({ filledAt: r.filled_at ?? null, buyDate: day(r.buy_date), orderType: r.order_type ?? null }, day(r.sell_date)).closes; if (c != null) all3[c === 0 ? 'same day' : c === 1 ? '1 close' : '2+ closes'].push(r); }
  console.log('  all bases together (the basis mix is shown above; the earlier finding was same-day 71.0% of 107 vs 2+ closes 32.2% of 59, on a subset):');
  for (const k of Object.keys(all3)) describe(k, all3[k]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
