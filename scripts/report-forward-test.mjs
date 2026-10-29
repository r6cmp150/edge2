#!/usr/bin/env node
// scripts/report-forward-test.mjs -- the first forward test (phase-10 spec
// §7.6, "THE FIRST FORWARD-TEST TRADES", 2026-10-28): every closed trade
// in trades_v2 with code_version set (step 2's scoring, the entry gate and
// the 1M liquidity gate live), against the history on the same measures.
//
//   node scripts/report-forward-test.mjs --rev <backup commit>   (quotable)
//   node scripts/report-forward-test.mjs --live                  (NOT quotable)
//
// --rev reads data/backups/trades_v2.json at that commit, so a figure can
// be re-derived. --live reads the table now with the public anon key (the
// one in core/store.js) and says it isn't quotable: rows can still be
// edited, and nothing pins what was read. Use it only until a backup holds
// the trades, then re-run with --rev.
//
// Forward: code_version not null, sold. Baseline: code_version null, sold,
// sell price not flagged unverified (the 270 verified rows, -$2.53/trade,
// that §7.6 cites). The two differ in SIZE (~1.5x per trade) and PACE
// (64 round trips in two days), so dollar figures aren't comparable; the
// percentages are the size-free comparison.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const rev = args.includes('--rev') ? args[args.indexOf('--rev') + 1] : null;
const live = args.includes('--live');
if (!rev === !live) { console.error('usage: --rev <commit> | --live'); process.exit(2); }

let rows, source;
if (rev) {
  const j = JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString());
  rows = Array.isArray(j) ? j : j.rows;
  source = `data/backups/trades_v2.json at ${rev}`;
} else {
  const store = readFileSync(path.join(ROOT, 'core/store.js'), 'utf8');
  const url = store.match(/SUPABASE_URL = '([^']+)'/)[1], key = store.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1];
  rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${url}/rest/v1/trades_v2?select=*&order=id`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`trades_v2 read ${r.status}: ${await r.text()}`);
    const page = await r.json(); rows.push(...page);
    if (page.length < 1000) break;
  }
  source = `LIVE read of trades_v2 at ${new Date().toISOString()} -- NOT QUOTABLE; re-run with --rev on a backup that holds these trades`;
}

const sold = rows.filter(r => r.sell_date != null && r.pnl_dollars != null);
const fwd = sold.filter(r => r.code_version != null);
const base = sold.filter(r => r.code_version == null && !r.sell_price_unverified);

const hm = r => { const m = String(r.buy_time ?? '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const WINDOWS = [ // the timing analysis's windows (spec §3.4), PT
  ['before 6:30', -1, 390], ['6:30–6:45', 390, 405], ['6:45–7:00', 405, 420], ['7:00–7:15', 420, 435],
  ['7:15–7:30', 435, 450], ['7:30–8:00', 450, 480], ['8:00–9:00', 480, 540], ['9:00–10:00', 540, 600],
  ['10:00–11:00', 600, 660], ['11:00–12:00', 660, 720], ['12:00+', 720, 1e9],
];
const windowOf = r => { const t = hm(r); if (t == null) return 'no buy_time'; return WINDOWS.find(([, a, b]) => t >= a && t < b)[0]; };
const RSI_BANDS = [['<35 (step 2: 0 pts)', -1e9, 35], ['35–45', 35, 45], ['45–55', 45, 55], ['55–65', 55, 65], ['65–75', 65, 75], ['75+', 75, 1e9]];
const rsiOf = r => r.rsi_at_buy == null ? 'no RSI' : RSI_BANDS.find(([, a, b]) => r.rsi_at_buy >= a && r.rsi_at_buy < b)[0];

const usd = x => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const pc = x => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(2)}%`;
function stats(rs) {
  const n = rs.length; if (!n) return null;
  const w = rs.filter(r => r.pnl_dollars > 0), l = rs.filter(r => r.pnl_dollars < 0);
  const sum = (a, f) => a.reduce((s, r) => s + Number(f(r)), 0);
  const avgW = w.length ? sum(w, r => r.pnl_dollars) / w.length : null, avgL = l.length ? -sum(l, r => r.pnl_dollars) / l.length : null;
  const avgWp = w.length ? sum(w, r => r.pnl_pct) / w.length : null, avgLp = l.length ? -sum(l, r => r.pnl_pct) / l.length : null;
  return {
    n, wins: w.length, losses: l.length, flat: n - w.length - l.length, win: w.length / n,
    total: sum(rs, r => r.pnl_dollars), perTrade: sum(rs, r => r.pnl_dollars) / n, avgPct: sum(rs, r => r.pnl_pct) / n,
    avgW, avgL, avgWp, avgLp,
    // Break-even win rate from the average win and loss: the win rate at which
    // they net to zero. Computed in percent (size-free) and in dollars.
    beUsd: avgW != null && avgL != null ? avgL / (avgW + avgL) : null,
    bePct: avgWp != null && avgLp != null ? avgLp / (avgWp + avgLp) : null,
    cost: sum(rs, r => r.shares * r.buy_price) / n,
  };
}
const line = s => !s ? 'n=0' :
  `n=${s.n} | win ${(s.win * 100).toFixed(1)}% (${s.wins}W/${s.losses}L${s.flat ? `/${s.flat} flat` : ''}) | total ${usd(s.total)} | ${usd(s.perTrade)}/trade | avg ${pc(s.avgPct)}`;
