// tests/gate.test.js — engines/warrior/gate.js. docs/warrior-engine-spec-v2.md
// Phase 3. Loads the REAL module via dynamic import() (a genuine ES module,
// unlike the classic-script core/*.js files elsewhere in this suite, so no
// eval/extraction workaround is needed) and exercises its pure functions
// directly — no mocking needed for most of this file, since evaluateGate/
// evaluatePillar1-4/classifyGate/intradayCurve all take their dependencies
// as parameters rather than reading globals.
'use strict';
const assert = require('assert');
const { run, readSource, evalModule } = require('./_lib');

// ptDateStr/ptWallClockToInstant (2026-09-04): evaluateGateBatch's new
// pre-market-RVOL branch calls these as bare globals (same shared-scope
// pattern as getPT, already relied on elsewhere in this file) — real
// implementations via core/clock.js, not stubs, since they do real date
// arithmetic other assertions below depend on being correct.
function loadClockGlobals() {
  evalModule(readSource('core/clock.js'), { expose: ['ptDateStr', 'ptWallClockToInstant'] });
}

async function loadGate() {
  loadClockGlobals();
  // Default no-op float mock (2026-09-04, Phase 6) -- safe for every test
  // that doesn't care about float specifically (empty data -> every
  // candidate's float pillar reads not-checked, same as before Phase 6
  // existed). Tests exercising float override this themselves.
  global.getFloatDataForSymbols = async () => ({ floatBySymbol: {}, requests: 0, failedSymbols: [], unmappedSymbols: [] });
  return import('../engines/warrior/gate.js');
}

async function testIntradayCurveMatchesTableAndInterpolates() {
  const gate = await loadGate();
  console.log('curve(0):', gate.intradayCurve(0), '| curve(30):', gate.intradayCurve(30), '| curve(390):', gate.intradayCurve(390));
  assert.strictEqual(gate.intradayCurve(0), 0);
  assert.strictEqual(gate.intradayCurve(30), 0.13);
  assert.strictEqual(gate.intradayCurve(390), 1.0);
  // Interpolated midpoint between the 30min/0.13 and 60min/0.21 table points.
  const mid = gate.intradayCurve(45);
  console.log('curve(45) interpolated:', mid);
  assert.ok(Math.abs(mid - 0.17) < 0.001, `expected ~0.17, got ${mid}`);
  // Out-of-domain inputs clamp rather than extrapolate wildly.
  assert.strictEqual(gate.intradayCurve(-10), 0);
  assert.strictEqual(gate.intradayCurve(500), 1.0);
}

async function testLinearProxyWouldHaveBeenWrong() {
  // Documents the actual bug the static table fixes: at the open, a linear
  // proxy (elapsed/390) reads far below the table's real front-loaded
  // share, which is exactly backwards (linear UNDER-counts expected volume
  // at the open, so RVOL computed against it would read artificially HIGH
  // — the spec's "~1.7x for every stock at the open" claim).
  const gate = await loadGate();
  const elapsed = 30;
  const linear = elapsed / 390;
  const table = gate.intradayCurve(elapsed);
  console.log(`At ${elapsed}min: linear proxy=${linear.toFixed(4)}, table=${table}`);
  assert.ok(table > linear * 1.5, 'table value should be substantially above the linear proxy at the open, per the spec\'s derivation');
}

async function testPillar1PriceRange() {
  const gate = await loadGate();
  assert.strictEqual(gate.evaluatePillar1({ price: 4.12 }).status, 'pass');
  assert.strictEqual(gate.evaluatePillar1({ price: 0.99 }).status, 'fail');
  assert.strictEqual(gate.evaluatePillar1({ price: 20.01 }).status, 'fail');
  assert.strictEqual(gate.evaluatePillar1({ price: 1.00 }).status, 'pass');
  assert.strictEqual(gate.evaluatePillar1({ price: 20.00 }).status, 'pass');
}

async function testPillar2ChangePct() {
  const gate = await loadGate();
  assert.strictEqual(gate.evaluatePillar2({ changePct: 34 }).status, 'pass');
  assert.strictEqual(gate.evaluatePillar2({ changePct: 9.9 }).status, 'fail');
  assert.strictEqual(gate.evaluatePillar2({ changePct: 10 }).status, 'pass');
}

async function testPillar3PreMarketAlwaysNotChecked() {
  const gate = await loadGate();
  const p3 = gate.evaluatePillar3({ symbol: 'ABCD' }, 'PRE', 20, { todayVolume: 500000, avgDailyVolume: 100000 });
  console.log('Pillar 3 during PRE:', p3);
  assert.strictEqual(p3.status, 'not-checked', 'RVOL must be not-checked pre-market regardless of how much volume data is available');
  assert.notStrictEqual(p3.value, 0, 'must never render as a 0x measurement');
}

async function testPillar3AfterHoursAlsoNotChecked() {
  const gate = await loadGate();
  const p3 = gate.evaluatePillar3({ symbol: 'ABCD' }, 'AH', 450, { todayVolume: 500000, avgDailyVolume: 100000 });
  assert.strictEqual(p3.status, 'not-checked', 'the 390min curve has no defined domain after the close either');
}

async function testPillar3First15MinutesNotChecked() {
  const gate = await loadGate();
  const p3 = gate.evaluatePillar3({ symbol: 'ABCD' }, 'OPEN', 10, { todayVolume: 0, avgDailyVolume: 100000 });
  console.log('Pillar 3 at 10min elapsed:', p3);
  assert.strictEqual(p3.status, 'not-checked');
  assert.notStrictEqual(p3.value, 0, 'must read as unavailable, never a literal 0x that looks like a real zero-volume measurement');
}

async function testPillar3RealComputationAndBasisDisplay() {
  const gate = await loadGate();
  // 60 min elapsed -> curve = 0.21. avgDailyVolume=1,000,000 -> expectedByNow=210,000.
  // todayVolume=2,000,000 -> rvol = 2,000,000/210,000 = ~9.52x -> passes (>=5).
  const p3 = gate.evaluatePillar3({ symbol: 'ABCD' }, 'OPEN', 60, { todayVolume: 2_000_000, avgDailyVolume: 1_000_000 });
  console.log('Pillar 3 real computation:', p3);
  assert.strictEqual(p3.status, 'pass');
  assert.ok(Math.abs(p3.value - 9.52) < 0.01);
  assert.strictEqual(p3.expectedByNow, 210_000, 'basis must be exposed for the card\'s "expected-by-now" display');
  assert.strictEqual(p3.todayVolume, 2_000_000);

  const p3fail = gate.evaluatePillar3({ symbol: 'XYZ' }, 'OPEN', 60, { todayVolume: 100_000, avgDailyVolume: 1_000_000 });
  assert.strictEqual(p3fail.status, 'fail');
}

