// scripts/audit-shortlist-without-raise.mjs -- how much longer would the
// shortlist have been on raised-threshold days if the cut were the base line
// every day (macro observe-only, 2026-11-02)?
//
// Raised days come from Roman's buys (trades_v2.threshold_at_buy at its
// version's soft line), with the condition recorded on them. The shortlist
// sizes come from signal_log's EDGE rows: the scheduled logger scores with
// NO macro context, so its SHOWN tier is the base-line shortlist. PROXY,
// stated on every line: the logger's universe and scan times are not
// Roman's browser scans (category, time of day), so these are the logger's
// counts, not his screen's. Days with no logger scan say so.
//   node scripts/audit-shortlist-without-raise.mjs [--trades d6e277d] [--log 209dec2]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TR = arg('--trades', 'd6e277d'), LOG = arg('--log', '209dec2');
const load = (rev, f) => (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
const trades = load(TR, 'trades_v2.json');
const log = load(LOG, 'signal_log.json').filter(r => r.engine_source === 'EDGE');

const SOFT_FOR_BASE = { 20: 65, 29: 73 };
const RAISED = new Set([65, 73]);
const raisedDays = {};
for (const t of trades) {
  if (t.threshold_at_buy == null || !RAISED.has(Number(t.threshold_at_buy))) continue;
  const d = String(t.buy_date).slice(0, 10);
  raisedDays[d] ||= { buys: 0, conds: {} };
  raisedDays[d].buys++;
  raisedDays[d].conds[t.macro_condition ?? 'NULL'] = (raisedDays[d].conds[t.macro_condition ?? 'NULL'] || 0) + 1;
}
console.log(`raised days from trades_v2 @ ${TR}; shortlist proxy from signal_log (EDGE logger, no macro) @ ${LOG}`);
const out = [];
for (const [d, x] of Object.entries(raisedDays).sort()) {
  const rows = log.filter(r => r.signal_date === d);
  const cond = Object.entries(x.conds).map(([c, n]) => `${c}×${n}`).join(' ');
  if (!rows.length) { console.log(`${d}  ${cond.padEnd(28)} buys ${String(x.buys).padStart(2)} | no logger scan that day: not measurable`); continue; }
  // per scan: shown at base vs scores at/above that version's raised line
  const scans = {};
  for (const r of rows) { (scans[r.scan_session] ||= []).push(r); }
  const per = Object.values(scans).map(rs => {
    const base = Number(rs.find(r => r.signal_snapshot?.thresholdAtBuy != null)?.signal_snapshot.thresholdAtBuy);
    const soft = SOFT_FOR_BASE[base];
    const shown = rs.filter(r => r.tier === 'SHOWN');
    return { base, soft, shown: shown.length, atSoft: soft == null ? null : shown.filter(r => Number(r.signal_snapshot?.score) >= soft).length };
  });
  const best = per.reduce((a, b) => (b.shown > a.shown ? b : a));
  out.push({ d, ...best });
  console.log(`${d}  ${cond.padEnd(28)} buys ${String(x.buys).padStart(2)} | largest logger scan: base line ${best.base} shows ${String(best.shown).padStart(3)}; at the raised line ${best.soft ?? '?'} it would show ${best.atSoft ?? '?'}  (${per.length} scan(s))`);
}
const m = out.filter(o => o.atSoft != null).sort((a, b) => (b.shown - b.atSoft) - (a.shown - a.atSoft))[0];
if (m) console.log(`LARGEST GAIN (logger proxy): ${m.d}, ${m.atSoft} -> ${m.shown} shown (+${m.shown - m.atSoft})`);
