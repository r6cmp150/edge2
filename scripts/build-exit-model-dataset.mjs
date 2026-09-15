#!/usr/bin/env node
// Phase 9 §3.1 — offline dataset for exit-engine Models A/B (§3.2/§3.3).
// NOT training data from trades_v2 (45 rows, a selected sample of what
// Roman chose to buy -- see db/022's corrected header). This is the whole
// eligible universe's actual price history: for every (symbol, day) where
// that symbol traded in Roman's real population ($1-$20), simulate a
// hypothetical entry and record what happened over the next 7 sessions,
// regardless of whether anyone ever bought it. Base rates need a
// population, not a sample of decisions already filtered through Roman's
// own judgment.
//
// SURVIVORSHIP (scripts/probe-survivorship-bias.mjs, already run
// 2026-09-02): a symbol that delisted between the window start and today
// never appears in today's active asset list, for every day in the
// window, not just days near its delisting -- and delisting skews toward
// failure in a microcap universe, which is exactly the case the
// cut-losses feature needs to have seen. Same fix as that probe: query
// BOTH status='active' and status='inactive' from /v2/assets, apply the
// SAME exchange+instrument eligibility filter to both (never the
// `tradable` flag -- that's current-day status, the thing under
// question), and use whichever inactive candidates actually have bar
// data in the window (most won't -- Alpaca's historical bars aren't
// retained indefinitely past delisting).
//
// ADJUSTMENT: 'all' throughout, and ONLY 'all' -- unlike fill-outcomes.mjs's
// sell-timing resolution (phase-9-entry-exit-spec.md §1.1), this dataset
// never compares an adjusted series against a raw dollar amount Roman
// actually paid. Every feature and every outcome here is computed within
// one continuous adjustment='all' series, entry to entry+7 -- a split
// inside a window changes the numbers but not their internal consistency,
// so there is no unit mismatch to detect or guard against. If this ever
// changes (e.g. a future feature needs raw fill prices), re-derive the
// guard from §1.1.1, don't assume this file's silence on splits means
// they were overlooked.
//
// OUTPUT: NDJSON (one row object per line) to artifacts/exit-model-dataset/
// rows.ndjson, plus artifacts/exit-model-dataset/summary.json -- NOT
// data/exit-model-dataset.json. artifacts/ is gitignored (see
// probe-survivorship-bias.mjs's own output for precedent): a per-(symbol,
// day) row count in the hundreds of thousands to low millions has no
// business in a committed JSON blob the way data/float-table.json's small
// lookup table does. §3.2/§3.3's model tables -- the aggregated,
// small-enough-to-commit cell tables -- are a SEPARATE, later step,
// explicitly not built by this file (Roman, in review: "No model tables
// until I've seen [the dataset's shape]").
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const YEARS_BACK = Number(process.argv[2]) || 2;
const PRICE_MIN = 1;
const PRICE_MAX = 20;
const FORWARD_SESSIONS = 7;
const LOOKBACK_MIN_BARS = 20; // RSI(14)/MA20 both need this much history before an entry day is usable

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2];
  }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}