async function testPillar4GateWindowNarrowerThanFetchWindow() {
  // The exact scenario the spec's acceptance item requires: a candidate
  // whose only news is 25-72h old must FAIL pillar 4 despite news being
  // present in the fetched (72h-windowed) data.
  const gate = await loadGate();
  const now = new Date('2026-08-25T18:00:00Z');
  const staleArticle = { headline: 'Old news', created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString() }; // 30h old
  const p4Stale = gate.evaluatePillar4({ symbol: 'ABCD' }, [staleArticle], now);
  console.log('Pillar 4, only 30h-old article present:', p4Stale);
  assert.strictEqual(p4Stale.status, 'fail', 'a 25-72h-old article must not pass the 24h gate window despite being within the 72h fetch window');
  assert.ok(p4Stale.value && p4Stale.value.includes('none under'), 'value should make clear news was present but not recent enough, not just "no news"');

  const freshArticle = { headline: 'Breaking news', created_at: new Date(now.getTime() - 2 * 3600 * 1000).toISOString() }; // 2h old
  const p4Fresh = gate.evaluatePillar4({ symbol: 'ABCD' }, [freshArticle], now);
  assert.strictEqual(p4Fresh.status, 'pass');
  assert.strictEqual(p4Fresh.value, 'Breaking news');

  const p4None = gate.evaluatePillar4({ symbol: 'ABCD' }, [], now);
  assert.strictEqual(p4None.status, 'fail');
  assert.strictEqual(p4None.value, null);
}

// 2026-09-04, found live: the backtested gate qualified 6.6% of
// candidates; live it qualified 43% (12/28) because RVOL — its heaviest
// pillar — reads 'not-checked' pre-market, when Warrior is a pre-open
// method and that's exactly when candidates are actually looked at.
// evaluatePillarPreMarketRvol is the fix's core: a DISTINCT metric from
// the regular-session RVOL pillar, always 'not-checked' AS A STATUS
// (there's zero evidence for a real cutoff yet — reusing RVOL_MIN=5.0 or
// inventing a different number would be the identical fabricated-
// precision mistake), but with a REAL computed ratio still surfaced via
// `value` so it isn't functionally invisible despite never gating.
async function testPreMarketPillarComputesRealRatioButNeverGates() {
  const gate = await loadGate();
  const p = gate.evaluatePillarPreMarketRvol({ symbol: 'ABCD' }, 'PRE', {
    todayPreMarketVolume: 900_000, avgPreMarketVolume: 300_000, daysInAverage: 22,
  });
  console.log('pre-market RVOL pillar, real inputs:', p);
  assert.strictEqual(p.id, 'rvol-premarket', 'must never share the "rvol" id — a distinct metric, distinct slot');
  assert.strictEqual(p.status, 'not-checked', 'ALWAYS not-checked as a status, even with a real value -- no validated threshold to gate on');
  assert.ok(Math.abs(p.value - 3.0) < 0.001, 'the real ratio must still be computed and surfaced, not hidden behind the not-checked status');
  assert.strictEqual(p.daysInAverage, 22);
  assert.ok(!p.threshold.match(/^\d/) && /unvalidated/i.test(p.threshold), 'threshold must read as unvalidated, never a bare number that looks measured');
}

async function testPreMarketPillarOutsidePreSessionAndOnFetchFailure() {
  const gate = await loadGate();
  const pOutside = gate.evaluatePillarPreMarketRvol({ symbol: 'ABCD' }, 'OPEN', { todayPreMarketVolume: 1, avgPreMarketVolume: 1, daysInAverage: 30 });
  assert.strictEqual(pOutside.status, 'not-checked');
  assert.strictEqual(pOutside.value, null, 'never computed outside PRE, regardless of what input happens to be passed');
  assert.match(pOutside.reason, /only computed pre-market/i);

  const pFailed = gate.evaluatePillarPreMarketRvol({ symbol: 'ABCD' }, 'PRE', { fetchFailed: true });
  assert.strictEqual(pFailed.status, 'not-checked', 'a fetch failure here is still not-checked (never gates either way), but the reason must say so honestly');
  assert.match(pFailed.reason, /fetch failed/i);
  assert.doesNotMatch(pFailed.reason, /no pre-market volume data/i, 'must not be confused with the generic no-data case');
}

async function testClassifyGateNeverGatesOnPreMarketRvolRegardlessOfRatio() {
  // The one-way door this whole design depends on: classifyGate must
  // never consult rvol-premarket at all, in either direction -- an
  // absurdly high OR low ratio must have zero effect on the tier.
  const gate = await loadGate();
  const ids = ['price', 'change', 'rvol', 'rvol-premarket', 'news', 'float'];
  const makeResult = (statuses, preMarketValue) => ({
    pillars: statuses.map((s, i) => ids[i] === 'rvol-premarket'
      ? { id: 'rvol-premarket', status: 'not-checked', value: preMarketValue }
      : { id: ids[i], status: s }),
  });
  const baseline = gate.classifyGate(makeResult(['pass', 'pass', 'pass', null, 'pass', 'not-checked'], 50)); // absurd 50x pre-market ratio
  const low = gate.classifyGate(makeResult(['pass', 'pass', 'pass', null, 'pass', 'not-checked'], 0.001)); // absurd near-zero ratio
  console.log('QUALIFIED regardless of pre-market ratio -- 50x:', baseline, '| 0.001x:', low);
  assert.strictEqual(baseline, 'QUALIFIED');
  assert.strictEqual(low, 'QUALIFIED', 'an extreme pre-market ratio in either direction must never change the classification');
}

async function testEvaluateGateBatchCapturesPreMarketRvolDistribution() {
  const gate = await loadGate();
  global.state = { newsFailedSymbols: [], warriorPreMarketRvolObservations: [] };
  global.persist = () => {};
  global._fetchCumulativeMinuteVolume = async (symbols) => {
    const v = {}; symbols.forEach(s => v[s] = s === 'FAILS' ? undefined : 900_000);
    return { volumeBySymbol: v, requests: 1, failedSymbols: symbols.includes('FAILS') ? ['FAILS'] : [] };
  };
  global._getPreMarketVolumeHistory = async (symbols) => {
    const avg = {}, hist = {};
    symbols.forEach(s => { if (s !== 'FAILS') { avg[s] = 300_000; hist[s] = Array.from({ length: 22 }, (_, i) => ({ date: `2026-08-${i + 1}`, volume: 300_000 })); } else { hist[s] = []; } });
    return { avgVolumes: avg, historyBySymbol: hist, requests: 1, failedSymbols: symbols.includes('FAILS') ? ['FAILS'] : [] };
  };
  global.fetchNewsForTickers = async (symbols) => symbols.map(s => ({ symbols: [s], headline: 'x', created_at: new Date().toISOString() }));
  global.getPT = () => { const d = new Date(); d.setHours(3, 0, 0, 0); return d; }; // PRE session, time irrelevant to the pre-market path

  const candidates = ['A', 'FAILS'].map(sym => ({ symbol: sym, price: 5, changePct: 20 }));
  await gate.evaluateGateBatch(candidates, 'PRE');
  const obs = global.state.warriorPreMarketRvolObservations;
  console.log('captured observations:', obs);
  assert.strictEqual(obs.length, 1, 'only the real, successfully-measured candidate gets an observation -- the failed one must not pollute the distribution');
  assert.strictEqual(obs[0].symbol, 'A');
  assert.ok(Math.abs(obs[0].ratio - 3.0) < 0.001);
  assert.strictEqual(obs[0].daysInAverage, 22);
}

