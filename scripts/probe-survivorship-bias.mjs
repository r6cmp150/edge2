#!/usr/bin/env node
// Survivorship-bias probe (2026-09-02 chat): /v2/assets with status='active'
// (what reconstructTopMoversUniverse actually calls) only ever returns
// TODAY'S listed symbols -- there is no point-in-time query. Any symbol
// that delisted, went to zero, or was acquired between the widened scan's
// start date and today never enters the ranking at all, for every day in
// the range, not just the days near its delisting. Over a 63-day window
// that's a small effect; over the ~378-trading-day widened window just
// launched, it isn't -- and it's directionally the same as the selection
// lookahead already removed this session: excluding names that later
// failed removes bad outcomes and inflates measured returns. This is a
// microcap universe, where delisting is not rare.
//
// Measures rather than caveats: pulls status='inactive' from the SAME
// /v2/assets endpoint (verified live, 2026-09-02, to accept it -- 200,
// 19,187 rows, a plain unpaginated array same as the active call), applies
// the SAME exchange + instrument-name eligibility filter reconstructTop-
// MoversUniverse already applies to the active list (NOT the `tradable`
// flag -- that's current-day status, exactly what's under question here;
// a symbol delisted in 2026 was tradable for most of an 18-month window
// that started in 2025), fetches historical daily bars for the resulting
// 1,712-symbol candidate pool over the SAME widened range, and re-ranks
// the COMBINED (active ∪ once-tradable-now-delisted) pool at topN=10,
// lagged -- the same selection rule the widened scan is running under.
// Reports how many symbol-day slots in that combined ranking belong to a
// symbol absent from today's active list, and how many currently-active
// symbol-days get DISPLACED as a result (composition changes, not just
// net addition, since ranking is comparative).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const START_DATE = process.argv[2] || '2025-02-28';
const END_DATE = process.argv[3] || '2026-08-28';

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2];
  }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
  global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey } };
  global.persist = () => {};
  // core/api-client.js's real queue (2026-09-02 fix), not a hand-rolled
  // fetch — the previous bare fetch used here (and by every other driver
  // script) had no 429 retry/backoff or concurrency limit, which is what
  // produced this probe's first two (discarded) runs: the inactive-symbol
  // bar fetch got rate-limited into returning zero data, silently.
  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.chunk = chunk; global.alpacaGet = alpacaGet; global._coreClient = _coreClient; global.assertPageNotSuspiciouslyFull = assertPageNotSuspiciouslyFull; global.createApiClient = createApiClient; global.sanitizeTickerBatch = sanitizeTickerBatch;');

  const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
  eval(clockSrc + '\nglobal.getPT = getPT; global.ptWallClockToInstant = ptWallClockToInstant;');
  const universeSrc = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  eval(universeSrc + '\nglobal._getAssetIndex = _getAssetIndex; global._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._rankTopMovers = _rankTopMovers; global._shiftDateStr = _shiftDateStr; global._isEligibleInstrument = _isEligibleInstrument; global.ALLOWED_EXCHANGES = ALLOWED_EXCHANGES;');

  const fetchStartDateStr = global._shiftDateStr(START_DATE, -60);

  // ── Active-eligible pool (exactly what reconstructTopMoversUniverse uses today) ──
  const t0 = Date.now();
  const assetIndex = await global._getAssetIndex(global._coreClient);
  const activeEligible = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);
  console.log(`[survivorship] active-eligible pool: ${activeEligible.length} symbols`);

  // ── Inactive candidate pool: status='inactive', SAME exchange+name filter, NOT `tradable` (current-day status is exactly what's under question) ──
  const inactiveRaw = await global.alpacaGet('/v2/assets', { status: 'inactive', asset_class: 'us_equity' }, 'https://paper-api.alpaca.markets');
  console.log(`[survivorship] inactive us_equity (all exchanges, raw): ${inactiveRaw.length}`);
  const inactiveCandidatesRaw = inactiveRaw
    .filter(a => global.ALLOWED_EXCHANGES.has(a.exchange) && global._isEligibleInstrument(a))
    .map(a => a.symbol);
  // Alpaca's inactive-asset list includes non-ticker "symbol" values --
  // CUSIP-like codes, contingent-value-right/"CVR" entries, explicit
  // "_DELISTED" placeholders -- that 400 the ENTIRE 90-symbol chunk
  // containing them (same whole-batch-rejects-on-one-bad-symbol behavior
  // core/market-data.js already documents for /stocks/snapshots).
  // sanitizeTickerBatch's charset regex (letters+digits) doesn't catch
  // these -- a CUSIP like "67012E104" IS a valid [A-Z0-9]+ string, it's
  // just not a ticker. Real NASDAQ/NYSE/AMEX common-stock tickers are
  // letters-only, <=5 chars (verified against the real inactive-asset
  // response, 2026-09-02: this drops 498/1712 non-ticker codes -- CUSIPs,
  // CVR/CSH/_DELISTED placeholders -- while keeping plausible real
  // tickers like VER, JTPY, CVON). A disclosed simplification, not a
  // load-bearing precision requirement: a small number of genuine
  // digit-containing historical tickers could be dropped along with the
  // noise, understating this measurement slightly, never overstating it.
  const inactiveCandidates = inactiveCandidatesRaw.filter(sym => /^[A-Z]{1,5}$/.test(sym));
  console.log(`[survivorship] inactive candidate pool (ALLOWED_EXCHANGES + isEligibleInstrument, tradable flag ignored on purpose): ${inactiveCandidatesRaw.length} symbols, ${inactiveCandidates.length} after letters-only-<=5-chars ticker filter (${inactiveCandidatesRaw.length - inactiveCandidates.length} non-ticker codes dropped — CUSIPs, CVR/CSH/_DELISTED placeholders, etc.)`);

  // ── Fetch bars for BOTH pools over the widened window ──
  const { barsBySymbol: activeBars, requests: activeReq } = await global._fetchHistoricalDailyBars(activeEligible, fetchStartDateStr, END_DATE, global._coreClient);
  console.log(`[survivorship] active bars: ${activeReq} requests, ${Object.keys(activeBars).length} symbols with data, ${Math.round((Date.now() - t0) / 1000)}s elapsed so far`);
  const t1 = Date.now();
  const { barsBySymbol: inactiveBars, requests: inactiveReq } = await global._fetchHistoricalDailyBars(inactiveCandidates, fetchStartDateStr, END_DATE, global._coreClient);
  const inactiveWithData = Object.keys(inactiveBars).filter(sym => (inactiveBars[sym] || []).length > 0);
  console.log(`[survivorship] inactive bars: ${inactiveReq} requests, ${inactiveWithData.length}/${inactiveCandidates.length} symbols with ANY bar data in the window (rest delisted before the window opened or never had data here), ${Math.round((Date.now() - t1) / 1000)}s`);

  // ── Re-rank: active-only (today's real pipeline) vs combined (active ∪ once-tradable-now-delisted) ──
  const activeOnlyRows = global._rankTopMovers(activeBars, START_DATE, END_DATE, 10, { lagSelectionByOneDay: true });
  const combinedBars = { ...activeBars, ...inactiveBars };
  const combinedRows = global._rankTopMovers(combinedBars, START_DATE, END_DATE, 10, { lagSelectionByOneDay: true });

  const key = (r) => `${r.date}|${r.symbol}`;
  const activeSymbolSet = new Set(activeEligible);
  const combinedDelistedSlots = combinedRows.filter(r => !activeSymbolSet.has(r.symbol));
  const activeOnlyKeys = new Set(activeOnlyRows.map(key));
  const combinedKeys = new Set(combinedRows.map(key));
  const displaced = activeOnlyRows.filter(r => !combinedKeys.has(key(r)));
  const added = combinedRows.filter(r => !activeOnlyKeys.has(key(r)));

  console.log('');
  console.log('[survivorship] === RESULTS ===');
  console.log(`[survivorship] active-only topN=10 ranking (today's real pipeline): ${activeOnlyRows.length} symbol-days`);
  console.log(`[survivorship] combined (active ∪ delisted-candidate) topN=10 ranking: ${combinedRows.length} symbol-days`);
  console.log(`[survivorship] of the combined ranking, symbol-days occupied by a symbol NOT in today's active list (i.e. later delisted): ${combinedDelistedSlots.length}/${combinedRows.length} (${(100 * combinedDelistedSlots.length / combinedRows.length).toFixed(2)}%)`);
  console.log(`[survivorship] currently-active symbol-days DISPLACED out of topN=10 once delisted candidates are included: ${displaced.length}`);
  console.log(`[survivorship] symbol-days newly entering topN=10 that were absent from the active-only ranking: ${added.length}`);
  const uniqueDelistedSymbolsInRanking = [...new Set(combinedDelistedSlots.map(r => r.symbol))];
  console.log(`[survivorship] unique delisted symbols that appear anywhere in the combined topN=10 ranking: ${uniqueDelistedSymbolsInRanking.length} — ${uniqueDelistedSymbolsInRanking.slice(0, 20).join(', ')}${uniqueDelistedSymbolsInRanking.length > 20 ? ', …' : ''}`);

  const outDir = path.join(REPO_ROOT, 'artifacts', 'survivorship-bias-probe');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'probe_result.json'), JSON.stringify({
    startDate: START_DATE, endDate: END_DATE,
    activeEligibleCount: activeEligible.length,
    inactiveCandidateCount: inactiveCandidates.length,
    inactiveWithDataCount: inactiveWithData.length,
    activeOnlyCount: activeOnlyRows.length,
    combinedCount: combinedRows.length,
    combinedDelistedSlotCount: combinedDelistedSlots.length,
    displacedCount: displaced.length,
    addedCount: added.length,
    uniqueDelistedSymbolsInRanking,
    combinedDelistedSlots,
  }, null, 2));
  console.log(`[survivorship] wrote ${path.join(outDir, 'probe_result.json')}`);
}

main().catch((err) => {
  console.error('[survivorship] FAILED —', err.message, err.stack);
  process.exit(1);
});
