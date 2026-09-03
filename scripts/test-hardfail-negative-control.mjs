#!/usr/bin/env node
// Negative control (2026-09-02): the hard-fail-on-incomplete path added to
// _fetchHistoricalDailyBars, _fetchRawMinuteBars, and scanDateRangeForSetups
// has never actually fired against real traffic -- the regression pass
// (real Alpaca calls, small window) never hit a real chunk failure, because
// the fixed queue prevented one. A safety mechanism that has never fired is
// not known to work -- this project's own history (the 429 test that
// measured absence-of-errors rather than rate, the timezone test that
// didn't discriminate its own bug) is exactly this failure mode. This
// forces REAL chunk failures via mock clients (no network calls) and
// asserts each guarded path actually raises, names the failed-chunk count,
// and lists the missing symbols -- plus a matching no-false-positive check
// (clean input must NOT throw) and a check that the live-app DEFAULT
// (hardFailOnIncomplete unset) still soft-degrades exactly as before.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
function check(label, cond) {
  if (cond) console.log(`[PASS] ${label}`);
  else { console.error(`[FAIL] ${label}`); failures++; }
}

async function main() {
  global.state = { settings: { alpacaKey: 'test', alpacaSecret: 'test' } };
  global.persist = () => {};
  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.chunk = chunk; global.assertPageNotSuspiciouslyFull = assertPageNotSuspiciouslyFull; global._coreClient = _coreClient;');
  const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
  eval(clockSrc + '\nglobal.getPT = getPT; global.ptDateStr = ptDateStr; global.ptWallClockToInstant = ptWallClockToInstant; global.isTradingDay = isTradingDay;');
  const universeSrc = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  eval(universeSrc + '\nglobal._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._fetchRawMinuteBars = _fetchRawMinuteBars; global.HISTORICAL_UNIVERSE_CHUNK_SIZE = HISTORICAL_UNIVERSE_CHUNK_SIZE;');

  // ── A: _fetchHistoricalDailyBars THROWS on a forced chunk failure ──
  {
    const chunkSize = global.HISTORICAL_UNIVERSE_CHUNK_SIZE; // 90
    const goodSymbols = Array.from({ length: chunkSize }, (_, i) => `GOOD${i}`);
    const badSymbols = Array.from({ length: chunkSize }, (_, i) => `BAD${i}`);
    const symbols = [...goodSymbols, ...badSymbols]; // 2 chunks: chunk 0 clean, chunk 1 forced-fail
    const mockClient = {
      alpacaGet: async (urlPath, params) => {
        if (params.symbols.includes('BAD0')) throw new Error('SIMULATED 429: too many requests (negative control)');
        return { bars: Object.fromEntries(goodSymbols.map(s => [s, [{ t: '2026-06-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 100 }]])), next_page_token: null };
      },
    };
    let thrown = null;
    try { await global._fetchHistoricalDailyBars(symbols, '2026-06-01', '2026-06-02', mockClient); }
    catch (e) { thrown = e; }
    check('A1: _fetchHistoricalDailyBars throws when a chunk fails', thrown !== null);
    check('A2: error names the failed-chunk count (1/2)', thrown && /1\/2 chunk/.test(thrown.message));
    check('A3: error.failedSymbols lists exactly the missing chunk\'s symbols', thrown && Array.isArray(thrown.failedSymbols) && thrown.failedSymbols.length === chunkSize && thrown.failedSymbols[0] === 'BAD0');
    check('A4: error message includes a sample of the missing symbols', thrown && thrown.message.includes('BAD0'));
  }

  // ── B: _fetchHistoricalDailyBars does NOT throw on a clean fetch (no false positive) ──
  {
    const chunkSize = global.HISTORICAL_UNIVERSE_CHUNK_SIZE;
    const symbols = Array.from({ length: chunkSize }, (_, i) => `OK${i}`);
    const mockClient = { alpacaGet: async () => ({ bars: Object.fromEntries(symbols.map(s => [s, [{ t: '2026-06-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 100 }]])), next_page_token: null }) };
    let thrown = null;
    try { await global._fetchHistoricalDailyBars(symbols, '2026-06-01', '2026-06-02', mockClient); }
    catch (e) { thrown = e; }
    check('B1: _fetchHistoricalDailyBars does NOT throw on a clean fetch (no false positive)', thrown === null);
  }

  // ── C: _fetchRawMinuteBars(hardFailOnIncomplete=true) THROWS on a forced chunk failure ──
  {
    const symbols = ['AAA', 'BBB']; // chunkSize=1 forces 2 separate chunks
    const mockClient = {
      alpacaGet: async (urlPath, params) => {
        if (params.symbols === 'BBB') throw new Error('SIMULATED 429 (negative control, minute bars)');
        return { bars: { AAA: [{ t: '2026-06-01T13:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 100 }] }, next_page_token: null };
      },
    };
    let thrown = null;
    try {
      await global._fetchRawMinuteBars(symbols, new Date('2026-06-01T13:30:00Z'), new Date('2026-06-01T20:00:00Z'), 1, 'negative-control-window', mockClient, { hardFailOnIncomplete: true });
    } catch (e) { thrown = e; }
    check('C1: _fetchRawMinuteBars(hardFailOnIncomplete=true) throws when a chunk fails', thrown !== null);
    check('C2: error.failedSymbols lists the missing symbol (BBB)', thrown && Array.isArray(thrown.failedSymbols) && thrown.failedSymbols.includes('BBB'));
  }

  // ── D: _fetchRawMinuteBars DEFAULT (hardFailOnIncomplete unset) does NOT throw — live-app behavior unchanged ──
  {
    const symbols = ['AAA', 'BBB'];
    const mockClient = {
      alpacaGet: async (urlPath, params) => {
        if (params.symbols === 'BBB') throw new Error('SIMULATED 429 (negative control, default mode)');
        return { bars: { AAA: [{ t: '2026-06-01T13:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 100 }] }, next_page_token: null };
      },
    };
    let thrown = null, result = null;
    try {
      result = await global._fetchRawMinuteBars(symbols, new Date('2026-06-01T13:30:00Z'), new Date('2026-06-01T20:00:00Z'), 1, 'negative-control-default', mockClient);
    } catch (e) { thrown = e; }
    check('D1: _fetchRawMinuteBars DEFAULT does NOT throw (live-app behavior unchanged)', thrown === null);
    check('D2: default mode still returns the partial data it got (AAA present, BBB absent)', result && result.barsBySymbolAll.AAA && !result.barsBySymbolAll.BBB);
  }

  // ── E: scanDateRangeForSetups — re-throws when hardFailOnIncomplete requested, still soft-degrades by default ──
  {
    // Mock _fetchRawMinuteBars directly to isolate scanDateRangeForSetups's
    // OWN catch-block decision (re-throw vs swallow) from _fetchRawMinute-
    // Bars's own aggregation logic, already covered by C above.
    const realFetchRawMinuteBars = global._fetchRawMinuteBars;
    global._fetchRawMinuteBars = async () => {
      const err = new Error('SIMULATED fetch failure (negative control, scanDateRangeForSetups)');
      err.failedSymbols = ['ZZZ'];
      throw err;
    };
    const replayMod = await import(pathToFileURL(path.join(REPO_ROOT, 'engines', 'warrior', 'replay.js')));
    global.runReplay = replayMod.runReplay;
    const setupsMod = await import(pathToFileURL(path.join(REPO_ROOT, 'engines', 'warrior', 'setups.js')));

    let thrownE1 = null;
    try {
      await setupsMod.scanDateRangeForSetups(setupsMod.ALL_SETUPS_ID, ['ZZZ'], '2026-06-01', '2026-06-01', { fetchOpts: { hardFailOnIncomplete: true } });
    } catch (e) { thrownE1 = e; }
    check('E1: scanDateRangeForSetups THROWS when hardFailOnIncomplete is requested and the fetch layer fails', thrownE1 !== null);

    let thrownE2 = null, resultE2 = null;
    try {
      resultE2 = await setupsMod.scanDateRangeForSetups(setupsMod.ALL_SETUPS_ID, ['ZZZ'], '2026-06-01', '2026-06-01', {});
    } catch (e) { thrownE2 = e; }
    check('E2: scanDateRangeForSetups DEFAULT does NOT throw (live-app soft-degrade unchanged)', thrownE2 === null);
    check('E3: default mode still marks the symbol notEvaluated with a reason (not silently dropped)',
      !!(resultE2 && resultE2.resultsByDate['2026-06-01'] && resultE2.resultsByDate['2026-06-01'].ZZZ && resultE2.resultsByDate['2026-06-01'].ZZZ.notEvaluated === true));

    global._fetchRawMinuteBars = realFetchRawMinuteBars;
  }

  console.log('');
  if (failures === 0) console.log('[negative-control] ALL CHECKS PASSED — hard-fail path confirmed working, defaults confirmed unchanged');
  else console.error(`[negative-control] ${failures} CHECK(S) FAILED — the hard-fail path is NOT confirmed working`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('[negative-control] SCRIPT ERROR —', err.message, err.stack); process.exit(2); });
