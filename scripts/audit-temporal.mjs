#!/usr/bin/env node
// scripts/audit-temporal.mjs -- every temporal impossibility in the trade record, each named with its row. Read only.
// (Ordered 2026-11-20, CC-romans-call-audit section 4: "one trade records an exit earlier than its entry ... Now chase
// it. Find every temporal impossibility in the trade record -- exit before entry, exit before the market opened, two
// exits on one lot, an exit with no entry -- and name each one with its row.")
//
// THE RECORD: data/backups/trades_v2.json @ 98bcc07 (the 2026-11-21 backup, 908 rows, all of them; a row in the
// pre-registered 586 -- @ 314f6e0, sell_price_unverified false -- is marked [586]).
// THE MOMENTS: the buy = filled_at when recorded, else buy_date + buy_time (Pacific); the sale = sell_filled_at when
//   recorded, else sell_date + sell_time. (buy_time and sell_time are the RECORDING clocks; a fill time is typed.)
// THE CHECKS, each a rule a real execution cannot break:
//   EXIT_BEFORE_ENTRY   the sale's MINUTE is earlier than the buy's (compared at the minute, the recorded side's
//                       resolution). SAME_MINUTE, a round trip inside one recorded minute, is possible and is reported
//                       apart with the exact clocks (the add's position_id, the sale's created_at) where both exist.
//                       DATE_ORDER: sell_date earlier than buy_date, apart because it needs no time at all.
//   EXIT_OUTSIDE_SESSION / ENTRY_OUTSIDE_SESSION  the moment falls when no session trades: core/clock.js
//                       classifySession says CLOSED (a weekend, a holiday, or outside 01:00 PT to four hours after the
//                       close). Split by reason: a non-trading DATE, or the hours. (An order DATE on a Sunday is an order,
//                       not a fill; it is still a moment nothing could have traded, and is named as one.)
//   TWO_EXITS_ONE_LOT   two sale rows for one lot: a repeated position_id, or, where position_id is absent, a repeated
//                       (ticker, buy_date, buy_price, shares) (a CANDIDATE: two identical lots are possible).
//   EXIT_WITH_NO_ENTRY  a sale row with no buy date, price, shares or time.
// No check is a default of what it is compared with: each side is a separately recorded field or the calendar.
//   node scripts/audit-temporal.mjs [--rev 98bcc07]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '98bcc07', SAMPLE_REV = '314f6e0';

export function loadClassifySession(src = readFileSync(path.join(ROOT, 'core/clock.js'), 'utf8')) {
  const ctx = { state: { settings: {} }, console }; vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__cs = classifySession;', ctx);
  return ctx.__cs;
}
const day = v => (v == null || v === '' ? null : String(v).slice(0, 10));
const hm = v => (v == null || v === '' ? null : String(v).slice(0, 5));
export const ptMinuteUtc = (date, hhmm) => { const off = date >= '2026-11-01' ? 8 : 7; const [h, m] = hhmm.split(':').map(Number); return Date.parse(`${date}T00:00:00Z`) + ((h + off) * 60 + m) * 60000; };
const ptOf = ms => { const p = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` }; };
// a side's moment: { ms, date, hhmm, basis } or null when it cannot be placed
export function moment(fill, date, time) {
  if (fill) { const ms = Date.parse(fill); if (Number.isFinite(ms)) return { ms, ...ptOf(ms), basis: 'fill' }; }
  if (day(date) && hm(time) && /^\d{2}:\d{2}$/.test(hm(time))) return { ms: ptMinuteUtc(day(date), hm(time)), date: day(date), hhmm: hm(time), basis: 'recorded' };
  return null;
}
const nonTradingDate = (cs, date) => cs(date, '07:00') === 'CLOSED';

export function audit(rows, cs) {
  const out = { EXIT_BEFORE_ENTRY: [], SAME_MINUTE: [], DATE_ORDER: [], EXIT_OUTSIDE_SESSION: [], ENTRY_OUTSIDE_SESSION: [], TWO_EXITS_ONE_LOT: [], EXIT_WITH_NO_ENTRY: [] };
  for (const r of rows) {
    if (!day(r.buy_date) || r.buy_price == null || r.buy_price === '' || !(Number(r.shares) > 0) || !hm(r.buy_time)) { out.EXIT_WITH_NO_ENTRY.push({ r }); continue; }
    const b = moment(r.filled_at, r.buy_date, r.buy_time), s = moment(r.sell_filled_at, r.sell_date, r.sell_time);
    if (day(r.sell_date) && day(r.sell_date) < day(r.buy_date)) out.DATE_ORDER.push({ r });
    // At the MINUTE, the coarser side's resolution: a typed fill has seconds and a recorded time does not, so comparing
    // them exactly made a same-minute round trip look like a sale 15 seconds before its buy (the first run, APPS).
    const minute = ms => Math.floor(ms / 60000);
    if (b && s && minute(s.ms) < minute(b.ms)) out.EXIT_BEFORE_ENTRY.push({ r, b, s });
    else if (b && s && minute(s.ms) === minute(b.ms)) out.SAME_MINUTE.push({ r, b, s });
    for (const [k, m] of [['ENTRY_OUTSIDE_SESSION', b], ['EXIT_OUTSIDE_SESSION', s]]) {
      if (m && cs(m.date, m.hhmm) === 'CLOSED') out[k].push({ r, m, why: nonTradingDate(cs, m.date) ? 'non-trading date' : 'outside the hours' });
    }
  }
  const groups = new Map();
  for (const r of rows) { const k = r.position_id != null && r.position_id !== '' ? `id:${r.position_id}` : `key:${r.ticker}|${day(r.buy_date)}|${Number(r.buy_price)}|${Number(r.shares)}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  for (const [k, rs] of groups) if (rs.length > 1) out.TWO_EXITS_ONE_LOT.push({ key: k, rows: rs, candidate: k.startsWith('key:') });
  return out;
}

