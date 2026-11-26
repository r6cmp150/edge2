#!/usr/bin/env node
// scripts/measure-forward-test.mjs -- the forward test, as DECLARED in STATUS (4428ed0, amended 30ef1ac; the futility
// look added 2026-11-25, at 2 qualifying days, before any reading existed). It decides the test's STATE. Measure A's
// per-day display is scripts/measure-selection-differential.mjs; its rows are computed here by the same function.
// Read only.
//
//   POPULATION: every position (verified trades_v2 and portfolio) added after the start line (START_LINE,
//     2026-11-23T20:42:43Z), the 13 that landed before the amendment INCLUDED (STATUS records why). No subset.
//   QUALIFYING DAYS: trading days with at least one such position opened. The first 60 are the test.
//   STATE (scripts/lib/forward-declaration.mjs): INTERIM below 60 (progress only, no interval compared with any bar);
//     EVALUATE at 60; NOT ESTABLISHED FOR WANT OF DAYS past 180 trading days from 2026-11-24; FUTILE if the one
//     futility look returns it.
//   THE FUTILITY LOOK: one, on the positions of the first 30 qualifying days, taken at the first run on which all of
//     them have every horizon closed (A: sold; B: the +5 close has happened). FUTILE if A and B +0 both have a point
//     estimate at or below zero and an interval upper end below the 0.291% hurdle; otherwise CONTINUE. It can only stop
//     the test: it never prints a positive, never extends, never changes the bar. Not printed at any other set.
//   A, PICKING: each closed position, buy minute to sell minute, minus that day's scanned universe over the same window.
//   B, HOLDING: from each ENTRY (the SIP reference at the buy minute), to the buy day's close (+0) and the closes 1, 2
//     and 5 trading days after the BUY, minus the scanned universe's mean over the identical window; IWM beside it as
//     the weaker proxy, its own column.
//   C, HIS CHOICE: the stocks SHOWN that day (a scan row at or above v3's watch line, read from core/edge-scoring.js;
//     include_under2 is true, so no price filter) that he did not open, over B's windows from HIS entry minute (the same
//     clock on both sides). DECLARED 2026-11-25 ON WHAT THE FIELD HOLDS: appShowedAtBuy records only the tapped stock's
//     own verdict (state, gate, DAY suppression, score, label, score source), not the list on screen, and signal_log
//     is written by the scheduled logger, not from his screen. So "shown" stays the watch line, and C compares his picks
//     against everything that passed it: "saw it and skipped it" mixed with "never scrolled that far".
//   READINGS, only at EVALUATE: A PICKING SHOWN if its interval lies above zero; B SPECIFIC if the excess falls
//     +1 > +2 > +5 with all three intervals below zero; C SELECTS FOR MOVEMENT if the SD ratio's interval lies above 1,
//     ADDS / COSTS RETURN if the mean difference's interval lies above / below zero. Gross and net of the hurdle.
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
import { priceAt, afterStart, START_LINE, differentialRows, makeBarsNear } from './measure-selection-differential.mjs';
import { closeAfter, endCapped } from './measure-decay-control.mjs';
import { rng } from './score-vs-return.mjs';
import { QUALIFYING_DAYS, FUTILITY_AT, BACKSTOP_TRADING_DAYS, FIRST_QUALIFYING, HURDLE, qualifying, futility, lookState, testState } from './lib/forward-declaration.mjs';

export { QUALIFYING_DAYS, FUTILITY_AT, BACKSTOP_TRADING_DAYS, FIRST_QUALIFYING, HURDLE, qualifying, futility, lookState, testState };
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HORIZONS = [0, 1, 2, 5];