// 2026-09-04, real risk not tidiness: state.warriorPreMarketRvolObservations
// is persisted and grows on every PRE-session scan -- unbounded, that's a
// real localStorage quota risk (which, per persist()'s own fix, cascades
// into every OTHER key silently failing too). Both bounds tested
// independently: age (90 days) and count (5,000), with the more retentive
// call taking effect at each check.
async function testTrimPreMarketRvolObservationsCapsByAge() {
  const gate = await loadGate();
  const now = new Date('2026-09-04T13:00:00.000Z');
  const fresh = { capturedAt: new Date(now.getTime() - 10 * 86400000).toISOString(), symbol: 'FRESH' }; // 10 days old
  const stale = { capturedAt: new Date(now.getTime() - 91 * 86400000).toISOString(), symbol: 'STALE' }; // 91 days old -- over the bound
  const boundary = { capturedAt: new Date(now.getTime() - 90 * 86400000).toISOString(), symbol: 'BOUNDARY' }; // exactly 90 days
  const trimmed = gate._trimPreMarketRvolObservations([stale, boundary, fresh], now);
  console.log('age-trimmed symbols:', trimmed.map(o => o.symbol));
  assert.ok(!trimmed.some(o => o.symbol === 'STALE'), '91-day-old observation must be dropped');
  assert.ok(trimmed.some(o => o.symbol === 'FRESH'), '10-day-old observation must survive');
  assert.ok(trimmed.some(o => o.symbol === 'BOUNDARY'), 'exactly-90-day-old observation is still within bound (>=  not >)');
}

async function testTrimPreMarketRvolObservationsCapsByCount() {
  const gate = await loadGate();
  const now = new Date('2026-09-04T13:00:00.000Z');
  // 5,010 observations, all recent (age bound doesn't apply), oldest-first
  // (matches how they're actually appended live -- push() order).
  const obs = Array.from({ length: 5010 }, (_, i) => ({
    capturedAt: new Date(now.getTime() - (5010 - i) * 1000).toISOString(), // i=0 is oldest
    symbol: `S${i}`,
  }));
  const trimmed = gate._trimPreMarketRvolObservations(obs, now);
  console.log('count-trimmed length:', trimmed.length, '| first kept:', trimmed[0].symbol, '| last kept:', trimmed[trimmed.length - 1].symbol);
  assert.strictEqual(trimmed.length, 5000, 'must cap at exactly the configured max count');
  assert.strictEqual(trimmed[0].symbol, 'S10', 'must keep the MOST RECENT 5,000 (drop the oldest 10), not an arbitrary slice');
  assert.strictEqual(trimmed[trimmed.length - 1].symbol, 'S5009');
}

// 2026-09-04, Phase 6: float is real now (SEC EDGAR, core/edgar.js) --
// these replace the old Phase-3-era "always not-checked" test with the
// real pass/fail/not-checked/fetch-failed behavior.
async function testFloatPillarPassesFailsAndRespectsConfigurableThreshold() {
  const gate = await loadGate();
  const under = gate.evaluatePillarFloat({ impliedFloatShares: 4_000_000, referenceDate: '2026-08-01', stalenessDays: 30 }, 10_000_000);
  console.log('float under threshold:', under);
  assert.strictEqual(under.status, 'pass');
  assert.strictEqual(under.value, 4_000_000);
  assert.strictEqual(under.asOfDate, '2026-08-01', 'the float\'s own reference date must reach the card, per spec (\"show the float\'s date field alongside the value\")');

  const over = gate.evaluatePillarFloat({ impliedFloatShares: 24_100_000, referenceDate: '2026-08-01', stalenessDays: 30 }, 10_000_000);
  assert.strictEqual(over.status, 'fail');

  // Configurable threshold (spec: "not a wall... make the threshold
  // configurable") -- the SAME implied-float value passes or fails
  // depending purely on the configured cutoff, not a hardcoded one.
  const sameValueDifferentThreshold = gate.evaluatePillarFloat({ impliedFloatShares: 24_100_000, referenceDate: '2026-08-01', stalenessDays: 30 }, 30_000_000);
  assert.strictEqual(sameValueDifferentThreshold.status, 'pass', 'the identical implied-float value must pass under a looser configured threshold');
}

async function testFloatPillarNotCheckedAndFetchFailedAreDistinct() {
  const gate = await loadGate();
  const noData = gate.evaluatePillarFloat(undefined, 10_000_000);
  assert.strictEqual(noData.status, 'not-checked');
  assert.match(noData.reason, /no EntityPublicFloat filing/i);

  const failed = gate.evaluatePillarFloat({ fetchFailed: true }, 10_000_000);
  assert.strictEqual(failed.status, 'fetch-failed', 'a request failure must never be fabricated as not-checked or, worse, a pass — the $0.00 P&L failure shape');
  assert.match(failed.reason, /fetch failed/i);
}

async function testFloatVolumeConsistencyBackstop() {
  // Found live in a boot check (2026-09-04): BIAF (implied float 174,868)
  // and GRI (41,528) both PASSED the <10M gate despite same-session volume
  // 80x-263x their implied float -- the invariant guard (impliedFloatShares
  // <= sharesOutstanding) is ONE-SIDED and cannot catch an under-estimate,
  // which is exactly the direction that produces a false PASS.
  const gate = await loadGate();

  const biafShape = gate.evaluatePillarFloat({ impliedFloatShares: 174_868, referenceDate: '2026-03-10', stalenessDays: 10 }, 10_000_000, 13_937_520);
  console.log('BIAF-shaped result (80x volume/float):', biafShape);
  assert.strictEqual(biafShape.status, 'not-checked', 'an implausible volume/float ratio must block the pass, not just note it');
  assert.match(biafShape.reason, /79\.7x/, 'the reason must state the actual computed multiple');
  assert.match(biafShape.reason, /beyond what real trading can plausibly explain/i);

  const griShape = gate.evaluatePillarFloat({ impliedFloatShares: 41_528, referenceDate: '2026-03-10', stalenessDays: 10 }, 10_000_000, 434_080);
  console.log('GRI-shaped result (~10.5x volume/float):', griShape);
  assert.strictEqual(griShape.status, 'not-checked', 'GRI\'s own ~10.5x ratio is above the 10x cutoff and must be caught');
}

async function testFloatVolumeConsistencyAllowsPlausibleRatios() {
  // A genuine extreme-momentum float-rotation day (up to the 10x
  // data-derived cutoff) must NOT be penalized -- Ross's own method
  // targets exactly these days, and p97 of the real measured distribution
  // sits near 1.0x (a full rotation), which is rare but real.
  const gate = await loadGate();
  const result = gate.evaluatePillarFloat({ impliedFloatShares: 1_000_000, referenceDate: '2026-03-10', stalenessDays: 10 }, 10_000_000, 5_000_000); // 5x, well under the 10x cutoff
  console.log('5x volume/float (plausible extreme momentum):', result);
  assert.strictEqual(result.status, 'pass', 'a 5x ratio is extreme but real -- must not be blocked');
}

