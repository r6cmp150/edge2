#!/usr/bin/env node
// scripts/audit-first-hour-cell.mjs -- the 07:00-07:29 cell on the whole book (phase-10 §3.4, 2026-11-05).
// Pinned rows, sold trades only. Excludes sell_price_unverified and the rows of the resurrected duplicate
// pairs, as the timing analysis does. Checks itself first: at b4620bc it must reproduce the published
// n=70, -$377, 14 days.
//   node scripts/audit-first-hour-cell.mjs [rev]     (default 164099a)
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (rev, table) => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${table}.json`, { cwd: ROOT, maxBuffer: 2e9, encoding: 'utf8' })));

export const CELLS = [['before 06:30', '00:00', '06:30'], ['06:30-06:59', '06:30', '07:00'], ['07:00-07:29', '07:00', '07:30'], ['07:30-09:59', '07:30', '10:00'], ['10:00+', '10:00', '24:00']];
export const hm = r => String(r.buy_time || '').slice(0, 5);
const pairKey = r => `${r.ticker}|${String(r.buy_date).slice(0, 10)}|${r.buy_price}|${r.shares}`;

// One position recorded as two sales: same ticker, buy date, buy price and shares, among the nine named tickers.
export const PAIR_TICKERS = ['GPGI', 'HTZ', 'VISN', 'RR', 'TDAY', 'GO', 'CXM', 'SOUN', 'SNXX'];
export function pairRows(rows) {
  const groups = new Map();
  for (const r of rows) { const k = pairKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.values()].filter(g => g.length > 1 && PAIR_TICKERS.includes(g[0].ticker)).flat();
}
export function population(rows) {
  const pairs = new Set(pairRows(rows).map(r => r.id));
  return rows.filter(r => r.pnl_dollars != null && !r.sell_price_unverified && r.buy_time && !pairs.has(r.id));
}
export function cell(rows) {
  const n = rows.length;
  if (!n) return { n: 0, days: 0 };
  const dollars = rows.map(r => Number(r.pnl_dollars));
  const wins = dollars.filter(x => x > 0).length, losses = dollars.filter(x => x < 0).length;
  const byDay = new Map();
  for (const r of rows) { const d = String(r.buy_date).slice(0, 10); byDay.set(d, (byDay.get(d) || 0) + Number(r.pnl_dollars)); }
  const pct = rows.map(r => Number(r.pnl_pct)).filter(Number.isFinite);
  const pnl = dollars.reduce((a, b) => a + b, 0);
  return {
    n, days: byDay.size, wins, losses, winRate: (100 * wins) / (wins + losses),
    avgPct: pct.reduce((a, b) => a + b, 0) / pct.length,
    pnl, minusBest: pnl - Math.max(...dollars),
    profitableDays: [...byDay.values()].filter(x => x > 0).length,
  };
}
export const inCell = (r, from, to) => hm(r) >= from && hm(r) < to;
const fmt = c => (c.n ? `n ${String(c.n).padStart(3)}, ${String(c.days).padStart(2)} days, win ${c.winRate.toFixed(1)}%, avg ${c.avgPct >= 0 ? '+' : ''}${c.avgPct.toFixed(2)}%, P&L ${c.pnl >= 0 ? '+' : '−'}$${Math.abs(c.pnl).toFixed(2)}, minus best ${c.minusBest >= 0 ? '+' : '−'}$${Math.abs(c.minusBest).toFixed(2)}, profitable days ${c.profitableDays}/${c.days}` : 'n 0');

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rev = process.argv[2] || '164099a';
  const check = load('b4620bc', 'trades_v2').filter(r => !r.sell_price_unverified && r.buy_time);
  const pub = cell(check.filter(r => inCell(r, '07:00', '07:30')));
  console.log(`CHECK at b4620bc, verified rows (the published figure is n=70, -$377, 14 days): n ${pub.n}, P&L ${pub.pnl.toFixed(2)}, ${pub.days} days`);

  const all = load(rev, 'trades_v2');
  const pairs = pairRows(all), pop = population(all);
  console.log(`\nsource: trades_v2 at ${rev}; sold rows ${all.filter(r => r.pnl_dollars != null).length}; excluded: unverified ${all.filter(r => r.sell_price_unverified).length}, resurrected-pair rows ${pairs.length}; population ${pop.length}`);
  const v2 = r => r.code_version && r.code_version.scoring === 2;
  for (const [label, rows] of [['WHOLE BOOK', pop], ['before v2', pop.filter(r => !v2(r))], ['scoring v2', pop.filter(v2)]]) {
    console.log(`\n${label}:`);
    for (const [name, from, to] of CELLS) console.log(`  ${name.padEnd(12)} ${fmt(cell(rows.filter(r => inCell(r, from, to))))}`);
    console.log(`  ${'all'.padEnd(12)} ${fmt(cell(rows))}`);
  }
  const days = rows => { const m = new Map(); for (const r of rows) { const d = String(r.buy_date).slice(0, 10); m.set(d, (m.get(d) || 0) + Number(r.pnl_dollars)); } return [...m.entries()].sort().map(([d, x]) => `${d.slice(5)} ${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(0)}`).join('  '); };
  console.log(`\n07:00-07:29, by buy date:\n  ${days(pop.filter(r => inCell(r, '07:00', '07:30')))}`);
  const openCell = load(rev, 'portfolio').filter(p => inCell(p, '07:00', '07:30') && !(p.order_type != null && p.filled_at == null));
  console.log(`\nStill open at ${rev}, stamped 07:00-07:29, so not in any figure above: ${openCell.length}${openCell.length ? ` (${openCell.map(p => `${p.ticker} ${String(p.buy_date).slice(5, 10)}`).join(', ')})` : ''}`);
  const cellRows = pop.filter(r => inCell(r, '07:00', '07:30'));
  const earlyTo = cellRows.filter(r => r.filled_at && r.buy_time && String(r.filled_at).length > 0).length;
  console.log(`Cell rows with a filled_at: ${earlyTo} of ${cellRows.length}.`);
}
