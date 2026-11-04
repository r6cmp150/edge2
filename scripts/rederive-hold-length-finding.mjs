// scripts/rederive-hold-length-finding.mjs -- reproduces the phase-10 §0(a)
// hold-length figures (same-day 79.1% win of 86; 2+ market days 32.2% of 59;
// trades_v2 at b4620bc, the 270 rows without sell_price_unverified) through
// THE hold function (core/clock.js holdSpan), then re-derives them with each
// known contaminated subset removed (2026-11-02):
//   - the 22 sell_price_unverified rows (put back in, to show the effect);
//   - the 9 resurrected duplicate pairs (§7.5 q2: one position, two sales);
//   - the 17 dead-stock trades (§7.5 q3: recorded at the last close of a
//     stock that had stopped trading, sold back at the same price);
//   - NEOG 2026-08-19 (§7.5 q4: a buy with no market support).
// Win = pnl_dollars > 0. No figures are written anywhere; this prints.
//   node scripts/rederive-hold-length-finding.mjs [--rev b4620bc]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revArg = process.argv.indexOf('--rev');
const REV = revArg > 0 ? process.argv[revArg + 1] : 'b4620bc';

// core/clock.js is a classic browser script: load it whole, take holdSpan.
const ctx = { console, Date, Math, Intl, Number, String, Set, Map, Array, Object, JSON, isNaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'core/clock.js'), 'utf8') + '\n;globalThis.__holdSpan = holdSpan;', ctx);
const holdSpan = ctx.__holdSpan;

const all = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
const day = v => (v == null ? null : String(v).slice(0, 10));

const PAIR_TICKERS = new Set(['GPGI', 'HTZ', 'VISN', 'RR', 'TDAY', 'GO', 'CXM', 'SOUN', 'SNXX']);
const DEAD_TICKERS = { AREN: 3, TWO: 3, HLX: 3, GBTG: 2, BRR: 2, ATAI: 1, CCRN: 1, DOMO: 1, LC: 1 };
const key = r => `${r.ticker}|${day(r.buy_date)}`;
const cnt = {};
for (const r of all) cnt[key(r)] = (cnt[key(r)] || 0) + 1;
const isPair = r => PAIR_TICKERS.has(r.ticker) && cnt[key(r)] >= 2;
const isDead = r => r.ticker in DEAD_TICKERS && Number(r.buy_price) === Number(r.sell_price);
const isNeog = r => r.ticker === 'NEOG' && day(r.buy_date) === '2026-08-19';

// Each set's size, checked against the documented count, so a wrong
// identification can't pass silently.
const pairs = all.filter(isPair), dead = all.filter(isDead), neog = all.filter(isNeog), unver = all.filter(r => r.sell_price_unverified);
const expectDead = Object.values(DEAD_TICKERS).reduce((a, b) => a + b, 0);
console.log(`source: trades_v2 @ ${REV}: ${all.length} rows; unverified ${unver.length} (doc 22), duplicate-pair rows ${pairs.length} (doc 18), dead-stock ${dead.length} (doc ${expectDead}), NEOG ${neog.length} (doc 1)`);

function buckets(rows) {
  const b = { same: { n: 0, w: 0 }, one: { n: 0, w: 0 }, two: { n: 0, w: 0 }, nul: 0 };
  for (const r of rows) {
    const c = holdSpan({ filledAt: r.filled_at ?? null, buyDate: day(r.buy_date), orderType: r.order_type ?? null }, day(r.sell_date)).closes;
    if (c == null) { b.nul++; continue; }
    const k = c === 0 ? 'same' : c === 1 ? 'one' : 'two';
    b[k].n++; if (Number(r.pnl_dollars) > 0) b[k].w++;
  }
  return b;
}
const pct = x => (x.n ? (100 * x.w / x.n).toFixed(1) + '%' : '—');
const line = (label, rows) => {
  const b = buckets(rows);
  console.log(`${label.padEnd(44)} n=${String(rows.length).padStart(3)} | same-day ${pct(b.same)} of ${b.same.n} | 1 day ${pct(b.one)} of ${b.one.n} | 2+ days ${pct(b.two)} of ${b.two.n}${b.nul ? ` | no hold ${b.nul}` : ''}`);
};
const base = all.filter(r => !r.sell_price_unverified);
// The published 79.1% of 86 is CALENDAR same-day (buy_date = sell_date); it
// drops the 21 Sunday orders sold Monday, which holdSpan counts as same-day
// (0 closes: the fill was Monday). Printed so the two definitions sit side by side.
{
  const cal = base.filter(r => day(r.buy_date) === day(r.sell_date));
  const w = cal.filter(r => Number(r.pnl_dollars) > 0).length;
  console.log(`${'calendar same-day (buy_date = sell_date)'.padEnd(44)} n=${String(cal.length).padStart(3)} | ${(100 * w / cal.length).toFixed(1)}% win`);
}
line('AS PUBLISHED (270 verified), via holdSpan', base);
line('+ the 22 unverified put back', all);
line('- duplicate-pair rows', base.filter(r => !isPair(r)));
line('- dead-stock trades', base.filter(r => !isDead(r)));
line('- NEOG', base.filter(r => !isNeog(r)));
line('- all three', base.filter(r => !isPair(r) && !isDead(r) && !isNeog(r)));
