// scripts/measure-gate-buyable.mjs -- buyable signals per day under the
// proposed trailing-volume liquidity gate vs the live IEX-today pre-filter
// (phase-10 spec §7.6 step 1f: design, THEN this measurement, then the
// number).
//
//   node scripts/measure-gate-buyable.mjs
//
// For each pinned date and scan time it rebuilds, for every universe symbol,
// the inputs scoreStock would have seen live: the IEX snapshot (price and
// volume so far, or yesterday's bar if no regular-session IEX trade yet), the
// IEX daily history including TODAY'S PARTIAL BAR (585 of 676 logged
// snapshots include it), SPY's change, category OTHER, no news, no macro.
// Every symbol is scored once with the current formula (working tree), then
// counted inside each pool:
//   live      price $1-$20 and IEX volume so far >= 100k (today's rule)
//   floor F   price $1-$20 and 20-completed-session SIP average >= F
//
// VALIDATED FIRST: real logged scans (scan_runs + the signal_log backup at
// DATA_REV) are re-scored with the formula they actually ran (OLD_REV), and
// the rebuilt scores are compared with the logged ones. If they don't match,
// the counts below mean little, and it says so.
// Read-only requests: Alpaca bars (paginated to exhaustion) and Supabase
// scan_runs (anon select).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { edgeUniverse, alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = alpacaHeaders(ROOT);
const UNIVERSE = edgeUniverse(ROOT);
const DATA_REV = 'de95a93', OLD_REV = 'b63ef1b';   // signal_log backup; the v1 formula those scans ran
const DATES = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21'];
const TIMES_PT = ['07:00', '07:30', '10:00', '12:00'];
const FLOORS = [100e3, 250e3, 500e3, 1e6, 2e6];
const LOOKBACK = 20, PDT_H = 7, MIN_PRICE = 1, MAX_PRICE = 20, LIVE_MIN_VOL = 100000;
const ptToUtc = (date, hhmm) => Date.parse(`${date}T${hhmm}:00Z`) + PDT_H * 3600e3;

const read = f => readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
function scorer(src) {
  const c = { console, Math, Date, JSON, Number, String, Array, Object, Infinity, NaN, isFinite, state: { settings: { disableMacroOverlay: false }, macroContext: null } };
  vm.createContext(c);
  for (const f of ['core/indicators.js', 'core/market-data.js']) vm.runInContext(strip(read(f)), c);
  vm.runInContext(strip(src) + '\n;globalThis.__s = scoreStock; globalThis.__t = typeof scoreThresholds === "function" ? scoreThresholds() : null;', c);
  return c;
}
const NEW = scorer(read('core/edge-scoring.js'));
const OLD = scorer(execSync(`git show ${OLD_REV}:core/edge-scoring.js`, { cwd: ROOT, maxBuffer: 1e8 }).toString());
const LINES = NEW.__t;   // the current version's own thresholds, not literals

const day = b => b.t.slice(0, 10);
const syms = [...UNIVERSE, 'SPY'];
const iexDaily = await fetchBars(H, syms, { timeframe: '1Day', start: '2026-04-01', end: '2026-10-21', feed: 'iex', adjustment: 'all' });
const sipDaily = await fetchBars(H, UNIVERSE, { timeframe: '1Day', start: '2026-08-01', end: '2026-10-21', feed: 'sip', adjustment: 'all' });
const iexMin = {};
for (const d of DATES) iexMin[d] = await fetchBars(H, syms, { timeframe: '1Min', start: `${d}T08:00:00Z`, end: `${d}T19:30:00Z`, feed: 'iex' });

