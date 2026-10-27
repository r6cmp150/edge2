// scripts/audit-buy-times-vs-tape.mjs -- is each stored buy_time a real fill
// time? (phase-10 spec §3.4, 2026-10-27). buy_price must have traded inside
// the full-market (SIP) minute bars' high-low within +-10 min of buy_time.
// SHIFT=<minutes> moves every buy time, as a placebo for the test's power.
//   node scripts/audit-buy-times-vs-tape.mjs            (07:00-07:29: 68 of 70)
//   SHIFT=60 node scripts/audit-buy-times-vs-tape.mjs   (placebo: 36%)
// Pinned to trades_v2 at b4620bc, verified rows only.
import { execSync } from 'node:child_process';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rows = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync('git show b4620bc:data/backups/trades_v2.json', { cwd: ROOT, maxBuffer: 1e9 }).toString()))
  .filter(r => !r.sell_price_unverified && r.buy_time);
const H = alpacaHeaders(ROOT);
const WIN = 10; const SHIFT = Number(process.env.SHIFT || 0);
// PT wall clock -> UTC instant (PDT before 11-01-2026, PST after).
const toUtc = (d, hm) => { const off = d >= '2026-11-01' ? 8 : 7; const [h, m] = hm.split(':').map(Number); return Date.parse(`${d}T00:00:00Z`) + ((h + off) * 60 + m) * 60000; };
const byDate = {};
for (const r of rows) (byDate[String(r.buy_date).slice(0, 10)] ||= []).push(r);
const res = [];
for (const [d, rs] of Object.entries(byDate)) {
  const ts = rs.map(r => toUtc(d, String(r.buy_time).slice(0, 5)) + SHIFT * 60000);
  const start = new Date(Math.min(...ts) - (WIN + 1) * 60000).toISOString(), end = new Date(Math.max(...ts) + (WIN + 1) * 60000).toISOString();
  const bars = await fetchBars(H, [...new Set(rs.map(r => r.ticker))], { timeframe: '1Min', start, end, feed: 'sip' });
  rs.forEach((r, i) => {
    const t = ts[i]; const w = (bars[r.ticker] || []).filter(b => Math.abs(Date.parse(b.t) - t) <= WIN * 60000);
    const p = Number(r.buy_price);
    const ok = w.length ? (p >= Math.min(...w.map(b => b.l)) - 0.005 && p <= Math.max(...w.map(b => b.h)) + 0.005) : null;
    res.push({ r, hm: String(r.buy_time).slice(0, 5), session: r.buy_session, ok, nbars: w.length });
  });
}
const bucket = hm => hm < '06:30' ? 'pre-open' : hm < '07:00' ? '06:30-06:59' : hm < '07:30' ? '07:00-07:29' : hm < '10:00' ? '07:30-09:59' : hm < '13:00' ? '10:00-12:59' : 'after 13:00';
const tab = {};
for (const x of res) { const k = bucket(x.hm); tab[k] ||= { n: 0, inRange: 0, outside: 0, noBars: 0 }; tab[k].n++; x.ok === true ? tab[k].inRange++ : x.ok === false ? tab[k].outside++ : tab[k].noBars++; }
console.log(`SHIFT ${SHIFT} min: buy_price within the SIP minute range at buy_time +-${WIN} min (verified trades with a buy_time: ${res.length})`);
for (const k of ['pre-open', '06:30-06:59', '07:00-07:29', '07:30-09:59', '10:00-12:59', 'after 13:00']) if (tab[k]) { const t = tab[k]; console.log(`  ${k.padEnd(12)} n=${String(t.n).padStart(3)} | in range ${t.inRange} (${Math.round(100 * t.inRange / Math.max(1, t.n - t.noBars))}% of checkable) | outside ${t.outside} | no bars ${t.noBars}`); }
const b = res.filter(x => bucket(x.hm) === '07:00-07:29');
console.log('07:00-07:29 OUTSIDE:', b.filter(x => x.ok === false).map(x => `${x.r.ticker} ${String(x.r.buy_date).slice(0, 10)} ${x.hm} @${x.r.buy_price} pnl ${Math.round(x.r.pnl_dollars)}`).join('; ') || 'none');
console.log('07:00-07:29 no bars:', b.filter(x => x.ok == null).map(x => `${x.r.ticker} ${String(x.r.buy_date).slice(0, 10)} ${x.hm}`).join('; ') || 'none');
const sess = {}; for (const x of res) { const k = x.session || 'NULL'; sess[k] ||= { n: 0, inRange: 0, outside: 0, noBars: 0 }; sess[k].n++; x.ok === true ? sess[k].inRange++ : x.ok === false ? sess[k].outside++ : sess[k].noBars++; }
console.log('by buy_session:', JSON.stringify(sess));
// Batch entry: buys sharing a buy_time minute with another buy that day.
const key = x => `${String(x.r.buy_date).slice(0, 10)} ${x.hm}`; const cnt = {}; res.forEach(x => { cnt[key(x)] = (cnt[key(x)] || 0) + 1; });
console.log('07:00-07:29 buys sharing their minute with another buy (batch entry):', b.filter(x => cnt[key(x)] > 1).length, 'of', b.length);
const bOut = b.filter(x => x.ok === false), bIn = b.filter(x => x.ok === true);
console.log(`07:00-07:29 P&L: all $${Math.round(b.reduce((s, x) => s + Number(x.r.pnl_dollars), 0))} | in-range only $${Math.round(bIn.reduce((s, x) => s + Number(x.r.pnl_dollars), 0))} (n=${bIn.length}, ${new Set(bIn.map(x => String(x.r.buy_date).slice(0, 10))).size} days)`);