function barDate(b) { return (b.t || '').split('T')[0]; }

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
  global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey } };
  global.persist = () => {};

  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.chunk = chunk; global.alpacaGet = alpacaGet; global._coreClient = _coreClient; global.assertPageNotSuspiciouslyFull = assertPageNotSuspiciouslyFull; global.createApiClient = createApiClient; global.sipSafeEndParams = sipSafeEndParams;');
  const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
  eval(clockSrc + '\nglobal.getPT = getPT;');
  const universeSrc = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  eval(universeSrc + '\nglobal._getAssetIndex = _getAssetIndex; global._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._isEligibleInstrument = _isEligibleInstrument; global.ALLOWED_EXCHANGES = ALLOWED_EXCHANGES; global._shiftDateStr = _shiftDateStr;');
  const indicatorsSrc = readFileSync(path.join(REPO_ROOT, 'core', 'indicators.js'), 'utf8');
  eval(indicatorsSrc + '\nglobal.calcRSI = calcRSI; global.calcMA = calcMA; global.calcAvgVolume = calcAvgVolume;');

  const client = global._coreClient;
  const today = new Date();
  const endDateStr = today.toISOString().slice(0, 10);
  const startDate = new Date(today);
  startDate.setUTCFullYear(startDate.getUTCFullYear() - YEARS_BACK);
  const startDateStr = startDate.toISOString().slice(0, 10);
  console.log(`[dataset] window: ${startDateStr} -> ${endDateStr} (${YEARS_BACK} year(s))`);

  // ── Universe: active-eligible + inactive-with-data (survivorship fix) ──
  const t0 = Date.now();
  const assetIndex = await global._getAssetIndex(client);
  const activeEligible = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);
  console.log(`[dataset] active-eligible: ${activeEligible.length} symbols`);

  const inactiveRaw = await global.alpacaGet('/v2/assets', { status: 'inactive', asset_class: 'us_equity' }, 'https://paper-api.alpaca.markets');
  const inactiveCandidatesRaw = inactiveRaw
    .filter(a => global.ALLOWED_EXCHANGES.has(a.exchange) && global._isEligibleInstrument(a))
    .map(a => a.symbol);
  // Same letters-only-<=5-chars filter as probe-survivorship-bias.mjs, same
  // reason: Alpaca's inactive-asset list includes CUSIP-like codes and
  // CVR/_DELISTED placeholders that 400 an entire 90-symbol chunk.
  const inactiveCandidates = inactiveCandidatesRaw.filter(sym => /^[A-Z]{1,5}$/.test(sym));
  console.log(`[dataset] inactive candidate pool: ${inactiveCandidatesRaw.length} raw, ${inactiveCandidates.length} after ticker-shape filter`);

  const allSymbols = [...new Set([...activeEligible, ...inactiveCandidates])];
  console.log(`[dataset] combined candidate universe: ${allSymbols.length} symbols -- fetching ${YEARS_BACK}-year daily bars (adjustment=all)...`);

  const { barsBySymbol, requests } = await global._fetchHistoricalDailyBars(allSymbols, startDateStr, endDateStr, client, 'all');
  const symbolsWithData = Object.keys(barsBySymbol).filter(s => (barsBySymbol[s] || []).length > 0);
  console.log(`[dataset] bars fetched: ${requests} Alpaca request(s), ${symbolsWithData.length}/${allSymbols.length} symbols with any data, ${Math.round((Date.now() - t0) / 1000)}s elapsed`);

  // ── Truncation check: assertPageNotSuspiciouslyFull flagged 2 chunks as
  // "close to the 10000-row page ceiling with no next_page_token" -- a
  // shape that could mean silent truncation (CLAUDE.md's own pagination
  // rule) or could just mean those 90 symbols happened to have that much
  // real history. An ACTIVE (not delisted) symbol's data should span
  // close to the full window; if any active symbol's last bar is
  // suspiciously far before windowEnd, that's truncation, not coincidence.
  const activeEligibleSet = new Set(activeEligible);
  const windowEndMinus30 = new Date(new Date(endDateStr + 'T00:00:00Z').getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const suspiciousActiveSymbols = [];
  for (const symbol of symbolsWithData) {
    if (!activeEligibleSet.has(symbol)) continue; // delisted candidates are EXPECTED to stop early
    const bars = barsBySymbol[symbol];
    const lastDate = barDate(bars[bars.length - 1]);
    if (lastDate < windowEndMinus30) suspiciousActiveSymbols.push({ symbol, lastDate, barCount: bars.length });
  }
  console.log(`[dataset] truncation check: ${suspiciousActiveSymbols.length}/${symbolsWithData.length} active symbols have their last bar >30 days before window end (${windowEndMinus30})`);
  if (suspiciousActiveSymbols.length) {
    console.log('[dataset] suspicious active symbols (sample):', JSON.stringify(suspiciousActiveSymbols.slice(0, 15)));
  }

  // ── Simulate every (symbol, entry_day) pair in the $1-$20 band ──
  const outDir = path.join(REPO_ROOT, 'artifacts', 'exit-model-dataset');
  mkdirSync(outDir, { recursive: true });
  const rowsPath = path.join(outDir, 'rows.ndjson');
  const out = createWriteStream(rowsPath, { flags: 'w' });

  let rowCount = 0;
  let minDate = null, maxDate = null;
  const symbolsWithRows = new Set();
  let skippedShortHistory = 0, skippedOutOfBand = 0;

  for (const symbol of symbolsWithData) {
    const bars = [...barsBySymbol[symbol]].sort((a, b) => new Date(a.t) - new Date(b.t));
    if (bars.length < LOOKBACK_MIN_BARS + FORWARD_SESSIONS + 1) { skippedShortHistory++; continue; }

    for (let i = LOOKBACK_MIN_BARS; i <= bars.length - 1 - FORWARD_SESSIONS; i++) {
      const entry = bars[i];
      const entryClose = entry.c;
      if (entryClose == null || entryClose < PRICE_MIN || entryClose > PRICE_MAX) { skippedOutOfBand++; continue; }

      const closesToEntry = bars.slice(0, i + 1).map(b => b.c);
      const volumesToEntry = bars.slice(0, i + 1).map(b => b.v);
      const rsi14 = global.calcRSI(closesToEntry);
      const ma20 = global.calcMA(closesToEntry, 20);
      const pctFromMa20 = ma20 > 0 ? ((entryClose - ma20) / ma20) * 100 : null;
      const avgVol20 = global.calcAvgVolume(volumesToEntry, 20);
      const volRatio = avgVol20 > 0 ? (entry.v / avgVol20) : null;

      const forward = {};
      let runningLow = null;
      let maxClose = null, maxCloseDay = null;
      for (let d = 1; d <= FORWARD_SESSIONS; d++) {
        const bar = bars[i + d];
        const prevBar = bars[i + d - 1];
        runningLow = runningLow == null ? bar.l : Math.min(runningLow, bar.l);
        const ret = (bar.c - entryClose) / entryClose;
        const drawdown = (runningLow - entryClose) / entryClose;
        const lowerLow = prevBar.l != null && bar.l != null ? bar.l < prevBar.l : null;
        forward[`d${d}`] = { ret, drawdown, lowerLow };
        if (bar.c != null && (maxClose == null || bar.c > maxClose)) { maxClose = bar.c; maxCloseDay = d; }
      }

      const date = barDate(entry);
      if (minDate == null || date < minDate) minDate = date;
      if (maxDate == null || date > maxDate) maxDate = date;
      symbolsWithRows.add(symbol);
      rowCount++;

      out.write(JSON.stringify({
        symbol, date, entryClose, rsi14, volRatio, pctFromMa20,
        forward, maxClose, maxCloseDay,
      }) + '\n');
    }
  }
  await new Promise((resolve) => out.end(resolve));

  const summary = {
    builtAt: new Date().toISOString(),
    windowStart: startDateStr, windowEnd: endDateStr, yearsBack: YEARS_BACK,
    priceMin: PRICE_MIN, priceMax: PRICE_MAX, forwardSessions: FORWARD_SESSIONS,
    activeEligibleSymbolCount: activeEligible.length,
    inactiveCandidateSymbolCount: inactiveCandidates.length,
    combinedCandidateSymbolCount: allSymbols.length,
    symbolsWithAnyBarData: symbolsWithData.length,
    symbolsSkippedShortHistory: skippedShortHistory,
    rowCount,
    dateCoverage: { min: minDate, max: maxDate },
    distinctSymbolCountInRows: symbolsWithRows.size,
    skippedOutOfPriceBand: skippedOutOfBand,
    rowsFile: 'artifacts/exit-model-dataset/rows.ndjson',
  };
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n[dataset] === SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[dataset] FAILED —', err.message, err.stack);
  process.exit(1);
});