function trailingAvg(sym, d) {
  const prior = (sipDaily[sym] || []).filter(b => day(b) < d);
  if (prior.length < LOOKBACK) return null;
  return prior.slice(-LOOKBACK).reduce((s, b) => s + b.v, 0) / LOOKBACK;
}
// The live inputs for one symbol at instant T on date d.
function liveInputs(sym, d, T) {
  // the live window: fetchMultiBars starts 180 calendar days back (125 bars incl. today)
  const from180 = new Date(Date.parse(d + 'T00:00:00Z') - 180 * 864e5).toISOString().slice(0, 10);
  const hist = (iexDaily[sym] || []).filter(b => day(b) < d && day(b) >= from180);
  const prev = hist[hist.length - 1];
  const open = ptToUtc(d, process.env.TODAY_BAR_FROM || '06:30'); // when the live dailyBar starts counting today's trades
  const today = (iexMin[d][sym] || []).filter(b => { const t = Date.parse(b.t); return t >= open && t <= T; });
  if (!today.length) {   // snapshot still on yesterday's bar; history has no partial today
    if (!prev) return null;
    return { price: prev.c, vol: prev.v, prevClose: hist[hist.length - 2]?.c ?? prev.c, bars: hist };
  }
  const partial = { t: `${d}T04:00:00Z`, o: today[0].o, h: Math.max(...today.map(b => b.h)), l: Math.min(...today.map(b => b.l)), c: today[today.length - 1].c, v: today.reduce((s, b) => s + b.v, 0) };
  return { price: partial.c, vol: partial.v, prevClose: prev?.c ?? partial.o, bars: [...hist, partial] };
}
function spyChange(d, T) { const x = liveInputs('SPY', d, T); return x ? (x.price / x.prevClose - 1) * 100 : 0; }
// macro: the scan-wide condition the live scan applied (null = none); category
// as logged (OTHER for this universe).
function scoreFull(ctx, sym, x, spy, macro = null, category = 'OTHER') {
  ctx.state.macroContext = macro ? { condition: macro, changes: null } : null;
  const snap = { latestTrade: { p: x.price }, dailyBar: { c: x.price, v: x.vol }, prevDailyBar: { c: x.prevClose } };
  return ctx.__s(sym, snap, x.bars, null, spy, category);
}
function score(ctx, sym, x, spy, macro = null, category = 'OTHER') { const r = scoreFull(ctx, sym, x, spy, macro, category); return r ? r.score : null; }

