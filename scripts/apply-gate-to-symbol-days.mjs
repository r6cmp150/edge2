#!/usr/bin/env node
// Applies a RETROACTIVE, daily-bar-only approximation of the 5 Pillars
// gate (engines/warrior/gate.js) to a symbol-day list already selected
// by reconstructTopMoversUniverse, and re-cuts that run's per-setup
// summary table down to gate survivors only.
//
// WHY THIS MATTERS (2026-09-02): the universe was reconstructed movers,
// never gated. In Ross's method the gate is what makes the setups mean
// anything -- a HOD break on a stock with no catalyst and ordinary
// volume is not the trade he's describing. This measures how many of
// the symbol-days that reached replay would have actually cleared the
// gate.
//
// FOUR PILLARS, FLOAT NOT-CHECKED (float is Phase 6, unavailable --
// same three-state design the app already uses: pass / fail /
// not-checked, never fabricated as a pass). classifyGate's own logic
// (ported verbatim from gate.js) never puts float in the substantive
// set either way, so this omission changes nothing about how survival
// is computed, only what's displayed.
//
// TWO PILLARS ARE APPROXIMATIONS, NOT EXACT REPLAYS, AND BOTH LEAN
// GENEROUS (more likely to pass than the live gate would be) -- named
// explicitly so a survivor count isn't read as tighter than it is:
//   - CHANGE: gate.js checks live intraday (often premarket) gap%.
//     Only daily bars exist here, so this uses day D's own close-vs-
//     prior-close %, a full-session change, not a premarket gap. A
//     name that gapped 12% at the open and gave half of it back by
//     the close would show under 10% here and fail a pillar the live
//     gate would have already passed at 9:30am.
//   - RVOL: gate.js's exact formula needs an intraday elapsed-minutes
//     snapshot and cumulative volume AT that snapshot -- unavailable
//     without minute bars. Approximated as day D's FULL-DAY volume
//     over the trailing 30-day average, same >=5.0x threshold. Always
//     >= any partial-day cumulative figure, so this can only ever be
//     easier to clear than the live mid-session check, never harder.
// PRICE uses day D's own close (exact, no approximation). NEWS is a
// real historical query against Alpaca's /news endpoint (verified
// live to support historical date ranges), 24h before day D's regular
// session open -- the same lookback the live gate uses, just anchored
// to a historical instant instead of "now."
//
// Bars are fetched ONLY for the symbols this specific symbol-day list
// needs (not the full ~5,711-symbol eligible universe) -- reuses
// core/universe.js's _fetchHistoricalDailyBars and _rankTopMovers
// (unlagged mode, topN effectively unbounded) exactly as already
// written, not a parallel reimplementation of the day-over-day/relVol
// math.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node scripts/apply-gate-to-symbol-days.mjs <path-to-run-artifact-dir>');
  process.exit(1);
}

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2];
  }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}

const PRICE_MIN = 1.00, PRICE_MAX = 20.00;
const CHANGE_MIN_PCT = 10;
const RVOL_MIN = 5.0;
const NEWS_MAX_AGE_HOURS = 24;

