#!/usr/bin/env node
// scripts/measure-selection-differential.mjs -- THE SELECTION DIFFERENTIAL: did the chosen beat the unchosen? A standing
// measurement, re-run on each new backup. Read only. (2026-11-23, the reviewer: "the measurement this project should
// always have had -- the number any future idea gets judged on".) Everything measured before was absolute return
// ("did money come in"); this is the only figure about picking.
//
// THE START LINE (declared 2026-11-23, after RUN-ME-21 deleted every open position): the FORWARD differential counts only
// positions opened after 2026-11-23T20:42:43Z, the first opened after the delete, so no trade that could have generated
// a hypothesis is in it. That is the one start date. Separately, as a fact about the data: before 2026-11-12 the app
// saved only scan rows scoring 60 or more, so nothing earlier can be computed at all; --history reports 11-12 up to the
// start line, labelled as history, never as the test (its first reading, 2026-11-23: +0.31% over 4 days, STATUS).
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT.
//   DATA: the backups as committed (data/backups/rating_snapshots and trades_v2.json at the commit named by --rev,
//     default the latest commit that touched trades_v2.json). DAYS: those with a FULL scan saved (a minimum score of 0)
//     and at least one CLOSED pick bought that day. Open positions are not measured; they are counted.
//   UNIVERSE of a day: every distinct ticker its scans saved, picked or not (the reviewer's definition).
//   PER CLOSED PICK, over the pick's OWN window (the buy minute to the sell minute, Pacific clocks, as 8bc7432):
//     pick return from its SIP references (scripts/lib/sip-ref.mjs); UNIVERSE return = the mean, over the day's
//     universe, of each stock's return between the latest SIP 1-minute bar at or before each of the two minutes within
//     15 minutes (a stock with no bar in that window at either end is left out of that pick's mean and counted);
//     DIFFERENTIAL = pick - universe.
//   REPORTED: per day (closed picks, open, mean pick, mean universe, mean differential, universe coverage) and
//     cumulatively (mean differential, its 95% interval resampling whole days, 10,000, seed 20261123).
//   NO BAR: this is infrastructure, not a hypothesis test. Its first reading is descriptive. It is also the explanation
//     7e15b5b's ALIVE needs: picks beat IWM after 10-22, and only this separates "the chosen beat the unchosen" from
//     "the whole post-change universe beat IWM"; the universe's own return against IWM is printed beside it.
//   node scripts/measure-selection-differential.mjs [--rev <commit>] [--env-root <dir with .env.local>]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import { buyMinuteUtc as pacificMinuteUtc } from './measure-entry-price-gap.mjs';
import { sipRef } from './lib/sip-ref.mjs';
import { dayInterval } from './measure-change-split.mjs';
import { mean, ret } from './measure-good-days.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIRST_DAY = '2026-11-12', LOOKBACK_MIN = 15, BENCH = 'IWM';
// THE START LINE (declared 2026-11-23, the reviewer: "one start date in the record, not two"): the forward selection
// differential begins with the first position opened after Roman's delete of every open position (RUN-ME-21). The
// export was read at this instant and RUN-ME-21's guard proved nothing was added between that read and the delete, so a
// position added after it was opened after the delete. FIRST_DAY is not a second start: it is only the earliest day a
// universe was saved, and rows from it up to the start line are reported apart, as history, never as the test.
export const START_LINE = '2026-11-23T20:42:43.124Z';
// the moment a position was added: its position_id (Date.now() at the add) when present, else its Pacific buy minute
export const addedAt = r => (r.position_id != null && Number(r.position_id) > 1.7e12 ? Number(r.position_id) : pacificMinuteUtc(String(r.buy_date).slice(0, 10), r.buy_time));
export const afterStart = r => addedAt(r) > Date.parse(START_LINE);
export const BEGINS = 'THE FORWARD SELECTION DIFFERENTIAL BEGINS AT THE START LINE, 2026-11-23T20:42:43Z: the first position opened after Roman\'s delete. The --history run (from 2026-11-12, the earliest day a universe was saved) is before the start line: descriptive, never the test.'; export const BEGINS_DATA = 'Before 2026-11-12 the universe (what was available but not picked) was not saved, and nothing earlier can be computed.';