// ── validation against real logged scans (v1 formula) ──
const SUPA_KEY = read('core/store.js').match(/sb_publishable_[A-Za-z0-9_]+/)[0];
const runs = await (await fetch(`https://kbjqxaukyawcmcyjoiey.supabase.co/rest/v1/scan_runs?engine_source=eq.EDGE&session=eq.OPEN&scan_date=gte.${DATES[0]}&scan_date=lte.${DATES[DATES.length - 1]}&select=id,scan_date,started_at`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } })).json();
const sl = JSON.parse(execSync(`git show ${DATA_REV}:data/backups/signal_log.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString());
const slRows = (Array.isArray(sl) ? sl : sl.rows).filter(r => r.engine_source === 'EDGE' && r.signal_snapshot?.score != null);
let compared = 0, exact = 0, absDiff = 0; const mismatch = {}; const examples = [];
const OPEN_GRACE_MS = 2 * 60e3;
let openCompared = 0, openExact = 0;
for (const run of runs) {
  const T = Date.parse(run.started_at);
  const atOpen = T - ptToUtc(run.scan_date, '06:30') < OPEN_GRACE_MS;
  const spy = spyChange(run.scan_date, T);
  for (const r of slRows.filter(r => r.scan_session === run.id)) {
    const x = liveInputs(r.signal_snapshot.ticker, run.scan_date, T);
    if (!x) continue;
    const o = r.signal_snapshot;
    const full = scoreFull(OLD, o.ticker, x, spy, o.macroCondition || null, o.category || 'OTHER');
    if (!full) continue;
    const s = full.score;
    if (atOpen) { openCompared++; if (s === o.score) openExact++; continue; }
    compared++; if (s === o.score) exact++; absDiff += Math.abs(s - o.score);
    if (s !== o.score) {
      const lb = o.bars?.length ? o.bars[o.bars.length - 1] : null, rb = x.bars[x.bars.length - 1];
      const reasons = [];
      if (Math.abs(full.price - o.price) / o.price > 0.002) reasons.push('price');
      if (Math.abs((full.volRatio ?? 0) - (o.volRatio ?? 0)) > 0.05) reasons.push('volRatio');
      if (Math.abs((full.rsi ?? 0) - (o.rsi ?? 0)) > 0.5) reasons.push('rsi');
      if (Math.abs((full.spyChange ?? 0) - (o.spyChange ?? 0)) > 0.05) reasons.push('spy');
      if (lb && rb && lb.t.slice(0, 10) !== rb.t.slice(0, 10)) reasons.push('lastBarDate');
      if ((full.consUpDays ?? -1) !== (o.consUpDays ?? -1)) reasons.push('consUpDays');
      if (!reasons.length) reasons.push('other');
      for (const k of reasons) mismatch[k] = (mismatch[k] || 0) + 1;
      if (process.env.DIAG && examples.length < 8) examples.push(`${run.scan_date} ${new Date(T - PDT_H * 3600e3).toISOString().slice(11, 16)} ${o.ticker}: score logged ${o.score} rebuilt ${s} | last bar logged ${lb?.t.slice(0, 10)} (n=${o.bars?.length}) rebuilt ${rb?.t.slice(0, 10)} (n=${x.bars.length}) | price ${o.price} vs ${full.price} | spy ${o.spyChange?.toFixed(2)} vs ${full.spyChange?.toFixed(2)} | [${reasons}]`);
    }
  }
}
console.log(`universe ${UNIVERSE.length}; dates ${DATES[0]}..${DATES[DATES.length - 1]}; current lines WATCH ${LINES.watch} / SOFT ${LINES.soft} / STRONG ${LINES.strong}`);
examples.forEach(e => console.log('    ' + e));
console.log(`  mismatched inputs (a mismatch can have several): ${JSON.stringify(mismatch)}`);
console.log(`  scans in the first 2 minutes after the open, scored apart (live snapshot may still hold yesterday's bar): ${openExact} of ${openCompared} exact`);
console.log(`VALIDATION (excluding those): re-scored ${compared} logged signals (${runs.length} logged scans, formula ${OLD_REV}): exact ${exact} (${(exact / compared * 100).toFixed(0)}%), mean |diff| ${(absDiff / compared).toFixed(1)} points${absDiff / compared > 5 ? '  !! the rebuild does not reproduce live scores well; read the counts below with that in mind' : ''}`);

// ── buyable per day ──
const macroByDate = {};
for (const d of DATES) {
  const c = {}; for (const r of slRows.filter(r => r.signal_date === d)) { const m = r.signal_snapshot.macroCondition || 'none'; c[m] = (c[m] || 0) + 1; }
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  macroByDate[d] = top && top[0] !== 'none' ? top[0] : null;
}
console.log(`macro condition per date (as logged): ${JSON.stringify(macroByDate)}`);
console.log(`\nBUYABLE (score >= ${LINES.soft}) per scan, median over ${DATES.length} dates [per date]; pool size in ( )`);
const header = ['live'].concat(FLOORS.map(f => `${f / 1e3}k avg`));
console.log('  time PT   ' + header.map(h => h.padEnd(26)).join(''));
const dayUnion = header.map(() => DATES.map(() => new Set()));
for (const hhmm of TIMES_PT) {
  const perPool = header.map(() => ({ buy: [], pool: [] }));
  for (const d of DATES) {
    const T = ptToUtc(d, hhmm), spy = spyChange(d, T);
    const counts = header.map(() => ({ buy: 0, pool: 0 }));
    for (const sym of UNIVERSE) {
      const x = liveInputs(sym, d, T);
      if (!x || !(x.price >= MIN_PRICE && x.price <= MAX_PRICE)) continue;
      const inPool = [x.vol >= LIVE_MIN_VOL, ...FLOORS.map(f => { const a = trailingAvg(sym, d); return a != null && a >= f; })];
      if (!inPool.some(Boolean)) continue;
      const s = score(NEW, sym, x, spy, macroByDate[d]);
      inPool.forEach((ok, i) => { if (ok) { counts[i].pool++; if (s != null && s >= LINES.soft) { counts[i].buy++; dayUnion[i][DATES.indexOf(d)].add(sym); } } });
    }
    counts.forEach((c, i) => { perPool[i].buy.push(c.buy); perPool[i].pool.push(c.pool); });
  }
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`  ${hhmm}     ` + perPool.map(p => `${String(med(p.buy)).padStart(3)} (${String(med(p.pool)).padStart(3)}) [${p.buy.join(',')}]`.padEnd(26)).join(''));
}
{
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const tot = header.map((_, i) => dayUnion[i].map(set => set.size));
  console.log('  PER DAY  ' + tot.map(v => `${String(med(v)).padStart(3)} [${v.join(',')}] total ${v.reduce((x, y) => x + y, 0)}`.padEnd(26)).join(''));
  console.log(`  (PER DAY = distinct symbols buyable at any of ${TIMES_PT.join(', ')} PT; the spec's "106 over 19 dates" counts distinct buyable signals per date the same way)`);
}
