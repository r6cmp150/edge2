// scripts/measure-prefilter-trailing.mjs -- the EDGE pre-filter's liquidity
// gate keyed on TRAILING average volume instead of today's cumulative volume
// (2026-10-22, phase-10 spec §7.3). Measure before proposing a number.
//
//   node scripts/measure-prefilter-trailing.mjs
//
// Today's cumulative volume is undefined early in the session (five minutes
// of tape can't say whether a stock is liquid), which is why every version
// of the current filter is a function of the clock. A trailing average is
// computed from completed sessions only, so it is the same at 06:30 and at
// 12:00 BY CONSTRUCTION, and it uses the full-market (SIP) tape, readable
// for any completed day. This prints, for share-volume and dollar-volume
// floors:
//   - how many of the 239 symbols pass, and how stable that is DAY TO DAY
//     (the test of a clock-independent filter: the count should barely move)
//   - intent: what share of the symbols the LIVE filter actually let through
//     (every EDGE symbol in signal_log at DATA_REV) each floor keeps
// Price rule unchanged in spirit: $1-$20, here on the prior close (also
// clock-independent). Data pinned: trailing bars are completed days, and the
// signal_log symbol set is read from git at DATA_REV.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const H = { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY };
const DATA_REV = 'de95a93';
const FETCH_FROM = '2026-08-01', LAST_DATE = '2026-10-21';
const LOOKBACK = 20, EVAL_DAYS = 22;   // evaluate the last 22 trading days, each on its own prior 20
const MIN_PRICE = 1, MAX_PRICE = 20;
const SHARE_FLOORS = [100e3, 250e3, 500e3, 1e6, 2e6];
const DOLLAR_FLOORS = [0.5e6, 1e6, 2e6, 5e6, 10e6];

const appLines = readFileSync(path.join(ROOT, 'app.js'), 'utf8').split('\n').map(l => l.replace(/\r$/, ''));
const a = appLines.indexOf('const STOCK_UNIVERSES = {');
const UNIVERSE = new Function(appLines.slice(a, appLines.indexOf('};', a) + 1).join('\n') + '\nreturn STOCK_UNIVERSES;')().OTHER;

async function dailyBars() {
  const out = {};
  for (let i = 0; i < UNIVERSE.length; i += 100) {
    const syms = UNIVERSE.slice(i, i + 100).join(',');
    let token = null;
    do {
      const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${syms}&timeframe=1Day&start=${FETCH_FROM}&end=${LAST_DATE}&feed=sip&adjustment=all&limit=10000&sort=asc` + (token ? `&page_token=${token}` : '');
      const res = await fetch(url, { headers: H });
      const body = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
      for (const [s, bars] of Object.entries(body.bars || {})) (out[s] ||= []).push(...bars);
      token = body.next_page_token;
    } while (token);
  }
  return out;
}

const bars = await dailyBars();
const day = b => b.t.slice(0, 10);
// trading days = dates SPY-free: use the union of dates seen across the universe
const allDates = [...new Set(Object.values(bars).flat().map(day))].sort();
const evalDates = allDates.filter(d => d <= LAST_DATE).slice(-EVAL_DAYS);

// per symbol per eval date: trailing avg shares, avg dollars, prior close
function stats(sym, d) {
  const prior = (bars[sym] || []).filter(b => day(b) < d);
  if (prior.length < LOOKBACK) return null;   // not enough history: not evaluable (counted separately)
  const w = prior.slice(-LOOKBACK);
  return { shares: w.reduce((s, b) => s + b.v, 0) / LOOKBACK, dollars: w.reduce((s, b) => s + b.v * (b.vw || b.c), 0) / LOOKBACK, price: prior[prior.length - 1].c };
}

const sl = JSON.parse(execSync(`git show ${DATA_REV}:data/backups/signal_log.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString());
const everScored = new Set((Array.isArray(sl) ? sl : sl.rows).filter(r => r.engine_source === 'EDGE').map(r => r.symbol || r.signal_snapshot?.ticker).filter(Boolean));

console.log(`universe ${UNIVERSE.length} (STOCK_UNIVERSES.OTHER); SIP daily bars ${FETCH_FROM}..${LAST_DATE}; ${EVAL_DAYS} eval dates ${evalDates[0]}..${evalDates[evalDates.length - 1]}, each on its prior ${LOOKBACK} sessions; price $${MIN_PRICE}-$${MAX_PRICE} on the prior close`);
console.log(`symbols the live filter let through (EDGE signal_log at ${DATA_REV}): ${everScored.size}`);
const notEvaluable = evalDates.map(d => UNIVERSE.filter(s => !stats(s, d)).length);
console.log(`not evaluable (< ${LOOKBACK} prior sessions): ${Math.min(...notEvaluable)}..${Math.max(...notEvaluable)} symbols per date`);

function report(kind, floors, fmt) {
  console.log(`\n${kind} floor   pass count over ${EVAL_DAYS} dates (min / median / max)   median day-to-day change   keeps of live-passed (${everScored.size})`);
  for (const f of floors) {
    const per = evalDates.map(d => UNIVERSE.filter(s => { const x = stats(s, d); return x && x.price >= MIN_PRICE && x.price <= MAX_PRICE && x[kind] >= f; }));
    const n = per.map(p => p.length).sort((x, y) => x - y);
    const deltas = per.slice(1).map((p, i) => { const prev = new Set(per[i]); const cur = new Set(p); return [...cur].filter(s => !prev.has(s)).length + [...prev].filter(s => !cur.has(s)).length; }).sort((x, y) => x - y);
    const last = new Set(per[per.length - 1]);
    const kept = [...everScored].filter(s => last.has(s)).length;
    console.log(`  ${fmt(f).padEnd(10)} ${String(n[0]).padStart(4)} / ${String(n[Math.floor(n.length / 2)]).padStart(4)} / ${String(n[n.length - 1]).padStart(4)}                               ${String(deltas[Math.floor(deltas.length / 2)]).padStart(3)} symbols in or out        ${kept} (${(kept / everScored.size * 100).toFixed(0)}%) on ${evalDates[evalDates.length - 1]}`);
  }
}
report('shares', SHARE_FLOORS, f => `${(f / 1e3).toLocaleString()}k sh`);
report('dollars', DOLLAR_FLOORS, f => `$${(f / 1e6).toFixed(1)}M`);