async function testFloatVolumeConsistencySkippedWhenVolumeUnavailable() {
  // Pre-market/closed sessions have no real todayVolume (RVOL itself reads
  // not-checked then) -- the backstop must be skipped cleanly, not treated
  // as a failure, matching the guard's own "skip when data unavailable" rule.
  // stalenessDays=10 is well under the fallback bound (180), so this case
  // is unaffected by that bound either -- see the next two tests for what
  // happens when staleness DOES cross it under this same no-volume
  // condition.
  const gate = await loadGate();
  const result = gate.evaluatePillarFloat({ impliedFloatShares: 1_000_000, referenceDate: '2026-03-10', stalenessDays: 10 }, 10_000_000, undefined);
  assert.strictEqual(result.status, 'pass', 'missing todayVolume must not itself block an otherwise-valid float pass');
}

async function testStalenessFallbackBoundFiresOnlyWithoutVolumeData() {
  // Found live 2026-09-05, in the Phase 7 signal logger's first real dry
  // run: GPRO's float pillar had stalenessDays=432 and no todayVolume
  // (CLOSED session -- RVOL, and therefore the volume-consistency check
  // above, was never checkable), and evaluatePillarFloat had NO defense
  // left at all -- the volume check can't fire without todayVolume, and
  // the original 180-day bound had been dropped project-wide 2026-09-04.
  // GPRO failed anyway (131M shares against a 10M gate) -- right by luck,
  // not by construction. This is the exact BIAF/GRI shape (a small,
  // stale-beyond-usefulness implied float PASSING the gate) with nothing
  // left to catch it.
  const gate = await loadGate();

  // Beyond the 180-day bound, no todayVolume -> now 'not-checked', not a
  // raw pass/fail on a number nothing has verified is still current.
  const staleNoVolume = gate.evaluatePillarFloat(
    { impliedFloatShares: 174_868, referenceDate: '2025-06-30', stalenessDays: 432 }, 10_000_000, undefined
  );
  assert.strictEqual(staleNoVolume.status, 'not-checked', 'beyond the fallback bound with no volume data to check instead, this must not silently pass or fail on a number nobody has verified is still current');
  assert.strictEqual(staleNoVolume.stalenessDays, 432, 'staleness must still be visible on the pillar even when it blocks the check');

  // Same staleness, but todayVolume IS available and plausible -- the
  // volume-consistency check is the primary defense in this case and
  // must be the one that decides, not the fallback bound. Confirms the
  // fallback only fires in the specific gap it exists for.
  const staleWithPlausibleVolume = gate.evaluatePillarFloat(
    { impliedFloatShares: 174_868, referenceDate: '2025-06-30', stalenessDays: 432 }, 10_000_000, 500_000 // ~2.9x, well under VOLUME_TO_FLOAT_MULTIPLE_MAX
  );
  assert.strictEqual(staleWithPlausibleVolume.status, 'pass', 'with real, plausible volume data available, the volume-consistency check governs -- the fallback bound must not override a case the primary check already cleared');

  // Under the fallback bound, no volume data -- must NOT be blocked; this
  // is the coverage the 2026-09-04 drop decision was protecting, and the
  // fallback must not re-gut it.
  const notStaleNoVolume = gate.evaluatePillarFloat(
    { impliedFloatShares: 1_000_000, referenceDate: '2026-06-01', stalenessDays: 90 }, 10_000_000, undefined
  );
  assert.strictEqual(notStaleNoVolume.status, 'pass', 'under the fallback bound, no volume data must not itself block an otherwise-valid pass');
}

async function testClassifyGateTreatsFloatAsSubstantiveAsOfPhase6() {
  const gate = await loadGate();
  const ids = ['price', 'change', 'rvol', 'rvol-premarket', 'news', 'float'];
  const makeResult = (statuses) => ({ pillars: statuses.map((s, i) => ({ id: ids[i], status: s })) });

  assert.strictEqual(
    gate.classifyGate(makeResult(['pass', 'pass', 'pass', 'not-checked', 'pass', 'pass'])),
    'QUALIFIED', 'float passing alongside rvol/news must still reach QUALIFIED'
  );
  assert.strictEqual(
    gate.classifyGate(makeResult(['pass', 'pass', 'pass', 'not-checked', 'pass', 'fail'])),
    'NEAR_MISS', 'float is now substantive -- a float-only failure must read as a genuine near-miss, not silently ignored the way pre-Phase-6 not-checked was'
  );
  assert.strictEqual(
    gate.classifyGate(makeResult(['pass', 'pass', 'fail', 'not-checked', 'pass', 'fail'])),
    'REJECTED', 'two real substantive failures (rvol + float) is a genuine reject, not near-miss and not bare null (2026-09-05 fix)'
  );
  assert.strictEqual(
    gate.classifyGate(makeResult(['pass', 'pass', 'pass', 'not-checked', 'pass', 'fetch-failed'])),
    'BLOCKED', 'a float fetch failure blocks the same way rvol/news fetch failures do -- see evaluatePillarFloat\'s own comment on why this diverges from the spec\'s older FMP-era near-miss-fallback language'
  );
}

async function testFloatAppliedLastNotFurtherShortCircuitedByOtherStage2Fails() {
  // "Apply last" per spec means scoped to price+change survivors (same as
  // rvol/news) -- NOT additionally skipped just because rvol or news
  // already failed. Verifies the deliberate rejection of a stricter
  // reading, documented in evaluateGate's own comment.
  const gate = await loadGate();
  const result = gate.evaluateGate({ symbol: 'ABCD', price: 5, changePct: 20 }, {
    session: 'OPEN', elapsedMinutes: 60,
    rvolInput: { todayVolume: 100, avgDailyVolume: 1_000_000 }, // rvol genuinely fails
    newsItemsForSymbol: [],
    floatInput: { impliedFloatShares: 4_000_000, referenceDate: '2026-08-01', stalenessDays: 10 },
    floatThresholdShares: 10_000_000,
    now: new Date(),
  });
  const byId = Object.fromEntries(result.pillars.map(p => [p.id, p]));
  console.log('float pillar despite rvol already failing:', byId.float);
  assert.strictEqual(byId.rvol.status, 'fail');
  assert.strictEqual(byId.float.status, 'pass', 'float must still be genuinely evaluated even though rvol already failed -- a complete picture, same principle already established for rvol vs news');
}