// classifyGate, ported verbatim from engines/warrior/gate.js -- same
// two-stage logic (free pillars gate stage 2, never a plain fail-count),
// so "QUALIFIED" here means exactly what it means in the live app.
function classifyGate(pillars) {
  const byId = {};
  pillars.forEach(p => { byId[p.id] = p; });
  const freePillarsPass = byId.price.status === 'pass' && byId.change.status === 'pass';
  if (!freePillarsPass) return null;
  const substantive = [byId.rvol, byId.news].filter(p => p.status !== 'not-checked');
  const substantiveFailed = substantive.filter(p => p.status === 'fail');
  if (substantiveFailed.length === 0 && substantive.length > 0) return 'QUALIFIED';
  if (substantiveFailed.length === 1) return 'NEAR_MISS';
  return null;
}

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
  global.state = {};
  global.persist = () => {};
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  const realAlpacaGet = async (urlPath, params = {}, base = 'https://data.alpaca.markets/v2') => {
    const url = new URL(base + urlPath);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': alpacaKeyId, 'APCA-API-SECRET-KEY': alpacaSecretKey } });
    if (!res.ok) throw new Error(`${urlPath}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  global.alpacaGet = realAlpacaGet;
  global._coreClient = { alpacaGet: realAlpacaGet };

  const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
  eval(clockSrc + '\nglobal.getPT = getPT; global.ptWallClockToInstant = ptWallClockToInstant;');
  const universeSrc = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  eval(universeSrc + '\nglobal._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._rankTopMovers = _rankTopMovers; global._shiftDateStr = _shiftDateStr;');

  const universe = JSON.parse(readFileSync(path.join(runDir, 'universe.json'), 'utf8'));
  const targetSymbolDays = universe.symbolDays.map(r => ({ date: r.date, symbol: r.symbol }));
  const targetKey = (d, s) => `${d}|${s}`;
  const targetSet = new Set(targetSymbolDays.map(r => targetKey(r.date, r.symbol)));
  const symbols = [...new Set(targetSymbolDays.map(r => r.symbol))];
  const dates = [...new Set(targetSymbolDays.map(r => r.date))].sort();
  console.log(`[apply-gate] ${targetSymbolDays.length} symbol-days, ${symbols.length} unique symbols, ${dates.length} trading days`);

  // ── Day D's own change%/volume (NOT the lagged run's selection metric) ──
  const startDate = dates[0], endDate = dates[dates.length - 1];
  const fetchStart = global._shiftDateStr(startDate, -60); // same 60-day pad as the original reconstruction, for a valid 30-day relVol lookback near the range's start
  const t0 = Date.now();
  const { barsBySymbol, requests: barRequests } = await global._fetchHistoricalDailyBars(symbols, fetchStart, endDate, global._coreClient);
  const ownMetricRows = global._rankTopMovers(barsBySymbol, startDate, endDate, 999999, { lagSelectionByOneDay: false });
  const ownMetricsByKey = new Map();
  for (const row of ownMetricRows) ownMetricsByKey.set(targetKey(row.date, row.symbol), row);
  const targetsWithOwnMetrics = targetSymbolDays.filter(r => ownMetricsByKey.has(targetKey(r.date, r.symbol))).length;
  console.log(`[apply-gate] day-D's-own metrics: ${barRequests} requests, ${Math.round((Date.now() - t0) / 1000)}s, ${ownMetricsByKey.size} total qualifying rows across all fetched symbols, ${targetsWithOwnMetrics} of ${targetSymbolDays.length} TARGET symbol-days matched (rest lack a valid prior close or fell outside $1-$20 on their own close, so price/change fail below rather than being fabricated)`);

  // ── Historical news, batched per trading day (24h before that day's open) ──
  const t1 = Date.now();
  let newsRequests = 0;
  const newsByDateSymbol = new Map(); // `${date}|${symbol}` -> most recent headline within window, or null
  for (const date of dates) {
    const daySymbols = [...new Set(targetSymbolDays.filter(r => r.date === date).map(r => r.symbol))];
    const openInstant = global.ptWallClockToInstant(date, 6, 30);
    const startInstant = new Date(openInstant.getTime() - NEWS_MAX_AGE_HOURS * 3600 * 1000);
    for (const batch of global.chunk(daySymbols, 100)) {
      try {
        let pageToken;
        const items = [];
        do {
          const params = { symbols: batch.join(','), start: startInstant.toISOString(), end: openInstant.toISOString(), limit: 50, sort: 'desc' };
          if (pageToken) params.page_token = pageToken;
          const data = await global.alpacaGet('/news', params, 'https://data.alpaca.markets/v1beta1');
          newsRequests++;
          items.push(...(data.news || []));
          pageToken = data.next_page_token || null;
        } while (pageToken);
        for (const sym of batch) {
          const hit = items.find(n => (n.symbols || []).includes(sym));
          newsByDateSymbol.set(targetKey(date, sym), hit ? hit.headline : null);
        }
      } catch (e) {
        console.warn(`[apply-gate] news batch error for ${date}: ${e.message}`);
      }
    }
  }
  console.log(`[apply-gate] news: ${newsRequests} requests, ${Math.round((Date.now() - t1) / 1000)}s`);

  // ── Gate each symbol-day ──
  const results = [];
  for (const { date, symbol } of targetSymbolDays) {
    const own = ownMetricsByKey.get(targetKey(date, symbol));
    const priceVal = own ? own.close : null;
    const changeVal = own ? own.dayOverDayPct * 100 : null; // own.dayOverDayPct is a fraction (0.12 = 12%); pillar threshold is in percent
    const relVolVal = own ? own.relVol : null;
    const headline = newsByDateSymbol.get(targetKey(date, symbol));

    const pricePillar = { id: 'price', status: (typeof priceVal === 'number' && priceVal >= PRICE_MIN && priceVal <= PRICE_MAX) ? 'pass' : 'fail', value: priceVal };
    const changePillar = { id: 'change', status: (typeof changeVal === 'number' && changeVal >= CHANGE_MIN_PCT) ? 'pass' : 'fail', value: changeVal };
    const freePass = pricePillar.status === 'pass' && changePillar.status === 'pass';
    const rvolPillar = !freePass
      ? { id: 'rvol', status: 'not-checked', value: null }
      : (typeof relVolVal === 'number' ? { id: 'rvol', status: relVolVal >= RVOL_MIN ? 'pass' : 'fail', value: relVolVal } : { id: 'rvol', status: 'not-checked', value: null });
    const newsPillar = !freePass
      ? { id: 'news', status: 'not-checked', value: null }
      : { id: 'news', status: headline ? 'pass' : 'fail', value: headline };

    const tier = classifyGate([pricePillar, changePillar, rvolPillar, newsPillar]);
    results.push({ date, symbol, tier, pillars: { price: pricePillar, change: changePillar, rvol: rvolPillar, news: newsPillar } });
  }

  const qualified = results.filter(r => r.tier === 'QUALIFIED');
  const nearMiss = results.filter(r => r.tier === 'NEAR_MISS');
  const disqualified = results.filter(r => r.tier === null);
  console.log(`[apply-gate] QUALIFIED: ${qualified.length} / ${results.length} (${(100 * qualified.length / results.length).toFixed(1)}%)`);
  console.log(`[apply-gate] NEAR_MISS: ${nearMiss.length} | disqualified: ${disqualified.length}`);
  const failReasonCounts = {};
  for (const r of disqualified.concat(nearMiss)) {
    for (const id of ['price', 'change', 'rvol', 'news']) {
      if (r.pillars[id].status === 'fail') failReasonCounts[id] = (failReasonCounts[id] || 0) + 1;
    }
  }
  console.log('[apply-gate] fail counts by pillar (among non-QUALIFIED):', JSON.stringify(failReasonCounts));

  // ── Re-cut the run's triggers to QUALIFIED symbol-days only ──
  const triggers = JSON.parse(readFileSync(path.join(runDir, 'triggers.json'), 'utf8'));
  const qualifiedSet = new Set(qualified.map(r => targetKey(r.date, r.symbol)));
  const gatedTriggers = triggers.filter(t => qualifiedSet.has(targetKey(t.date, t.symbol)));
  console.log(`[apply-gate] triggers before gate: ${triggers.length} -> after (QUALIFIED symbol-days only): ${gatedTriggers.length}`);

  const outPath = path.join(runDir, 'gate_results.json');
  writeFileSync(outPath, JSON.stringify({ results, qualifiedCount: qualified.length, nearMissCount: nearMiss.length, disqualifiedCount: disqualified.length, totalSymbolDays: results.length }, null, 2));
  const gatedTriggersPath = path.join(runDir, 'triggers_gated.json');
  writeFileSync(gatedTriggersPath, JSON.stringify(gatedTriggers, null, 2));
  console.log(`[apply-gate] wrote ${outPath} and ${gatedTriggersPath}`);
}

main().catch((err) => {
  console.error('[apply-gate] FAILED —', err.message, err.stack);
  process.exit(1);
});
