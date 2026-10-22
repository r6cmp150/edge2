// scripts/measure-step2-residual.mjs -- phase-10 step 2's 4(b) residual
// (spec §7.6 step 2). Step 2 ties the exit engine's score cutoffs to the
// re-derived thresholds, but the formula change is composition-dependent
// (it removes up to 25 points from cheap and oversold names only), so a
// residual remains. This measures it on the positions actually held.
//
//   node scripts/measure-step2-residual.mjs                  (pinned data)
//   node scripts/measure-step2-residual.mjs --data-rev HEAD
//
// For every EDGE trade in trades_v2 (at DATA_REV) held during the
// signal_log window, for every day it was held: rebuild that day's
// end-of-day scoring inputs from the ticker's own daily bars, score them
// under the OLD formula (core/edge-scoring.js at BASE_COMMIT, from git)
// and the NEW one (working tree), and report:
//   1. how far the score moves (the entry score is clean: render-written
//      values don't touch it), and
//   2. how many position-days change exit-cutoff bucket (old cutoffs
//      116/94/73/44 on the old score vs new 110/87/65/39 on the new).
//      NOISY, and not a decision input: the exit engine's other inputs are
//      render-dependent until step 2.5, and this rebuild has no news and
//      no macro condition.
//
// Reconstruction limits, stated: end-of-day snapshot (price = that day's
// close, volume = that day's full volume); bars = daily bars through the
// day before; spyChange from SPY's own bars; category OTHER (the EDGE
// universe); no news; no macro adjustment. These are the same for both
// formulas, so they bias the level, not the old-vs-new difference.
// Read-only Alpaca requests via the app's own fetchMultiBars (30 symbols
// per request), plus one for SPY.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_COMMIT = 'b63ef1b';
const argRev = process.argv.indexOf('--data-rev');
const DATA_REV = argRev > -1 ? process.argv[argRev + 1] : 'de95a93';
const WINDOW = ['2026-09-11', '2026-10-21']; // the signal_log window at DATA_REV
const OLD_CUTS = { strong: 116, mid: 94, soft: 73, weak: 44, topStrict: true };  // old code: > 116
const NEW_CUTS = { strong: 110, mid: 87, soft: 65, weak: 39, topStrict: false }; // floor/ceil expressions, all >=