function block(title, f) {
  const sf = stats(f[0]), sb = stats(f[1]);
  console.log(`\n${title}`);
  console.log(`  forward : ${line(sf)}`);
  console.log(`  baseline: ${line(sb)}`);
}

console.log(`Source: ${source}`);
console.log(`Rows: ${rows.length} | sold ${sold.length} | forward (code_version set, sold) ${fwd.length} | baseline (no code_version, sold, verified) ${base.length}`);
console.log(`Forward sell prices flagged unverified: ${fwd.filter(r => r.sell_price_unverified).length}`);
const vs = {}; for (const r of fwd) { const k = JSON.stringify(r.code_version); vs[k] = (vs[k] || 0) + 1; }
console.log('Forward code_version values:'); for (const [k, n] of Object.entries(vs)) console.log(`  ${n} × ${k}`);
const days = {}; for (const r of fwd) { const d = String(r.buy_date).slice(0, 10); days[d] = (days[d] || 0) + 1; }
console.log(`Forward buy dates: ${Object.entries(days).map(([d, n]) => `${d} ${n}`).join(', ')}`);

for (const [name, s] of [['FORWARD', stats(fwd)], ['BASELINE', stats(base)]]) {
  console.log(`\n${name}: ${line(s)}`);
  if (!s) continue;
  console.log(`  avg win ${usd(s.avgW)} (${pc(s.avgWp)}) vs avg loss −$${s.avgL.toFixed(2)} (−${s.avgLp.toFixed(2)}%)`);
  console.log(`  break-even win rate: ${(s.bePct * 100).toFixed(1)}% on percent, ${(s.beUsd * 100).toFixed(1)}% on dollars | actual ${(s.win * 100).toFixed(1)}%`);
  console.log(`  mean cost per trade $${s.cost.toFixed(2)}`);
}

console.log('\nBY BUY WINDOW (PT), forward | baseline');
for (const [w] of [...WINDOWS, ['no buy_time']]) {
  const f = fwd.filter(r => windowOf(r) === w), b = base.filter(r => windowOf(r) === w);
  if (!f.length && !b.length) continue;
  const sf = stats(f), sb = stats(b);
  const short = s => !s ? '—' : `n=${s.n} ${(s.win * 100).toFixed(0)}% ${pc(s.avgPct)} ${usd(s.total)}`;
  console.log(`  ${w.padEnd(12)} ${short(sf).padEnd(34)} | ${short(sb)}`);
}
const blocked = fwd.filter(r => { const t = hm(r); return t != null && t >= 420 && t < 450; });
const blockedDays = new Set(blocked.map(r => String(r.buy_date).slice(0, 10))).size;
console.log(`\nForward buys inside the gate's 07:00–07:30 window: ${blocked.length}, on ${blockedDays} distinct day(s)`);
// Pre-committed review criterion (spec §7.6 step 1, 2026-10-28).
console.log(`  Review criterion (>=30 trades across >=8 distinct days, then re-derive against the historical 70): ${blocked.length >= 30 && blockedDays >= 8 ? 'MET' : 'not met'}`);
for (const r of blocked) console.log(`  ${r.ticker} ${String(r.buy_date).slice(0, 10)} ${String(r.buy_time).slice(0, 5)} ${usd(r.pnl_dollars)} (${pc(r.pnl_pct)})`);
const sessions = {}; for (const r of fwd) sessions[r.buy_session ?? 'null'] = (sessions[r.buy_session ?? 'null'] || 0) + 1;
console.log(`Forward buy_session: ${Object.entries(sessions).map(([k, n]) => `${k} ${n}`).join(', ')}`);