async function testEvaluateGateBatchFetchesFloatOnlyForPillar12SurvivorsAndReadsConfiguredThreshold() {
  const gate = await loadGate();
  let requestedSymbols = null;
  global.state = { newsFailedSymbols: [], warriorPreMarketRvolObservations: [], settings: { floatThresholdShares: 30_000_000 } };
  global.persist = () => {};
  global._fetchCumulativeMinuteVolume = async (symbols) => { const v = {}; symbols.forEach(s => v[s] = 2_000_000); return { volumeBySymbol: v, requests: 1, failedSymbols: [] }; };
  global._getSip30DayAvgVolume = async (symbols) => { const v = {}; symbols.forEach(s => v[s] = 1_000_000); return { avgVolumes: v, requests: 1, failedSymbols: [] }; };
  global.fetchNewsForTickers = async (symbols) => symbols.map(s => ({ symbols: [s], headline: 'x', created_at: new Date().toISOString() }));
  global.getFloatDataForSymbols = async (symbols) => {
    requestedSymbols = symbols;
    return { floatBySymbol: { A: { impliedFloatShares: 24_100_000, referenceDate: '2026-08-01', stalenessDays: 5 } }, requests: 1, failedSymbols: [], unmappedSymbols: [], tableBuiltAt: '2026-09-01T00:00:00.000Z', tableStalenessDays: 3 };
  };
  global.getPT = () => { const d = new Date(); d.setHours(7, 30, 0, 0); return d; }; // 60min after 6:30 open

  const candidates = [
    { symbol: 'A', price: 5, changePct: 20 },  // clears price+change
    { symbol: 'B', price: 50, changePct: 5 },  // fails BOTH -- must never reach the float fetch
  ];
  const { results, floatTableBuiltAt, floatTableStalenessDays } = await gate.evaluateGateBatch(candidates, 'OPEN');
  const byId = Object.fromEntries(results.map(r => [r.symbol, r]));
  console.log('float requested for:', requestedSymbols, '| A float status:', byId.A.pillars.find(p => p.id === 'float').status, '| A tier:', byId.A.tier, '| table info:', { floatTableBuiltAt, floatTableStalenessDays });

  assert.deepStrictEqual(requestedSymbols, ['A'], 'must never fetch float for a symbol that failed the free pillars -- "apply last" per spec');
  const floatA = byId.A.pillars.find(p => p.id === 'float');
  assert.strictEqual(floatA.status, 'pass', '24.1M shares must pass under the configured 30M threshold (would fail under the 10M default -- proves the configured value, not the default, was actually used)');
  assert.strictEqual(floatA.asOfDate, '2026-08-01');
  assert.strictEqual(floatTableBuiltAt, '2026-09-01T00:00:00.000Z', 'the float table\'s own builtAt must reach evaluateGateBatch\'s caller so the tab can display/warn on it');
  assert.strictEqual(floatTableStalenessDays, 3);
}

async function testEvaluateGateBatchReportsNullTableInfoWhenFloatNeverFetched() {
  // Zero pillar12Survivors -> the float fetch never runs -> table info must
  // be null, not a stale leftover from some other call, so callers know to
  // fall back to a carried-forward value rather than trust a fabricated one.
  const gate = await loadGate();
  global.state = { newsFailedSymbols: [], warriorPreMarketRvolObservations: [], settings: {} };
  global.persist = () => {};
  const candidates = [{ symbol: 'B', price: 50, changePct: 5 }]; // fails both free pillars
  const { floatTableBuiltAt, floatTableStalenessDays } = await gate.evaluateGateBatch(candidates, 'OPEN');
  assert.strictEqual(floatTableBuiltAt, null);
  assert.strictEqual(floatTableStalenessDays, null);
}

async function testGateShortCircuitsOnPillar1Failure() {
  const gate = await loadGate();
  const candidate = { symbol: 'ABCD', price: 25.00, changePct: 50 }; // fails pillar 1 (over $20)
  const result = gate.evaluateGate(candidate, {
    session: 'OPEN', elapsedMinutes: 60,
    rvolInput: { todayVolume: 999, avgDailyVolume: 999 }, // present but must NOT be consulted
    newsItemsForSymbol: [{ headline: 'x', created_at: new Date().toISOString() }], // present but must NOT be consulted
    now: new Date(),
  });
  console.log('Short-circuit result pillars:', result.pillars.map(p => `${p.id}:${p.status}`).join(' '));
  const byId = Object.fromEntries(result.pillars.map(p => [p.id, p]));
  assert.strictEqual(byId.price.status, 'fail');
  assert.strictEqual(byId.change.status, 'pass'); // still free/evaluable
  assert.strictEqual(byId.rvol.status, 'not-checked'); // short-circuited, not fabricated as fail
  assert.strictEqual(byId.news.status, 'not-checked'); // short-circuited
  // A price failure is a basic disqualification, not "close" — must NOT
  // read as NEAR_MISS just because short-circuiting left only one 'fail'
  // in the array. See classifyGate's stage-1/stage-2 comment.
  assert.strictEqual(result.tier, 'REJECTED', 'a price failure must never classify as NEAR_MISS, regardless of how many other pillars are merely not-checked — and must be a real, named tier, not bare null (2026-09-05 fix)');
}

async function testGateEvaluatesNewsEvenWhenRvolFails() {
  // The actual root-cause fix: Pillar 3 failing must NOT short-circuit
  // Pillar 4 — both are evaluated for real whenever price+change pass, so
  // a near-miss card always shows a complete picture instead of "RVOL
  // fail, news not-checked."
  const gate = await loadGate();
  const candidate = { symbol: 'ABCD', price: 5.00, changePct: 20 }; // clears price+change
  const freshArticle = { headline: 'Breaking news', created_at: new Date().toISOString() };
  const result = gate.evaluateGate(candidate, {
    session: 'OPEN', elapsedMinutes: 60,
    rvolInput: { todayVolume: 100, avgDailyVolume: 1_000_000 }, // deliberately far under 5x -> rvol fails
    newsItemsForSymbol: [freshArticle],
    now: new Date(),
  });
  console.log('rvol-fails result pillars:', result.pillars.map(p => `${p.id}:${p.status}`).join(' '));
  const byId = Object.fromEntries(result.pillars.map(p => [p.id, p]));
  assert.strictEqual(byId.rvol.status, 'fail', 'rvol should genuinely fail given the inputs');
  assert.strictEqual(byId.news.status, 'pass', 'news must still be evaluated for real (and can pass) even though rvol failed — not skipped');
  assert.strictEqual(byId.news.value, 'Breaking news');
  assert.strictEqual(result.tier, 'NEAR_MISS', 'exactly one substantive pillar (rvol) failed, with a complete picture — genuine near-miss');
}

