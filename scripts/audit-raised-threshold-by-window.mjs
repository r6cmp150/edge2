// scripts/audit-raised-threshold-by-window.mjs -- are the trades bought under
// a RAISED display threshold (2026-11-02) spread evenly across the buy-time
// windows, or do they cluster? The display threshold rises (v1 29 -> 73,
// v2 20 -> 65) on GEOPOLITICAL / RISK_OFF days, and for the affected
// categories on sector-weakness days, whether or not the macro overlay is
// on, and the macro condition was often Groq-decided with no record of it.
// If raised-threshold buys cluster in 07:00-07:29 PT, that window's result
// (n=70, -$377, 14 days; §3.4) partly measures a different, higher-scoring
// population rather than the hour.
//
// Raised = threshold_at_buy equal to its version's soft line (65 or 73);
// NULL threshold_at_buy is its own state, never folded into "not raised".
//   node scripts/audit-raised-threshold-by-window.mjs [--rev b4620bc]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revArg = process.argv.indexOf('--rev');
const REV = revArg > 0 ? process.argv[revArg + 1] : 'b4620bc';
const all = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
const rows = all.filter(r => r.sell_date != null && r.pnl_dollars != null && !r.sell_price_unverified);

const RAISED = new Set([65, 73]), BASE = new Set([20, 29]);
const state = r => r.threshold_at_buy == null ? 'unknown' : RAISED.has(Number(r.threshold_at_buy)) ? 'raised' : BASE.has(Number(r.threshold_at_buy)) ? 'base' : `other(${r.threshold_at_buy})`;
// §3.4's buckets, the ones the 07:00-07:29 result is stated in.
const bucket = r => {
  const hm = String(r.buy_time ?? '').slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(hm)) return 'no buy_time';
  return hm < '06:30' ? 'pre-open' : hm < '07:00' ? '06:30-06:59' : hm < '07:30' ? '07:00-07:29' : hm < '10:00' ? '07:30-09:59' : hm < '13:00' ? '10:00-12:59' : 'after 13:00';
};
const ORDER = ['pre-open', '06:30-06:59', '07:00-07:29', '07:30-09:59', '10:00-12:59', 'after 13:00', 'no buy_time'];
const tab = {};
for (const r of rows) { const b = bucket(r), s = state(r); tab[b] ||= {}; tab[b][s] ||= { n: 0, w: 0, pnl: 0, days: new Set() }; const t = tab[b][s]; t.n++; if (Number(r.pnl_dollars) > 0) t.w++; t.pnl += Number(r.pnl_dollars); t.days.add(String(r.buy_date).slice(0, 10)); }
const tot = s => rows.filter(r => state(r) === s).length;
console.log(`source: trades_v2 @ ${REV}, closed verified rows ${rows.length} (of ${all.length}) | raised ${tot('raised')}, base ${tot('base')}, unknown ${tot('unknown')}`);
console.log(`window        n   | raised: n (share)  win   P&L    days | base: n  win   P&L | unknown`);
for (const b of ORDER) {
  const t = tab[b]; if (!t) continue;
  const n = Object.values(t).reduce((a, x) => a + x.n, 0);
  const f = x => x ? `${String(x.n).padStart(3)} ${(100 * x.w / x.n).toFixed(0).padStart(3)}% ${(x.pnl >= 0 ? '+' : '−') + '$' + Math.abs(x.pnl).toFixed(0)}` : '  —';
  const r = t.raised;
  console.log(`${b.padEnd(12)} ${String(n).padStart(3)} | ${r ? `${String(r.n).padStart(3)} (${(100 * r.n / n).toFixed(0).padStart(2)}%) ${(100 * r.w / r.n).toFixed(0).padStart(3)}% ${(r.pnl >= 0 ? '+' : '−') + '$' + Math.abs(r.pnl).toFixed(0)} ${String(r.days.size).padStart(3)}d` : '  —'} | ${f(t.base)} | ${t.unknown?.n ?? 0}`);
}
// The days themselves: which share of each raised day's buys fell in 07:00-07:29.
const raisedDays = {};
for (const r of rows.filter(r => state(r) === 'raised')) { const d = String(r.buy_date).slice(0, 10); raisedDays[d] ||= { n: 0, w0700: 0 }; raisedDays[d].n++; if (bucket(r) === '07:00-07:29') raisedDays[d].w0700++; }
console.log(`raised-threshold buy days: ${Object.keys(raisedDays).length} | ${Object.entries(raisedDays).sort().map(([d, x]) => `${d} ${x.n}(${x.w0700} in 07:00-07:29)`).join(', ')}`);