const sameDay = r => String(r.buy_date).slice(0, 10) === String(r.sell_date).slice(0, 10);
block('SAME-DAY (sold on the buy date)', [fwd.filter(sameDay), base.filter(sameDay)]);
block('HELD OVERNIGHT OR LONGER', [fwd.filter(r => !sameDay(r)), base.filter(r => !sameDay(r))]);

console.log('\nRSI AT BUY, forward | baseline');
for (const [band] of [...RSI_BANDS, ['no RSI']]) {
  const f = fwd.filter(r => rsiOf(r) === band), b = base.filter(r => rsiOf(r) === band);
  if (!f.length && !b.length) continue;
  const sf = stats(f), sb = stats(b);
  const short = s => !s ? '—' : `n=${s.n} ${(s.win * 100).toFixed(0)}% ${pc(s.avgPct)} ${usd(s.total)}`;
  console.log(`  ${band.padEnd(20)} ${short(sf).padEnd(34)} | ${short(sb)}`);
}
const rs = fwd.map(r => r.rsi_at_buy).filter(x => x != null).sort((a, b) => a - b);
if (rs.length) console.log(`  forward RSI min ${rs[0].toFixed(1)} | median ${rs[Math.floor(rs.length / 2)].toFixed(1)} | max ${rs[rs.length - 1].toFixed(1)}`);

// The two AXTL lots and any other repeat ticker-day: the double-fire window
// and deliberate second lots look the same here.
const td = {}; for (const r of fwd) { const k = `${r.ticker} ${String(r.buy_date).slice(0, 10)}`; (td[k] ||= []).push(r); }
const rep = Object.entries(td).filter(([, a]) => a.length > 1);
console.log(`\nForward ticker-days with more than one lot: ${rep.length}`);
for (const [k, a] of rep) console.log(`  ${k}: ${a.map(r => `${String(r.buy_time).slice(0, 5)} ×${r.shares} ${usd(r.pnl_dollars)}`).join(' ; ')}`);
// The double-fire signature: two lots of one ticker-day whose position_id
// (the add's Date.now(), ms) are seconds apart AND whose share counts are
// identical, because one tap's form produced both. Deliberate second lots
// are minutes apart, usually at a different size.
let closest = null;
for (const [k, a] of rep) {
  const s = a.filter(r => r.position_id != null).sort((x, y) => Number(x.position_id) - Number(y.position_id));
  for (let i = 1; i < s.length; i++) {
    const gap = Number(s[i].position_id) - Number(s[i - 1].position_id);
    if (!closest || gap < closest.gap) closest = { k, gap, a: s[i - 1], b: s[i] };
  }
}
const sig = [];
for (const [k, a] of rep) for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
  const gap = Math.abs(Number(a[i].position_id) - Number(a[j].position_id));
  if (a[i].position_id != null && a[j].position_id != null && gap <= 120000 && Number(a[i].shares) === Number(a[j].shares)) sig.push(`${k} ${gap / 1000}s ×${a[i].shares}`);
}
console.log(`  closest pair by position_id: ${closest ? `${closest.k}, ${(closest.gap / 60000).toFixed(1)} min apart, ×${closest.a.shares} then ×${closest.b.shares}` : 'none'}`);
console.log(`  double-fire signature (<=2 min apart AND identical shares): ${sig.length ? sig.join(' ; ') : 'none'}`);
console.log(`  forward rows without position_id: ${fwd.filter(r => r.position_id == null).length}`);
