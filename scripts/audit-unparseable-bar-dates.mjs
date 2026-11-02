#!/usr/bin/env node
// Were any stored bar-freshness dates derived from a bar date that does not
// parse? (2026-11-02, phase-10 appendix: "an unparseable bar date reads as
// age 0, i.e. CURRENT".) core/clock.js tradingDaysBetween returns 0 for an
// Invalid Date, so such a history reads as today's. This checks, row by row:
//   signal_log.bars_as_of            the stored date, and the signal_snapshot
//                                    bars (+ dailyBar) it was derived from
//   trades_v2/portfolio.bars_as_of_at_buy
//   signal_snapshot_at_buy           the buy snapshots' bars, dailyBar and
//                                    dailyBarAsOf
// "Parses" = what core/clock.js needs: t.slice(0, 10) is a real YYYY-MM-DD
// (new Date(x + 'T12:00:00Z') valid and round-trips).
//
// Usage:
//   node scripts/audit-unparseable-bar-dates.mjs --rev <commit>   pinned: data/backups at that commit
//   node scripts/audit-unparseable-bar-dates.mjs --live           live tables (not quotable)
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const rev = arg('--rev'), live = arg('--live');
if (!rev === !live) { console.error('pass exactly one of --rev <commit> or --live'); process.exit(2); }

async function rows(table, select = '*', order = 'id') {
  if (rev) {
    try { return JSON.parse(execSync(`git show ${rev}:data/backups/${table}.json`, { cwd: ROOT, maxBuffer: 2e9 }).toString()); }
    catch (_) { return null; } // not in that backup
  }
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}&order=${order}.asc`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const isDay = d => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const x = new Date(d + 'T12:00:00Z');
  return !Number.isNaN(x.getTime()) && x.toISOString().slice(0, 10) === d;
};
const barDay = b => (b && typeof b.t === 'string') ? b.t.slice(0, 10) : null;

const report = [];
const tally = (label, total, bad, examples) => report.push({ label, total, bad, examples: examples.slice(0, 5) });

const sl = await rows('signal_log', 'id,bars_as_of,signal_snapshot');
if (sl) {
  const withDate = sl.filter(r => r.bars_as_of != null);
  tally('signal_log.bars_as_of (stored, non-null)', withDate.length, withDate.filter(r => !isDay(String(r.bars_as_of).slice(0, 10))).length,
    withDate.filter(r => !isDay(String(r.bars_as_of).slice(0, 10))).map(r => `${r.id}: ${r.bars_as_of}`));
  let barsTotal = 0, barsBad = 0, rowsBad = 0, dbTotal = 0, dbBad = 0; const ex = [], dex = [];
  let mismatch = 0; const mex = [];
  for (const r of sl) {
    const s = r.signal_snapshot; if (!s) continue;
    const bars = Array.isArray(s.bars) ? s.bars : [];
    let rowBad = false;
    for (const b of bars) { barsTotal++; if (!isDay(barDay(b))) { barsBad++; rowBad = true; if (ex.length < 5) ex.push(`${r.id}: t=${JSON.stringify(b?.t)}`); } }
    if (rowBad) rowsBad++;
    if (s.dailyBar) { dbTotal++; if (!isDay(barDay(s.dailyBar))) { dbBad++; if (dex.length < 5) dex.push(`${r.id}: t=${JSON.stringify(s.dailyBar.t)}`); } }
    // the stored date must be the max parseable bar date (what barsFreshness derives)
    if (r.bars_as_of != null && bars.length) {
      const max = bars.map(barDay).sort().at(-1);
      if (String(r.bars_as_of).slice(0, 10) !== max) { mismatch++; if (mex.length < 5) mex.push(`${r.id}: stored ${r.bars_as_of}, bars max ${max}`); }
    }
  }
  tally('signal_log.signal_snapshot.bars[].t (every bar)', barsTotal, barsBad, ex);
  report.push({ label: '  rows with any unparseable bar', total: sl.filter(r => r.signal_snapshot).length, bad: rowsBad, examples: [] });
  tally('signal_log.signal_snapshot.dailyBar.t', dbTotal, dbBad, dex);
  tally('signal_log.bars_as_of != max(bars[].t) (derivation check)', sl.filter(r => r.bars_as_of != null && r.signal_snapshot?.bars?.length).length, mismatch, mex);
} else report.push({ label: 'signal_log: not in this backup', total: 0, bad: 0, examples: [] });

for (const t of ['trades_v2', 'portfolio']) {
  const rs = await rows(t, 'id,bars_as_of_at_buy');
  if (!rs) { report.push({ label: `${t}: not in this backup`, total: 0, bad: 0, examples: [] }); continue; }
  const w = rs.filter(r => r.bars_as_of_at_buy != null);
  const bad = w.filter(r => !isDay(String(r.bars_as_of_at_buy).slice(0, 10)));
  tally(`${t}.bars_as_of_at_buy (non-null)`, w.length, bad.length, bad.map(r => `${r.id}: ${r.bars_as_of_at_buy}`));
}

const sb = await rows('signal_snapshot_at_buy', 'position_id,snapshot', 'position_id');
if (sb) {
  let bt = 0, bb = 0, dt = 0, dbad = 0, at = 0, abad = 0; const ex = [];
  for (const r of sb) {
    const s = r.snapshot || {};
    for (const b of (Array.isArray(s.bars) ? s.bars : [])) { bt++; if (!isDay(barDay(b))) { bb++; if (ex.length < 5) ex.push(`${r.position_id}: bar t=${JSON.stringify(b?.t)}`); } }
    if (s.dailyBar) { dt++; if (!isDay(barDay(s.dailyBar))) dbad++; }
    if (s.dailyBarAsOf != null) { at++; if (!isDay(s.dailyBarAsOf)) abad++; }
  }
  tally('signal_snapshot_at_buy bars[].t', bt, bb, ex);
  tally('signal_snapshot_at_buy dailyBar.t', dt, dbad, []);
  tally('signal_snapshot_at_buy dailyBarAsOf (stamped)', at, abad, []);
}

console.log(`source: ${rev ? 'data/backups @ ' + rev : 'LIVE (not quotable)'}`);
for (const r of report) {
  console.log(`${r.label}: ${r.bad} of ${r.total}`);
  for (const e of r.examples) console.log(`    ${e}`);
}