async function testClassifyQualifiedAndNearMiss() {
  const gate = await loadGate();
  const ids = ['price', 'change', 'rvol', 'news', 'float'];
  const makeResult = (statuses) => ({ pillars: statuses.map((s, i) => ({ id: ids[i], status: s })) });

  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'pass', 'pass', 'pass', 'not-checked'])), 'QUALIFIED', 'all checkable pillars pass, float not-checked -> QUALIFIED (not permanently empty passCount===5)');
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'pass', 'pass', 'fail', 'not-checked'])), 'NEAR_MISS', 'news is the only failure, price/change/rvol all real passes -> NEAR_MISS');
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'pass', 'fail', 'pass', 'not-checked'])), 'NEAR_MISS', 'rvol is the only failure -> NEAR_MISS');
  assert.strictEqual(gate.classifyGate(makeResult(['fail', 'not-checked', 'not-checked', 'not-checked', 'not-checked'])), 'REJECTED', 'price is the (short-circuited) only failure -> NOT NEAR_MISS, a real reject, not bare null (2026-09-05 fix)');
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'fail', 'not-checked', 'not-checked', 'not-checked'])), 'REJECTED', 'change is the (short-circuited) only failure -> NOT NEAR_MISS');
  // The precise gap a naive "just widen stage 2" fix would have missed:
  // price fails but change happens to PASS (both are evaluated
  // unconditionally, independent of each other) — "exactly one checkable
  // pillar fails" is trivially true here too unless stage 1 is gated as a
  // pair, not counted individually. Must still be REJECTED, not NEAR_MISS.
  assert.strictEqual(gate.classifyGate(makeResult(['fail', 'pass', 'not-checked', 'not-checked', 'not-checked'])), 'REJECTED', 'price fails even though change independently passes -> still NOT NEAR_MISS, not a vacuous 1-fail count');
  // change='fail' here trips the free-pillar check before rvol/news are
  // even consulted, same as the two assertions above — the "two
  // failures" in the name describes the pillar array, not two distinct
  // classifyGate branches; both routes this function has for a genuine
  // reject converge on the same 'REJECTED' value.
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'fail', 'fail', 'pass', 'not-checked'])), 'REJECTED', 'a free-pillar failure (change) rejects outright regardless of what rvol/news would have shown');
  assert.strictEqual(gate.classifyGate(makeResult(['not-checked', 'not-checked', 'not-checked', 'not-checked', 'not-checked'])), 'REJECTED', 'price not-checked !== pass, so this trips the free-pillar-fail branch too -> REJECTED, not NOT_EVALUATED (that requires price/change to genuinely pass, see below)');
  // Distinct from the free-pillar-fail cases above: price AND change both
  // genuinely pass here, but nothing substantive was ever checkable —
  // NOT_EVALUATED, not REJECTED, because nothing was actually judged.
  // Synthetic (real gate.js's news pillar can never be 'not-checked' —
  // see evaluatePillarNews, only pass/fail/fetch-failed — so this exact
  // combination can't occur live today), but classifyGate is a pure
  // function of whatever pillars array it's given, and must still
  // classify this correctly rather than only handling inputs the live
  // gate happens to produce.
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'pass', 'not-checked', 'not-checked', 'not-checked'])), 'NOT_EVALUATED', 'free pillars genuinely pass but nothing substantive was checkable -> NOT_EVALUATED, not a vacuous QUALIFIED and not REJECTED');
}

// 2026-09-04, gate-honesty pass: a REQUEST failure (rate-limited, network
// error) must never render or classify the same as a structural
// not-checked or a genuine fail — a candidate Roman is about to trade on
// needs to know "we couldn't measure this" is a different claim than
// "we checked and it's fine to ignore" or "we checked and it failed."
async function testPillar3FetchFailedDistinctFromNotCheckedAndFail() {
  const gate = await loadGate();
  const candidate = { symbol: 'A', price: 5, changePct: 20 };
  const result = gate.evaluatePillar3(candidate, 'OPEN', 60, { fetchFailed: true });
  console.log('Pillar 3 fetch-failed:', result);
  assert.strictEqual(result.status, 'fetch-failed', 'a request failure must be its own status, not folded into not-checked or fail');
  assert.notStrictEqual(result.status, 'not-checked');
  assert.notStrictEqual(result.status, 'fail');
  assert.ok(result.reason && /fetch failed/i.test(result.reason), 'reason must say a fetch failed, not "no volume data" (which reads as confirmed-absent)');
}

async function testPillar4FetchFailedDistinctFromFail() {
  // The worst version of the original bug: BEFORE this fix, a total news
  // outage returned newsItemsForSymbol=[] for every candidate, which
  // evaluatePillar4 scored as a real, confirmed 'fail' — actively
  // counting against qualification instead of just being invisible.
  const gate = await loadGate();
  const candidate = { symbol: 'A', price: 5, changePct: 20 };
  const result = gate.evaluatePillar4(candidate, [], new Date(), true);
  console.log('Pillar 4 fetch-failed:', result);
  assert.strictEqual(result.status, 'fetch-failed', 'a news fetch failure must never be scored as a real fail');
  assert.notStrictEqual(result.status, 'fail');
}

async function testClassifyGateBlocksOnFetchFailed() {
  const gate = await loadGate();
  const ids = ['price', 'change', 'rvol', 'news', 'float'];
  const makeResult = (statuses) => ({ pillars: statuses.map((s, i) => ({ id: ids[i], status: s })) });

  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'pass', 'fetch-failed', 'pass', 'not-checked'])), 'BLOCKED', 'rvol fetch failure blocks qualification outright — never QUALIFIED, never NEAR_MISS');
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'pass', 'pass', 'fetch-failed', 'not-checked'])), 'BLOCKED', 'news fetch failure blocks the same way');
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'pass', 'fetch-failed', 'fail', 'not-checked'])), 'BLOCKED', 'BLOCKED takes priority even when the OTHER substantive pillar genuinely failed too — not a near-miss, we do not know enough to call it that');
  assert.strictEqual(gate.classifyGate(makeResult(['fail', 'pass', 'fetch-failed', 'not-checked', 'not-checked'])), 'REJECTED', 'a fetch failure never overrides a real free-pillar disqualification — still REJECTED, not BLOCKED (2026-09-05: was bare null, now a named tier)');
}

async function testEvaluateGateBatchThreadsFailedSymbolsToBlocked() {
  // End-to-end: a symbol whose RVOL fetch failed must come out BLOCKED,
  // not silently QUALIFIED (fetchFailed dropped) or silently disqualified
  // (fetchFailed misread as fail).
  const gate = await loadGate();
  global.state = { newsFailedSymbols: [] };
  global._fetchCumulativeMinuteVolume = async (symbols) => {
    const v = {}; symbols.forEach(s => v[s] = 2_000_000);
    return { volumeBySymbol: v, requests: 1, failedSymbols: ['B'] }; // B's cumulative-volume chunk failed
  };
  global._getSip30DayAvgVolume = async (symbols) => {
    const v = {}; symbols.forEach(s => v[s] = 1_000_000);
    return { avgVolumes: v, requests: 1, failedSymbols: [] };
  };
  global.fetchNewsForTickers = async (symbols) => symbols.map(s => ({ symbols: [s], headline: 'x', created_at: new Date().toISOString() }));
  global.getPT = () => { const d = new Date(); d.setHours(7, 30, 0, 0); return d; }; // 60min after open

  const candidates = ['A', 'B'].map(sym => ({ symbol: sym, price: 5, changePct: 20 }));
  const { results } = await gate.evaluateGateBatch(candidates, 'OPEN');
  const bySymbol = Object.fromEntries(results.map(r => [r.symbol, r]));
  console.log('A tier:', bySymbol.A.tier, '| B tier:', bySymbol.B.tier, '| B rvol pillar status:', bySymbol.B.pillars.find(p => p.id === 'rvol').status);
  assert.strictEqual(bySymbol.A.tier, 'QUALIFIED', 'unaffected candidate must still qualify normally');
  assert.strictEqual(bySymbol.B.tier, 'BLOCKED', 'candidate whose RVOL fetch failed must be BLOCKED, not QUALIFIED and not silently disqualified');
  assert.strictEqual(bySymbol.B.pillars.find(p => p.id === 'rvol').status, 'fetch-failed');
}

