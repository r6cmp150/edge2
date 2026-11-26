#!/usr/bin/env node
// scripts/measure-forward-test.mjs -- the forward test's measures B (holding) and C (his choice), as DECLARED in STATUS
// (4428ed0, amended 30ef1ac) before any position after the start line was looked at. Measure A is
// scripts/measure-selection-differential.mjs. Read only.
//
//   POPULATION: every position (trades_v2 and portfolio) added after the start line (START_LINE, 2026-11-23T20:42:43Z).
//   QUALIFYING DAYS: trading days on which at least one such position was opened. The test evaluates the first 60.
//     Below 60 it is INTERIM: the count and the figures so far are printed, labelled interim, with NO reading.
//     If 180 trading days after 2026-11-24 pass with fewer than 60, it is NOT ESTABLISHED FOR WANT OF DAYS.
//   B, HOLDING: from each position's ENTRY (the SIP reference at the buy minute), its return to the close of the buy day
//     (+0) and the closes 1, 2 and 5 trading days after the BUY, each minus the benchmark over the identical window.
//     Benchmark: the scanned universe (every ticker that day's scans saved), its mean from the same minute to the same
//     closes; IWM beside it, the weaker proxy, its own column. A position whose +5 close has not happened is PENDING.
//     SPECIFIC decay: the excess against the universe falls +1 > +2 > +5 and all three 95% day-resampled intervals are
//     below zero.
//   C, HIS CHOICE: per position, the stocks SHOWN that day (a scan row at or above v3's watch line, read from
//     core/edge-scoring.js; include_under2 is true, so no price filter) that he did NOT open, over the same windows.
//     Mean difference (opened - not opened) per horizon with its day-resampled interval; and the ratio of the opened
//     positions' standard deviation to the not-opened stocks', per horizon, with its interval. SELECTS FOR MOVEMENT if
//     the ratio's interval lies above 1; ADDS / COSTS RETURN if the mean difference's interval is above / below zero.
//   GROSS AND NET: each mean is also printed net of the spread hurdle (0.291% blended; STATUS).
//   node scripts/measure-forward-test.mjs [--rev <commit>] [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc } from './measure-entry-price-gap.mjs';
import { sipRef } from './lib/sip-ref.mjs';
import { dayInterval } from './measure-change-split.mjs';
import { mean, ret } from './measure-good-days.mjs';
import { priceAt, afterStart, START_LINE } from './measure-selection-differential.mjs';
import { closeAfter, endCapped } from './measure-decay-control.mjs';
import { rng } from './score-vs-return.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const QUALIFYING_DAYS = 60, BACKSTOP_TRADING_DAYS = 180, FIRST_QUALIFYING = '2026-11-24', HORIZONS = [0, 1, 2, 5], HURDLE = 0.291;

