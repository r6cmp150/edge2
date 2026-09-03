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

async function testFloatNeverStubbedAsPassing() {
  const gate = await loadGate();
  const pFloat = gate.evaluatePillarFloat();
  console.log('Float pillar:', pFloat);
  assert.strictEqual(pFloat.status, 'not-checked');
  assert.notStrictEqual(pFloat.status, 'pass', 'must never be fabricated as passing — the $0.00 P&L failure shape');
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
  assert.strictEqual(result.tier, null, 'a price failure must never classify as NEAR_MISS, regardless of how many other pillars are merely not-checked');
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
  assert.strictEqual(gate.classifyGate(makeResult(['fail', 'not-checked', 'not-checked', 'not-checked', 'not-checked'])), null, 'price is the (short-circuited) only failure -> NOT NEAR_MISS, a basic disqualification');
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'fail', 'not-checked', 'not-checked', 'not-checked'])), null, 'change is the (short-circuited) only failure -> NOT NEAR_MISS');
  // The precise gap a naive "just widen stage 2" fix would have missed:
  // price fails but change happens to PASS (both are evaluated
  // unconditionally, independent of each other) — "exactly one checkable
  // pillar fails" is trivially true here too unless stage 1 is gated as a
  // pair, not counted individually. Must still be null, not NEAR_MISS.
  assert.strictEqual(gate.classifyGate(makeResult(['fail', 'pass', 'not-checked', 'not-checked', 'not-checked'])), null, 'price fails even though change independently passes -> still NOT NEAR_MISS, not a vacuous 1-fail count');
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'fail', 'fail', 'pass', 'not-checked'])), null, 'two failures -> neither tier (defensive — should not occur given short-circuiting, but classify must not misclassify it if it ever did)');
  assert.strictEqual(gate.classifyGate(makeResult(['not-checked', 'not-checked', 'not-checked', 'not-checked', 'not-checked'])), null, 'nothing checkable at all -> neither tier (not a vacuous QUALIFIED)');
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
  assert.strictEqual(gate.classifyGate(makeResult(['fail', 'pass', 'fetch-failed', 'not-checked', 'not-checked'])), null, 'a fetch failure never overrides a real free-pillar disqualification — still plain null, not BLOCKED');
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
  await run('gate: float pillar never stubbed as passing', testFloatNeverStubbedAsPassing);
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