async function testEvaluateGateBatchNeverCallsPerCandidate() {
  // Verifies the batch orchestration shape without live Alpaca access:
  // mocks the global fetchers gate.js calls and confirms it invokes them
  // ONCE for the whole survivor set, not once per candidate.
  const gate = await loadGate();
  let cumulativeCalls = 0, avgCalls = 0, newsCalls = 0;
  global.state = { newsFailedSymbols: [] };
  global._fetchCumulativeMinuteVolume = async (symbols) => { cumulativeCalls++; const v = {}; symbols.forEach(s => v[s] = 2_000_000); return { volumeBySymbol: v, requests: 1, failedSymbols: [] }; };
  global._getSip30DayAvgVolume = async (symbols) => { avgCalls++; const v = {}; symbols.forEach(s => v[s] = 1_000_000); return { avgVolumes: v, requests: 1, failedSymbols: [] }; };
  global.fetchNewsForTickers = async (symbols) => { newsCalls++; return symbols.map(s => ({ symbols: [s], headline: 'x', created_at: new Date().toISOString() })); };
  global.getPT = () => { const d = new Date(); d.setHours(7, 30, 0, 0); return d; }; // 60min after 6:30 open

  const candidates = ['A', 'B', 'C'].map(sym => ({ symbol: sym, price: 5, changePct: 20 }));
  const { results, requests } = await gate.evaluateGateBatch(candidates, 'OPEN');

  console.log(`Batch calls — cumulative:${cumulativeCalls} avg:${avgCalls} news:${newsCalls}, reported requests:${requests}`);
  assert.strictEqual(cumulativeCalls, 1, 'must batch all survivors into one cumulative-volume call, not one per candidate');
  assert.strictEqual(avgCalls, 1);
  assert.strictEqual(newsCalls, 1);
  assert.strictEqual(results.length, 3);
  assert.ok(results.every(r => r.tier === 'QUALIFIED'), 'all three should qualify given the mocked inputs');
}

async function testRvolCheckableFlagReflectsSessionStructurally() {
  // Live-check finding (2026-08-26): outside regular session, RVOL is
  // not-checked for every candidate, so a QUALIFIED tier there only
  // means "cleared price+change+news" — RVOL, the most selective
  // pillar, was never actually consulted. classifyGate is correct to
  // still call that QUALIFIED (not-checked never counts against a
  // candidate); what needed fixing was the render layer's aggregate
  // label overclaiming. This test locks down the flag renderTab reads
  // to build that caveat, and confirms it doesn't burn a request when
  // the answer is already known.
  const gate = await loadGate();
  const candidates = [{ symbol: 'A', price: 5, changePct: 20 }];

  global.state = { newsFailedSymbols: [] };
  let calledOutsideSession = false;
  global._fetchCumulativeMinuteVolume = async () => { calledOutsideSession = true; return { volumeBySymbol: {}, requests: 1, failedSymbols: [] }; };
  global._getSip30DayAvgVolume = async () => { calledOutsideSession = true; return { avgVolumes: {}, requests: 1, failedSymbols: [] }; };
  global.fetchNewsForTickers = async (symbols) => symbols.map(s => ({ symbols: [s], headline: 'x', created_at: new Date().toISOString() }));
  global.getPT = () => { const d = new Date(); d.setHours(3, 0, 0, 0); return d; }; // irrelevant while session isn't OPEN

  const closedResult = await gate.evaluateGateBatch(candidates, 'CLOSED');
  console.log('rvolCheckable outside session:', closedResult.rvolCheckable, '| tier:', closedResult.results[0].tier);
  assert.strictEqual(closedResult.rvolCheckable, false, 'RVOL is not checkable outside the regular session');
  assert.strictEqual(calledOutsideSession, false, 'must not spend an RVOL request when RVOL is already known to be unavailable this session');
  assert.strictEqual(closedResult.results[0].tier, 'QUALIFIED', 'classification is unchanged — the caveat is a display concern (see gate.js comment on classifyGate)');

  // OPEN but inside the first 15 minutes — same structural gate evaluatePillar3 checks itself.
  global.getPT = () => { const d = new Date(); d.setHours(6, 40, 0, 0); return d; }; // 10min after 6:30 open
  const earlyResult = await gate.evaluateGateBatch(candidates, 'OPEN');
  assert.strictEqual(earlyResult.rvolCheckable, false, 'first 15 minutes of OPEN must also read as not checkable');

  // OPEN, past the first 15 minutes — genuinely checkable, and the fetchers actually run.
  let calledInSession = false;
  global._fetchCumulativeMinuteVolume = async (symbols) => { calledInSession = true; const v = {}; symbols.forEach(s => v[s] = 2_000_000); return { volumeBySymbol: v, requests: 1, failedSymbols: [] }; };
  global._getSip30DayAvgVolume = async (symbols) => { calledInSession = true; const v = {}; symbols.forEach(s => v[s] = 1_000_000); return { avgVolumes: v, requests: 1, failedSymbols: [] }; };
  global.getPT = () => { const d = new Date(); d.setHours(7, 30, 0, 0); return d; }; // 60min after open
  const openResult = await gate.evaluateGateBatch(candidates, 'OPEN');
  assert.strictEqual(openResult.rvolCheckable, true, 'past the first 15 minutes of OPEN, RVOL is genuinely checkable');
  assert.strictEqual(calledInSession, true, 'RVOL fetchers must actually run once genuinely checkable');
}