async function main() {
  const rev = (i => (i < 0 ? REV : process.argv[i + 1]))(process.argv.indexOf('--rev'));
  const show = r => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${r}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const rows = show(rev), inSample = new Set(show(SAMPLE_REV).filter(r => r.sell_price_unverified === false).map(r => String(r.id)));
  const tag = r => (inSample.has(String(r.id)) ? ' [586]' : '');
  const name = r => `${r.ticker} id ${String(r.id).slice(0, 8)} buy ${day(r.buy_date)} ${hm(r.buy_time)}${r.filled_at ? ` (fill ${r.filled_at})` : ''} -> sell ${day(r.sell_date)} ${hm(r.sell_time)}${r.sell_filled_at ? ` (fill ${r.sell_filled_at})` : ''}${r.sell_price_unverified ? ' unverified' : ''}${tag(r)}`;
  const a = audit(rows, loadClassifySession());
  console.log(`THE RECORD: trades_v2 @ ${rev}: ${rows.length} rows; [586] marks the pre-registered sample (@ ${SAMPLE_REV}).`);
  for (const k of ['EXIT_BEFORE_ENTRY', 'DATE_ORDER', 'EXIT_WITH_NO_ENTRY']) {
    console.log(`\n${k}: ${a[k].length} (in the 586: ${a[k].filter(x => inSample.has(String(x.r.id))).length})`);
    for (const x of a[k]) console.log(`  ${name(x.r)}${x.b ? `  [buy by ${x.b.basis}, sale by ${x.s.basis}: the sale ${Math.round((x.b.ms - x.s.ms) / 60000)} min before the buy]` : ''}`);
  }
  console.log(`\nSAME_MINUTE (bought and sold within one recorded minute: possible, not an impossibility; the exact clocks where both exist, the add's position_id against the sale's created_at): ${a.SAME_MINUTE.length}`);
  for (const x of a.SAME_MINUTE) {
    const add = Number(x.r.position_id) > 1.7e12 ? Number(x.r.position_id) : null, save = x.r.created_at ? Date.parse(x.r.created_at) : null;
    console.log(`  ${name(x.r)}  ${add && save ? `added ${new Date(add).toISOString()}, sale saved ${new Date(save).toISOString()}: ${((save - add) / 1000).toFixed(0)} s ${save >= add ? 'after' : 'BEFORE'} the add` : 'exact clocks not both recorded'}; bought ${x.r.buy_price}, sold ${x.r.sell_price}`);
  }
  for (const k of ['ENTRY_OUTSIDE_SESSION', 'EXIT_OUTSIDE_SESSION']) {
    const xs = a[k], by = w => xs.filter(x => x.why === w);
    console.log(`\n${k}: ${xs.length} (in the 586: ${xs.filter(x => inSample.has(String(x.r.id))).length}); non-trading date ${by('non-trading date').length}, outside the hours ${by('outside the hours').length}`);
    for (const x of xs) console.log(`  ${x.why.padEnd(17)} ${x.m.date} ${x.m.hhmm} PT by ${x.m.basis}: ${name(x.r)}`);
  }
  const two = a.TWO_EXITS_ONE_LOT;
  console.log(`\nTWO_EXITS_ONE_LOT: ${two.length} lots (${two.filter(x => !x.candidate).length} by a repeated position_id, ${two.filter(x => x.candidate).length} CANDIDATES by repeated ticker/buy date/price/shares)`);
  for (const x of two) { console.log(`  ${x.candidate ? 'candidate ' : 'position_id'} ${x.key}: ${x.rows.length} sale rows`); for (const r of x.rows) console.log(`      ${name(r)} sold @ ${r.sell_price}`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
