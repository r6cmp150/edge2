// scripts/audit-after-hours-buys.mjs -- AFTER_HOURS buys with no SIP bar
// near buy_time (phase-10 spec §3.4, 2026-10-27): did the stock trade after
// hours that evening, and where did buy_price trade? Separates a closing
// fill typed in late from an after-hours fill at the closing price (often
// it can't). Pinned to trades_v2 at b4620bc.
//   node scripts/audit-after-hours-buys.mjs      (14 rows, 13 at the closing print)
import { execSync } from 'node:child_process';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rows = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync('git show b4620bc:data/backups/trades_v2.json', { cwd: ROOT, maxBuffer: 1e9 }).toString()))
  .filter(r => !r.sell_price_unverified && r.buy_session === 'AFTER_HOURS');
const H = alpacaHeaders(ROOT);
const toUtc = (d, hm) => { const [h, m] = hm.split(':').map(Number); return Date.parse(`${d}T00:00:00Z`) + ((h + 7) * 60 + m) * 60000; }; // all before 11-01: PDT
const ptHM = t => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
const out = { noAhNear: [], counts: { checked: 0 } };
for (const r of rows) {
  const d = String(r.buy_date).slice(0, 10), hm = String(r.buy_time).slice(0, 5), p = Number(r.buy_price), t = toUtc(d, hm);
  const bars = (await fetchBars(H, [r.ticker], { timeframe: '1Min', start: `${d}T13:30:00Z`, end: `${d}T23:59:00Z`, feed: 'sip' }))[r.ticker] || [];
  const near = bars.filter(b => Math.abs(Date.parse(b.t) - t) <= 10 * 60000);
  if (near.length) continue;
  out.counts.checked++;
  const isReg = b => { const x = Date.parse(b.t); return x >= toUtc(d, '06:30') && x < toUtc(d, '13:00'); };
  const reg = bars.filter(isReg), ah = bars.filter(b => Date.parse(b.t) >= toUtc(d, '13:00'));
  const hit = bs => bs.filter(b => p >= b.l - 0.005 && p <= b.h + 0.005);
  const regHit = hit(reg), ahHit = hit(ah);
  out.noAhNear.push(`${r.ticker} ${d} ${hm} @${p}: after-hours minutes that evening ${ah.length}${ah.length ? ` (${ptHM(ah[0].t)}-${ptHM(ah[ah.length - 1].t)})` : ''}; price traded after hours ${ahHit.length ? 'YES at ' + ptHM(ahHit[0].t) : 'no'}; in regular session ${regHit.length ? 'YES ' + ptHM(regHit[0].t) + '-' + ptHM(regHit[regHit.length - 1].t) : 'no'}`);
}
console.log(`AFTER_HOURS buys with no SIP bar within +-10 min: ${out.counts.checked}`);
out.noAhNear.forEach(l => console.log('  ' + l));