async function testDiagnoseGateCostShapeAndStrategySelection() {
  const gate = await loadGate();
  let usedStrategy = null;
  global.getUniverse = async ({ session, strategy }) => {
    usedStrategy = strategy;
    return [{ symbol: 'A', price: 5, changePct: 20 }, { symbol: 'B', price: 50, changePct: 5 }]; // A qualifies, B fails price+change
  };
  global.state = { newsFailedSymbols: [], warriorPreMarketRvolObservations: [] };
  global.persist = () => {};
  global._fetchCumulativeMinuteVolume = async (symbols) => { const v = {}; symbols.forEach(s => v[s] = 2_000_000); return { volumeBySymbol: v, requests: 1, failedSymbols: [] }; };
  global._getSip30DayAvgVolume = async (symbols) => { const v = {}; symbols.forEach(s => v[s] = 1_000_000); return { avgVolumes: v, requests: 1, failedSymbols: [] }; };
  // _getPreMarketVolumeHistory (2026-09-04): evaluateGateBatch's PRE-
  // session branch calls this too, alongside _fetchCumulativeMinuteVolume
  // above (which serves as BOTH the regular-session AND pre-market
  // numerator fetch in this mock — fine here, this test only checks
  // strategy selection and cost shape, not real pre-market RVOL values).
  global._getPreMarketVolumeHistory = async (symbols) => { const v = {}, h = {}; symbols.forEach(s => { v[s] = 1_000_000; h[s] = [{ date: '2026-09-01', volume: 1_000_000 }]; }); return { avgVolumes: v, historyBySymbol: h, requests: 1, failedSymbols: [] }; };
  global.fetchNewsForTickers = async (symbols) => symbols.map(s => ({ symbols: [s], headline: 'x', created_at: new Date().toISOString() }));
  global.getPT = () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d; }; // 90min after 6:30 open

  const diagPre = await gate.diagnoseGateCost('PRE');
  console.log('diagnoseGateCost(PRE) strategy used:', usedStrategy);
  assert.strictEqual(usedStrategy, 'premarket-gap', 'PRE session must select the premarket-gap strategy, not stale movers data');

  const diag = await gate.diagnoseGateCost('OPEN');
  console.log('diagnoseGateCost(OPEN):', { universeCount: diag.universeCount, qualifiedCount: diag.qualifiedCount, nearMissCount: diag.nearMissCount, gateRequests: diag.gateRequests, wallClockMs: diag.wallClockMs });
  assert.strictEqual(usedStrategy, 'movers', 'OPEN session must select movers, not premarket-gap');
  assert.strictEqual(diag.universeCount, 2);
  assert.strictEqual(diag.qualifiedCount, 1);
  assert.ok(typeof diag.wallClockMs === 'number');
  assert.ok(typeof diag.gateRequests === 'number' && diag.gateRequests > 0);
}

(async () => {
  await run('gate: intradayCurve matches the table and interpolates', testIntradayCurveMatchesTableAndInterpolates);
  await run('gate: linear proxy would have been wrong (documents the fixed bug)', testLinearProxyWouldHaveBeenWrong);
  await run('gate: Pillar 1 price range', testPillar1PriceRange);
  await run('gate: Pillar 2 change%', testPillar2ChangePct);
  await run('gate: Pillar 3 not-checked during PRE regardless of data', testPillar3PreMarketAlwaysNotChecked);
  await run('gate: Pillar 3 not-checked during AH too', testPillar3AfterHoursAlsoNotChecked);
  await run('gate: Pillar 3 not-checked in first 15 minutes, never 0x', testPillar3First15MinutesNotChecked);
  await run('gate: Pillar 3 real computation + expected-by-now basis exposed', testPillar3RealComputationAndBasisDisplay);
  await run('gate: Pillar 4 — 25-72h-old news fails the 24h gate despite being fetched', testPillar4GateWindowNarrowerThanFetchWindow);
  await run('gate: pre-market RVOL pillar computes a real ratio but never gates', testPreMarketPillarComputesRealRatioButNeverGates);
  await run('gate: pre-market RVOL pillar outside PRE session and on fetch failure', testPreMarketPillarOutsidePreSessionAndOnFetchFailure);
  await run('gate: classifyGate never gates on pre-market RVOL regardless of ratio', testClassifyGateNeverGatesOnPreMarketRvolRegardlessOfRatio);
  await run('gate: evaluateGateBatch captures pre-market RVOL distribution, excluding failures', testEvaluateGateBatchCapturesPreMarketRvolDistribution);
  await run('gate: pre-market RVOL observations trimmed by age (90 days)', testTrimPreMarketRvolObservationsCapsByAge);
  await run('gate: pre-market RVOL observations trimmed by count (5,000, most recent kept)', testTrimPreMarketRvolObservationsCapsByCount);
  await run('gate: float pillar passes/fails and respects a configurable threshold', testFloatPillarPassesFailsAndRespectsConfigurableThreshold);
  await run('gate: float pillar not-checked and fetch-failed are distinct', testFloatPillarNotCheckedAndFetchFailedAreDistinct);
  await run('gate: the volume-consistency backstop catches BIAF/GRI-shaped false passes', testFloatVolumeConsistencyBackstop);
  await run('gate: the volume-consistency backstop allows plausible extreme-momentum ratios', testFloatVolumeConsistencyAllowsPlausibleRatios);
  await run('gate: the volume-consistency backstop is skipped cleanly when todayVolume is unavailable', testFloatVolumeConsistencySkippedWhenVolumeUnavailable);
  await run('gate: the 180-day staleness fallback bound fires only when volume data is unavailable', testStalenessFallbackBoundFiresOnlyWithoutVolumeData);
  await run('gate: classifyGate treats float as substantive as of Phase 6', testClassifyGateTreatsFloatAsSubstantiveAsOfPhase6);
  await run('gate: float is applied last but not further short-circuited by other stage-2 fails', testFloatAppliedLastNotFurtherShortCircuitedByOtherStage2Fails);
  await run('gate: evaluateGateBatch fetches float only for pillar12Survivors and reads the configured threshold', testEvaluateGateBatchFetchesFloatOnlyForPillar12SurvivorsAndReadsConfiguredThreshold);
  await run('gate: evaluateGateBatch reports null table info when float is never fetched', testEvaluateGateBatchReportsNullTableInfoWhenFloatNeverFetched);
  await run('gate: short-circuits on Pillar 1 failure without consulting rvol/news inputs', testGateShortCircuitsOnPillar1Failure);
  await run('gate: news is genuinely evaluated even when rvol fails (root-cause fix)', testGateEvaluatesNewsEvenWhenRvolFails);
  await run('gate: classify QUALIFIED / NEAR_MISS / neither', testClassifyQualifiedAndNearMiss);
  await run('gate: Pillar 3 fetch-failed is distinct from not-checked and fail', testPillar3FetchFailedDistinctFromNotCheckedAndFail);
  await run('gate: Pillar 4 fetch-failed is distinct from fail (the worst version of the original bug)', testPillar4FetchFailedDistinctFromFail);
  await run('gate: classifyGate BLOCKS on any fetch-failed pillar', testClassifyGateBlocksOnFetchFailed);
  await run('gate: evaluateGateBatch threads a fetch failure through to a BLOCKED tier end-to-end', testEvaluateGateBatchThreadsFailedSymbolsToBlocked);
  await run('gate: evaluateGateBatch fetches once for the whole survivor set, not per-candidate', testEvaluateGateBatchNeverCallsPerCandidate);
  await run('gate: rvolCheckable flag reflects session structurally, without burning a request when already known', testRvolCheckableFlagReflectsSessionStructurally);
  await run('gate: diagnoseGateCost selects the right strategy per session and reports real shape', testDiagnoseGateCostShapeAndStrategySelection);
})();
