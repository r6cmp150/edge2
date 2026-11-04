// scripts/report-buy-score-distribution.mjs -- what score did Roman's actual
// buys carry (2026-11-02)? Asked because the observe-only macro change puts
// the display cut at the base line (v2: 20) every day; if he effectively
// never buys far below some score, the base cut is below his behaviour. A
// separate decision from the macro one: this only reports.
// signal_score is the score at buy; versions are never pooled (v1 and v2
// are different formulas with different lines). No code_version = v1 by
// construction (recorded before db/028's writer shipped). NULL stays NULL.
//   node scripts/report-buy-score-distribution.mjs [--rev d6e277d]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revArg = process.argv.indexOf('--rev');
const REV = revArg > 0 ? process.argv[revArg + 1] : 'd6e277d';
const rows = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
const LINES = { 1: { watch: 29, soft: 73, strong: 116 }, 2: { watch: 20, soft: 65, strong: 110 } };
console.log(`source: trades_v2 @ ${REV}, ${rows.length} rows (every recorded buy, sold or not)`);
const by = {};
for (const r of rows) (by[r.code_version?.scoring ?? 1] ||= []).push(r.signal_score == null ? null : Number(r.signal_score));
for (const [v, a] of Object.entries(by).sort()) {
  const L = LINES[v];
  const k = a.filter(x => x != null).sort((x, y) => x - y);
  const q = p => k[Math.floor(p * (k.length - 1))];
  console.log(`\nscoring v${v}: n=${a.length}, score not recorded ${a.length - k.length} | min ${k[0]} p10 ${q(0.1)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} max ${k[k.length - 1]}`);
  if (!L) { console.log('  no lines for this version'); continue; }
  const bands = [['below watch', -1e9, L.watch], [`watch-60 (${L.watch}-59)`, L.watch, 60], [`60-soft (60-${L.soft - 1})`, 60, L.soft], [`soft-strong (${L.soft}-${L.strong - 1})`, L.soft, L.strong], [`strong+ (${L.strong}+)`, L.strong, 1e9]];
  for (const [name, lo, hi] of bands) { const n = k.filter(x => x >= lo && x < hi).length; console.log(`  ${name.padEnd(24)} ${String(n).padStart(4)}  (${(100 * n / Math.max(1, k.length)).toFixed(1)}%)`); }
}