// v3's watch line, from the scorer's own table (so a changed table is seen here)
export function watchLine(src = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8')) {
  const m = src.match(/^\s*3:\s*\{\s*watch:\s*(\d+)/m);
  if (!m) throw new Error('core/edge-scoring.js: no version-3 watch line');
  return Number(m[1]);
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
// C's "shown" has no price filter only while include_under2 is true; otherwise C is not computed (no per-day filter is
// built), never run on the wrong set
export function cComputable(settingsRows) {
  const v = (settingsRows || [])[0]?.include_under2;
  return v === true ? { ok: true } : { ok: false, why: `include_under2 is ${JSON.stringify(v)} in the settings backup, not true; "shown" would need a price filter that is not built or declared.` };
}
export const readingA = iv => (iv.lo > 0 ? 'PICKING SHOWN' : 'PICKING NOT SHOWN');
export function readingB(intervals, means) {
  return means[1] > means[2] && means[2] > means[5] && [1, 2, 5].every(n => intervals[n].hi < 0) ? 'SPECIFIC' : 'NOT SPECIFIC';
}
export function readingC(meanIv, ratioIv) {
  return { movement: ratioIv.lo > 1 ? 'SELECTS FOR MOVEMENT' : 'NOT SHOWN TO SELECT FOR MOVEMENT', ret: meanIv.lo > 0 ? 'ADDS RETURN' : meanIv.hi < 0 ? 'COSTS RETURN' : 'NO RETURN DIFFERENCE SHOWN' };
}
// THE PEAK-BIAS WATCH (the reviewer, 2026-11-27): the understated-peak defect can only act on measure A once a position
// runs up to 1.20x its buy price (momentum protection switches on at peakPrice >= buyPrice * 1.20, app.js; until then
// the trailing stop cannot run). It never did in 908 pre-start sales. So every run reports whether any forward-test
// position's intraday high, after its entry, has reached RUN_UP x its tape entry. Highs: the buy day's minute bars
// after the entry minute, then each later day's daily high through the sale day (the whole sale day, so a high after
// the sale can raise a flag: it errs toward flagging, never toward missing one).
export const RUN_UP = 1.2;
export function runUp(entry, highs, mult = RUN_UP) {
  const hs = highs.filter(h => typeof h === 'number' && h > 0);
  const max = hs.length ? Math.max(...hs) : null;
  return { reached: !!entry && max != null && max >= entry * mult, max, pct: entry && max != null ? (max / entry - 1) * 100 : null };
}
export function watchLines(flags) {
  const hit = flags.filter(f => f.reached);
  if (!hit.length) return [`PEAK-BIAS WATCH (intraday high >= ${RUN_UP.toFixed(2)}x entry): no forward-test position has reached it (${flags.length} checked). The understated-peak route to measure A has not been live.`];
  return hit.map(f => `::warning::PEAK-BIAS WATCH: ${f.ticker} bought ${f.day} reached +${f.pct.toFixed(1)}% intraday (high ${f.max} vs entry ${f.entry}). The understated-peak route to measure A is now LIVE for this position: take it to the reviewer.`);
}

// is the look's fixed set complete? every position sold (A) and with its +5 close happened (B). A position whose data
// is missing for good (UNPRICED) is named and does not hold the look up forever; one still OPEN or PENDING does.
export function lookSetComplete(lookIds, status) {
  return lookIds.every(id => status.get(id) === 'DONE' || status.get(id) === 'UNPRICED');
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const rev = arg('--rev') || execSync('git log -1 --format=%h -- data/backups/trades_v2.json', { cwd: ROOT }).toString().trim();
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const closedAll = show('trades_v2.json').filter(r => r.sell_price_unverified === false).filter(afterStart);
  const openAll = show('portfolio.json').filter(afterStart);
  const q = qualifying([...closedAll, ...openAll]), lookSet = qualifying([...closedAll, ...openAll], FUTILITY_AT).positions;
  const spy = ((await fetchBars(headers, ['SPY'], { timeframe: '1Day', start: `${FIRST_QUALIFYING}T00:00:00Z`, end: endCapped(Date.now()), feed: 'sip' })).SPY || []).map(b => String(b.t).slice(0, 10));
  const tradingAfter = day => spy.filter(d => d > day).length;
  const files = execSync(`git ls-tree --name-only ${rev} data/backups/rating_snapshots/`, { cwd: ROOT }).toString().trim().split('\n');
  const scans = files.flatMap(f => show(f.replace('data/backups/', '')));
  const ptDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const W = watchLine(), uni = new Map(), shown = new Map();
  for (const r of scans) { const d = ptDate(r.captured_at); (uni.get(d) || uni.set(d, { t: new Set(), min: Infinity }).get(d)).t.add(r.ticker); uni.get(d).min = Math.min(uni.get(d).min, r.score); if (r.score >= W) (shown.get(d) || shown.set(d, new Set()).get(d)).add(r.ticker); }
  const fmt = x => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);

  // B and C, per position, with its status
  const status = new Map(), rowsB = [], rowsC = [], unpriced = [];
  for (const day of [...new Set(q.positions.map(p => String(p.buy_date).slice(0, 10)))]) {
    const ps = q.positions.filter(p => String(p.buy_date).slice(0, 10) === day);
    const scanned = [...(uni.get(day)?.t || [])], opened = new Set(ps.map(p => p.ticker)), notOpened = [...(shown.get(day) || [])].filter(t => !opened.has(t));
    const syms = [...new Set([...scanned, ...notOpened, ...opened, 'IWM'])];
    const daily = await fetchBars(headers, syms, { timeframe: '1Day', start: `${day}T00:00:00Z`, end: endCapped(Date.parse(day) + 14 * 864e5), feed: 'sip', adjustment: 'all' });
    for (const p of ps) {
      const isOpen = openAll.includes(p);
      if (tradingAfter(day) < 5) { status.set(p, 'PENDING'); continue; }
      const ms = pacificMinuteUtc(day, p.buy_time), e = await sipRef(headers, p.ticker, ms), ie = await sipRef(headers, 'IWM', ms);
      const closes = s => HORIZONS.map(n => closeAfter(daily[s], day, n));
      const pc = closes(p.ticker), ic = closes('IWM');
      if (!e || !ie || pc.some(v => v == null) || ic.some(v => v == null)) { status.set(p, 'UNPRICED'); unpriced.push(`${p.ticker} ${day}`); continue; }
      status.set(p, isOpen ? 'OPEN' : 'DONE');
      const minute = await fetchBars(headers, syms, { timeframe: '1Min', start: new Date(ms - 15 * 60000).toISOString(), end: new Date(ms).toISOString(), feed: 'sip' });
      const series = s => { const e0 = priceAt(minute[s], ms), c = closes(s); return e0 && c.every(v => v != null) ? HORIZONS.map((n, i) => ret(e0, c[i])) : null; };
      const u = scanned.map(series).filter(Boolean), no = notOpened.map(series).filter(Boolean);
      const own = HORIZONS.map((n, i) => ret(e.price, pc[i])), iwm = HORIZONS.map((n, i) => ret(ie.price, ic[i]));
      HORIZONS.forEach((n, i) => {
        if (u.length) rowsB.push({ id: p, day, n, diff: own[i] - mean(u.map(x => x[i])), iwm: own[i] - iwm[i] });
        if (no.length) rowsC.push({ id: p, day, n, diff: own[i] - mean(no.map(x => x[i])), opened: own[i], notOpened: no.map(x => x[i]) });
      });
    }
  }
  // THE PEAK-BIAS WATCH, on every position in the test, open or closed, pending or not
  const flags = [];
  for (const p of q.positions) {
    const day = String(p.buy_date).slice(0, 10), ms = pacificMinuteUtc(day, p.buy_time), e = await sipRef(headers, p.ticker, ms);
    if (!e) { flags.push({ ticker: p.ticker, day, reached: false, unpriced: true }); continue; }
    const sold = closedAll.includes(p) ? String(p.sell_date).slice(0, 10) : null;
    const dayEnd = Date.parse(`${day}T21:00:00Z`) + 3 * 3600000; // through the buy day's after-hours, in UTC
    const mins = (await fetchBars(headers, [p.ticker], { timeframe: '1Min', start: new Date(ms).toISOString(), end: endCapped(dayEnd), feed: 'sip' }))[p.ticker] || [];
    const later = Date.parse(day) + 864e5 <= Date.now() - 20 * 60000 ? (await fetchBars(headers, [p.ticker], { timeframe: '1Day', start: new Date(Date.parse(day) + 864e5).toISOString(), end: endCapped(sold ? Date.parse(sold) + 864e5 : Date.now()), feed: 'sip', adjustment: 'all' }))[p.ticker] || [] : [];
    flags.push({ ticker: p.ticker, day, entry: e.price, ...runUp(e.price, [...mins.map(b => b.h), ...later.map(b => b.h)]) });
  }
  // A, by the differential's own function
  const fullDays = new Set([...uni].filter(([, u]) => u.min === 0).map(([d]) => d));
  const closedIn = q.positions.filter(p => closedAll.includes(p));
  const { rows: rowsA, notFull } = await differentialRows({ headers, closed: closedIn, uni, fullDays, barsNear: makeBarsNear(headers) });

  // the one futility look, on its fixed set only
  const lookIds = lookSet, lookPids = new Set(lookSet.map(p => p.position_id));
  const ls = lookState(q.days.length, lookSetComplete(lookIds, status));
  let look = null;
  if (ls === 'TAKE') {
    const inLook = new Set(lookIds), aRows = rowsA.filter(r => lookPids.has(r.position_id)), bRows = rowsB.filter(r => r.n === 0 && inLook.has(r.id));
    const a = { mean: mean(aRows.map(r => r.diff)), hi: dayInterval(aRows).hi }, b = { mean: mean(bRows.map(r => r.diff)), hi: dayInterval(bRows).hi };
    look = futility(a, b);
    console.log(`THE FUTILITY LOOK (the first ${FUTILITY_AT} qualifying days, ${lookIds.length} positions; one look, this fixed set only): A ${fmt(a.mean)}, upper ${fmt(a.hi)}; B +0 ${fmt(b.mean)}, upper ${fmt(b.hi)}; hurdle ${HURDLE}% -> ${look}.`);
  } else if (ls === 'PENDING') console.log(`THE FUTILITY LOOK: ${FUTILITY_AT} qualifying days reached; waiting for every position on them to close (A: sold; B: +5 happened). Nothing of it is printed until then.`);
  const state = testState(q.days.length, spy.length, look);
  console.log(`THE FORWARD TEST @ ${rev}, from the start line ${START_LINE}: ${q.days.length} of ${QUALIFYING_DAYS} QUALIFYING DAYS (${spy.length} trading days since ${FIRST_QUALIFYING}; backstop ${BACKSTOP_TRADING_DAYS}; futility look at ${FUTILITY_AT}). STATE: ${state}.`);
  if (state === 'INTERIM') console.log('INTERIM: figures below are progress, NOT a reading; no interval is compared with any bar.');
  if (state === 'NOT ESTABLISHED FOR WANT OF DAYS') console.log('NOT ESTABLISHED FOR WANT OF DAYS: the declared horizon was not reached within the backstop. A third outcome, not a null.');
  if (state === 'FUTILE') console.log('FUTILE: stopped at the futility look. Even the optimistic end of A and B is below the spread hurdle. This is a stop for insufficiency, not a finding of zero.');
  const counts = s => [...status.values()].filter(v => v === s).length;
  console.log(`POSITIONS: ${q.positions.length}; B measured ${counts('DONE') + counts('OPEN')}, pending (+5 not yet happened) ${counts('PENDING')}, unpriced ${unpriced.length}${unpriced.length ? ` (${unpriced.slice(0, 8).join(', ')})` : ''}; A measured ${rowsA.length} closed, not measured ${notFull.length}.`);
  const evaluating = state === 'EVALUATE';
  if (rowsA.length) { const iv = dayInterval(rowsA), m = mean(rowsA.map(r => r.diff)); console.log(`  A: picks minus the universe ${fmt(m)} (${fmt(iv.lo)} to ${fmt(iv.hi)}), net of the hurdle ${fmt(m - HURDLE)}${evaluating ? ` -> ${readingA(iv)}` : ''}`); }
  const ivB = {}, mB = {};
  for (const n of HORIZONS) {
    const rs = rowsB.filter(r => r.n === n); if (!rs.length) continue;
    ivB[n] = dayInterval(rs); mB[n] = mean(rs.map(r => r.diff));
    console.log(`  B +${n}: excess against the universe ${fmt(mB[n])} (${fmt(ivB[n].lo)} to ${fmt(ivB[n].hi)}), net of the hurdle ${fmt(mB[n] - HURDLE)}; against IWM (the weaker proxy) ${fmt(mean(rs.map(r => r.iwm)))}`);
  }
  const cGuard = cComputable(show('settings.json'));
  if (!cGuard.ok) console.log(`  C: NOT COMPUTED. ${cGuard.why}`);
  for (const n of cGuard.ok ? HORIZONS : []) {
    const rs = rowsC.filter(r => r.n === n); if (!rs.length) continue;
    const iv = dayInterval(rs), ratio = sd(rs.map(r => r.opened)) / sd(rs.flatMap(r => r.notOpened)), riv = sdRatioInterval(rs);
    console.log(`  C +${n}: opened minus shown-not-opened ${fmt(mean(rs.map(r => r.diff)))} (${fmt(iv.lo)} to ${fmt(iv.hi)}); SD ratio ${ratio.toFixed(2)} (${riv.lo?.toFixed(2)} to ${riv.hi?.toFixed(2)})${evaluating ? ` -> ${Object.values(readingC(iv, riv)).join(', ')}` : ''}`);
  }
  if (evaluating && [1, 2, 5].every(n => ivB[n])) console.log(`B READING (declared): ${readingB(ivB, mB)}.`);
  for (const l of watchLines(flags)) console.log(l);
  console.log(`\n${q.days.length} of ${QUALIFYING_DAYS} QUALIFYING DAYS. STATE: ${state}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