// the close of the latest bar starting at or before ms, within the lookback; null when none
export function priceAt(bars, ms, lookbackMin = LOOKBACK_MIN) {
  let best = null;
  for (const b of bars || []) { const t = Date.parse(b.t); if (t <= ms && t >= ms - lookbackMin * 60000 && (!best || t > best.t)) best = { t, c: b.c }; }
  return best ? best.c : null;
}
// the universe's mean return between two minutes; stocks without a price at either end are left out and counted
export function universeReturn(barsAt1, barsAt2, symbols, ms1, ms2) {
  const rs = [];
  for (const s of symbols) { const a = priceAt(barsAt1[s], ms1), b = priceAt(barsAt2[s], ms2); if (a != null && b != null && a > 0) rs.push(ret(a, b)); }
  return { value: rs.length ? mean(rs) : null, covered: rs.length, of: symbols.length };
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const headers = alpacaHeaders(arg('--env-root') || ROOT);
  const rev = arg('--rev') || execSync('git log -1 --format=%h -- data/backups/trades_v2.json', { cwd: ROOT }).toString().trim();
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const files = execSync(`git ls-tree --name-only ${rev} data/backups/rating_snapshots/`, { cwd: ROOT }).toString().trim().split('\n');
  const scans = files.flatMap(f => show(f.replace('data/backups/', '')));
  const ptDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const uni = new Map();
  for (const r of scans) { const d = ptDate(r.captured_at); (uni.get(d) || uni.set(d, { t: new Set(), min: Infinity }).get(d)).t.add(r.ticker); uni.get(d).min = Math.min(uni.get(d).min, r.score); }
  const history = process.argv.includes('--history');
  const inScope = r => (history ? String(r.buy_date).slice(0, 10) >= FIRST_DAY && !afterStart(r) : afterStart(r));
  const closed = show('trades_v2.json').filter(r => r.sell_price_unverified === false && inScope(r));
  const open = show('portfolio.json').filter(inScope);
  console.log(BEGINS + ' ' + BEGINS_DATA + '\n');
  console.log(history ? `HISTORY, BEFORE THE START LINE (${FIRST_DAY} to ${START_LINE}): descriptive only, NOT the forward test.` : `THE FORWARD TEST, from the start line ${START_LINE}.`);
  console.log(`DATA @ ${rev}: ${closed.length} closed picks and ${open.length} open positions in scope (${history ? `bought ${FIRST_DAY} up to the start line` : "added after the start line"}).`);
  const fullDays = new Set([...uni].filter(([, u]) => u.min === 0).map(([d]) => d));
  const barsCache = new Map();
  const barsNear = async (symbols, ms) => {
    const key = `${ms}`; if (barsCache.has(key)) return barsCache.get(key);
    const start = new Date(ms - LOOKBACK_MIN * 60000).toISOString(), end = new Date(ms).toISOString();
    let b; for (let i = 0; ; i++) { try { b = await fetchBars(headers, symbols, { timeframe: '1Min', start, end, feed: 'sip' }); break; } catch (e) { if (!(/HTTP 429/.test(e.message) || e instanceof TypeError) || i >= 6) throw e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); } }
    barsCache.set(key, b); await new Promise(r => setTimeout(r, 400)); return b;
  };
  const rows = [], notFull = [];
  for (const t of closed) {
    const d = String(t.buy_date).slice(0, 10);
    if (!fullDays.has(d)) { notFull.push(`${t.ticker} ${d}`); continue; }
    const b = pacificMinuteUtc(d, t.buy_time), s = pacificMinuteUtc(String(t.sell_date).slice(0, 10), t.sell_time);
    const [pb, ps, ib, is] = [await sipRef(headers, t.ticker, b), await sipRef(headers, t.ticker, s), await sipRef(headers, BENCH, b), await sipRef(headers, BENCH, s)];
    const symbols = [...uni.get(d).t];
    const u = universeReturn(await barsNear(symbols, b), await barsNear(symbols, s), symbols, b, s);
    if (!pb || !ps || u.value == null) { notFull.push(`${t.ticker} ${d} (no price)`); continue; }
    const pick = ret(pb.price, ps.price);
    rows.push({ day: d, pick, universe: u.value, iwm: ib && is ? ret(ib.price, is.price) : null, diff: pick - u.value, covered: u.covered, of: u.of });
  }
  const fmt = x => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  console.log(`MEASURED: ${rows.length} closed picks; not measured: ${notFull.length}${notFull.length ? ` (${notFull.slice(0, 8).join(', ')}${notFull.length > 8 ? ', ...' : ''})` : ''}.`);
  for (const d of [...new Set(rows.map(r => r.day))].sort()) {
    const rs = rows.filter(r => r.day === d), o = open.filter(p => String(p.buy_date).slice(0, 10) === d).length;
    console.log(`  ${d}: ${rs.length} closed (${o} still open); picks ${fmt(mean(rs.map(r => r.pick)))}, universe ${fmt(mean(rs.map(r => r.universe)))}, DIFFERENTIAL ${fmt(mean(rs.map(r => r.diff)))}; universe priced on ${Math.min(...rs.map(r => r.covered))}-${Math.max(...rs.map(r => r.covered))} of ${rs[0].of} stocks`);
  }
  const ci = dayInterval(rows);
  const iwmRows = rows.filter(r => r.iwm != null);
  if (!rows.length) { console.log('\nNO CLOSED POSITION opened after the start line yet: nothing to report, which is not zero.'); console.log(`\n${BEGINS}`); return; }
  console.log(`\nCUMULATIVE ${history ? `from ${FIRST_DAY} to the start line` : 'from the start line'}: ${rows.length} picks on ${new Set(rows.map(r => r.day)).size} days; picks ${fmt(mean(rows.map(r => r.pick)))}, universe ${fmt(mean(rows.map(r => r.universe)))}, SELECTION DIFFERENTIAL ${fmt(mean(rows.map(r => r.diff)))} (95% by days ${fmt(ci.lo)} to ${fmt(ci.hi)}).`);
  console.log(`BESIDE IT, for 7e15b5b: the universe against IWM over the same windows ${fmt(mean(iwmRows.map(r => r.universe - r.iwm)))}; the picks against IWM ${fmt(mean(iwmRows.map(r => r.pick - r.iwm)))}.`);
  console.log(`\n${BEGINS}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