const read = f => readFileSync(path.join(ROOT, f), 'utf8');
const env = Object.fromEntries(read('.env.local').split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');

function context(scoringSrc) {
  const c = { console, Math, Date, JSON, Number, String, Array, Object, Infinity, NaN, isFinite, Promise, Error, URL, URLSearchParams, setTimeout, fetch,
    state: { settings: { alpacaKey: env.APCA_API_KEY_ID, alpacaSecret: env.APCA_API_SECRET_KEY, disableMacroOverlay: true }, macroContext: null } };
  vm.createContext(c);
  for (const f of ['core/api-client.js', 'core/indicators.js', 'core/market-data.js']) vm.runInContext(strip(read(f)), c);
  vm.runInContext(strip(scoringSrc) + '\n;globalThis.__s = scoreStock; globalThis.__fetchMultiBars = fetchMultiBars;', c);
  return c;
}
const OLD = context(execSync(`git show ${BASE_COMMIT}:core/edge-scoring.js`, { cwd: ROOT, maxBuffer: 1e8 }).toString());
const NEW = context(read('core/edge-scoring.js'));

const bucket = (score, k) => (k.topStrict ? score > k.strong : score >= k.strong) ? 'support+50'
  : score >= k.mid ? 'support+30' : score >= k.soft ? 'support+15' : score >= k.weak ? 'weak-10' : 'weak-25';

const raw = JSON.parse(execSync(`git show ${DATA_REV}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString());
const trades = (Array.isArray(raw) ? raw : raw.rows)
  .filter(t => (t.engine_source || 'EDGE') === 'EDGE' && t.sell_date >= WINDOW[0] && t.buy_date <= WINDOW[1]);
const tickers = [...new Set(trades.map(t => t.ticker))];
console.log(`data: trades_v2 at ${DATA_REV}; old formula ${BASE_COMMIT}; new formula: working tree`);
console.log(`EDGE trades held in ${WINDOW[0]}..${WINDOW[1]}: ${trades.length} (${tickers.length} tickers)`);

const { results: barsBy, droppedSymbols } = await NEW.__fetchMultiBars([...tickers, 'SPY'], 10000);
const day = b => (b.t || '').slice(0, 10);
const spy = (barsBy.SPY || []).slice().sort((a, b) => a.t.localeCompare(b.t));
const spyChg = {};
for (let i = 1; i < spy.length; i++) spyChg[day(spy[i])] = (spy[i].c / spy[i - 1].c - 1) * 100;

let posDays = 0, skippedTrades = 0;
const deltas = {}, moves = {}, tradeMoved = new Set(), tradeBucketChanged = new Set();
for (const t of trades) {
  const bars = (barsBy[t.ticker] || []).slice().sort((a, b) => a.t.localeCompare(b.t));
  const idxs = bars.map((b, i) => i).filter(i => day(bars[i]) >= t.buy_date && day(bars[i]) <= t.sell_date && i >= 25);
  if (!idxs.length) { skippedTrades++; continue; }
  for (const i of idxs) {
    const d = bars[i], prev = bars[i - 1];
    const snap = { latestTrade: { p: d.c }, dailyBar: { c: d.c, v: d.v }, prevDailyBar: { c: prev.c } };
    const args = [t.ticker, snap, bars.slice(0, i), null, spyChg[day(d)] ?? 0, 'OTHER'];
    const a = OLD.__s(...args), b = NEW.__s(...args);
    if (!a || !b) continue;
    posDays++;
    const dlt = b.score - a.score;
    deltas[dlt] = (deltas[dlt] || 0) + 1;
    if (dlt !== 0) tradeMoved.add(t.id);
    const k = `${bucket(a.score, OLD_CUTS)} -> ${bucket(b.score, NEW_CUTS)}`;
    moves[k] = (moves[k] || 0) + 1;
    if (bucket(a.score, OLD_CUTS) !== bucket(b.score, NEW_CUTS)) tradeBucketChanged.add(t.id);
  }
}

if (posDays === 0 || droppedSymbols.length === tickers.length + 1) {
  // Never print a rate over nothing: a dead fetch must fail, not report 0 of 0.
  console.error(`FAILED: ${posDays} position-days scored, ${droppedSymbols.length} symbols dropped by the bars fetch -- nothing to report.`);
  process.exit(1);
}
console.log(`position-days scored: ${posDays} (${trades.length - skippedTrades} trades; ${skippedTrades} skipped: no bars or <25 days of history; ${droppedSymbols.length} symbols dropped by the bars fetch)`);
console.log('\n1. SCORE MOVEMENT (new - old), position-days:');
for (const k of Object.keys(deltas).map(Number).sort((x, y) => x - y)) console.log(`  ${String(k).padStart(4)}: ${deltas[k]}  (${(deltas[k] / posDays * 100).toFixed(1)}%)`);
console.log(`  trades with any moved day: ${tradeMoved.size} of ${trades.length - skippedTrades}`);
const changed = Object.entries(moves).filter(([k]) => k.split(' -> ')[0] !== k.split(' -> ')[1]);
const nChanged = changed.reduce((s, [, v]) => s + v, 0);
console.log(`\n2. EXIT-CUTOFF BUCKET CHANGES -- NOISY, not a decision input: ${nChanged} of ${posDays} position-days (${(nChanged / posDays * 100).toFixed(1)}%), on ${tradeBucketChanged.size} trades`);
for (const [k, v] of Object.entries(moves).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(26)} ${v}${k.split(' -> ')[0] !== k.split(' -> ')[1] ? '  *' : ''}`);