// v3's watch line, from the scorer's own table (so a changed table is seen here)
export function watchLine(src = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8')) {
  const m = src.match(/^\s*3:\s*\{\s*watch:\s*(\d+)/m);
  if (!m) throw new Error('core/edge-scoring.js: no version-3 watch line');
  return Number(m[1]);
}
// the state of the test from the qualifying days seen and the trading days elapsed since the first
export function testState(qualifyingDays, tradingDaysElapsed) {
  if (qualifyingDays >= QUALIFYING_DAYS) return 'EVALUATE';
  if (tradingDaysElapsed > BACKSTOP_TRADING_DAYS) return 'NOT ESTABLISHED FOR WANT OF DAYS';
  return 'INTERIM';
}
// the qualifying days, in order, and the positions on the first 60 of them
export function qualifying(positions) {
  const days = [...new Set(positions.map(p => String(p.buy_date).slice(0, 10)))].sort();
  const inTest = new Set(days.slice(0, QUALIFYING_DAYS));
  return { days, positions: positions.filter(p => inTest.has(String(p.buy_date).slice(0, 10))) };
}
export const sd = xs => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
// the SD ratio's interval: resample whole days; each resample's ratio of the opened SD to the not-opened SD
export function sdRatioInterval(rows, { resamples = 10000, seed = 20261125 } = {}) {
  const days = [...new Set(rows.map(r => r.day))], rand = rng(seed), out = [];
  for (let k = 0; k < resamples; k++) {
    const pick = Array.from({ length: days.length }, () => days[Math.floor(rand() * days.length)]).flatMap(d => rows.filter(r => r.day === d));
    const a = sd(pick.map(r => r.opened)), b = sd(pick.flatMap(r => r.notOpened));
    if (a != null && b) out.push(a / b);
  }
  out.sort((x, y) => x - y);
  return { lo: out[Math.floor(0.025 * out.length)], hi: out[Math.ceil(0.975 * out.length) - 1] };
}
export function readingB(intervals, means) {
  return means[1] > means[2] && means[2] > means[5] && [1, 2, 5].every(n => intervals[n].hi < 0) ? 'SPECIFIC' : 'NOT SPECIFIC';
}
export function readingC(meanIv, ratioIv) {
  return { movement: ratioIv.lo > 1 ? 'SELECTS FOR MOVEMENT' : 'NOT SHOWN TO SELECT FOR MOVEMENT', ret: meanIv.lo > 0 ? 'ADDS RETURN' : meanIv.hi < 0 ? 'COSTS RETURN' : 'NO RETURN DIFFERENCE SHOWN' };
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const rev = arg('--rev') || execSync('git log -1 --format=%h -- data/backups/trades_v2.json', { cwd: ROOT }).toString().trim();
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const all = [...show('trades_v2.json').filter(r => r.sell_price_unverified === false), ...show('portfolio.json')].filter(afterStart);
  const q = qualifying(all);
  const today = new Date().toISOString().slice(0, 10);
  const tradingElapsed = (await fetchBars(headers, ['SPY'], { timeframe: '1Day', start: `${FIRST_QUALIFYING}T00:00:00Z`, end: endCapped(Date.now()), feed: 'sip' })).SPY?.length ?? 0;
  const state = testState(q.days.length, tradingElapsed);
  console.log(`THE FORWARD TEST @ ${rev}, from the start line ${START_LINE}: ${q.days.length} of ${QUALIFYING_DAYS} QUALIFYING DAYS (${tradingElapsed} trading days since ${FIRST_QUALIFYING}; backstop ${BACKSTOP_TRADING_DAYS}). STATE: ${state}.`);
  if (state !== 'EVALUATE') console.log(state === 'INTERIM' ? 'INTERIM: figures below are progress, NOT a reading; no interval is compared with any bar.' : 'NOT ESTABLISHED FOR WANT OF DAYS: the declared horizon was not reached within the backstop. A third outcome, not a null.');
  const files = execSync(`git ls-tree --name-only ${rev} data/backups/rating_snapshots/`, { cwd: ROOT }).toString().trim().split('\n');
  const scans = files.flatMap(f => show(f.replace('data/backups/', '')));
  const ptDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const W = watchLine(), scanned = new Map(), shown = new Map();
  for (const r of scans) { const d = ptDate(r.captured_at); (scanned.get(d) || scanned.set(d, new Set()).get(d)).add(r.ticker); if (r.score >= W) (shown.get(d) || shown.set(d, new Set()).get(d)).add(r.ticker); }
  const rowsB = [], rowsC = [], pending = [];
  for (const day of [...new Set(q.positions.map(p => String(p.buy_date).slice(0, 10)))]) {
    const ps = q.positions.filter(p => String(p.buy_date).slice(0, 10) === day);
    const uni = [...(scanned.get(day) || [])], opened = new Set(ps.map(p => p.ticker)), notOpened = [...(shown.get(day) || [])].filter(t => !opened.has(t));
    const syms = [...new Set([...uni, ...notOpened, ...opened, 'IWM'])];
    const daily = await fetchBars(headers, syms, { timeframe: '1Day', start: `${day}T00:00:00Z`, end: endCapped(Date.parse(day) + 14 * 864e5), feed: 'sip', adjustment: 'all' });
    for (const p of ps) {
      const ms = pacificMinuteUtc(day, p.buy_time), e = await sipRef(headers, p.ticker, ms), ie = await sipRef(headers, 'IWM', ms);
      const closes = s => HORIZONS.map(n => closeAfter(daily[s], day, n));
      const pc = closes(p.ticker), ic = closes('IWM');
      if (!e || !ie || pc.some(v => v == null) || ic.some(v => v == null)) { pending.push(`${p.ticker} ${day}`); continue; }
      const minute = await fetchBars(headers, syms, { timeframe: '1Min', start: new Date(ms - 15 * 60000).toISOString(), end: new Date(ms).toISOString(), feed: 'sip' });
      const series = s => { const e0 = priceAt(minute[s], ms), c = closes(s); return e0 && c.every(v => v != null) ? HORIZONS.map((n, i) => ret(e0, c[i])) : null; };
      const u = uni.map(series).filter(Boolean), no = notOpened.map(series).filter(Boolean);
      const own = HORIZONS.map((n, i) => ret(e.price, pc[i])), iwm = HORIZONS.map((n, i) => ret(ie.price, ic[i]));
      HORIZONS.forEach((n, i) => {
        if (u.length) rowsB.push({ day, n, diff: own[i] - mean(u.map(x => x[i])), iwm: own[i] - iwm[i] });
        if (no.length) rowsC.push({ day, n, diff: own[i] - mean(no.map(x => x[i])), opened: own[i], notOpened: no.map(x => x[i]) });
      });
    }
  }
  const fmt = x => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  console.log(`MEASURED: ${new Set(rowsB.map(r => r.day + r.n)).size ? rowsB.filter(r => r.n === 0).length : 0} positions with every horizon closed; PENDING (+5 not yet closed, or unpriced): ${pending.length}.`);
  const ivB = {}, mB = {};
  for (const n of HORIZONS) {
    const rs = rowsB.filter(r => r.n === n); if (!rs.length) continue;
    ivB[n] = dayInterval(rs); mB[n] = mean(rs.map(r => r.diff));
    console.log(`  B +${n}: excess against the universe ${fmt(mB[n])} (${fmt(ivB[n].lo)} to ${fmt(ivB[n].hi)}), net of the hurdle ${fmt(mB[n] - HURDLE)}; against IWM (the weaker proxy) ${fmt(mean(rs.map(r => r.iwm)))}`);
  }
  for (const n of HORIZONS) {
    const rs = rowsC.filter(r => r.n === n); if (!rs.length) continue;
    const iv = dayInterval(rs), ratio = sd(rs.map(r => r.opened)) / sd(rs.flatMap(r => r.notOpened)), riv = sdRatioInterval(rs);
    console.log(`  C +${n}: opened minus shown-not-opened ${fmt(mean(rs.map(r => r.diff)))} (${fmt(iv.lo)} to ${fmt(iv.hi)}); SD ratio ${ratio.toFixed(2)} (${riv.lo?.toFixed(2)} to ${riv.hi?.toFixed(2)})${state === 'EVALUATE' ? ` -> ${Object.values(readingC(iv, riv)).join(', ')}` : ''}`);
  }
  if (state === 'EVALUATE' && [1, 2, 5].every(n => ivB[n])) console.log(`B READING (declared): ${readingB(ivB, mB)}.`);
  console.log(`\n${q.days.length} of ${QUALIFYING_DAYS} QUALIFYING DAYS. STATE: ${state}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
