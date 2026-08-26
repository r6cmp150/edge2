// tests/gate.test.js — engines/warrior/gate.js. docs/warrior-engine-spec-v2.md
// Phase 3. Loads the REAL module via dynamic import() (a genuine ES module,
// unlike the classic-script core/*.js files elsewhere in this suite, so no
// eval/extraction workaround is needed) and exercises its pure functions
// directly — no mocking needed for most of this file, since evaluateGate/
// evaluatePillar1-4/classifyGate/intradayCurve all take their dependencies
// as parameters rather than reading globals.
'use strict';
const assert = require('assert');
const { run } = require('./_lib');

async function loadGate() {
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
  assert.strictEqual(result.pillars[0].status, 'fail'); // price
  assert.strictEqual(result.pillars[1].status, 'pass'); // change (still free/evaluable)
  assert.strictEqual(result.pillars[2].status, 'not-checked'); // rvol — short-circuited, not fabricated as fail
  assert.strictEqual(result.pillars[3].status, 'not-checked'); // news — short-circuited
  // A price failure is a basic disqualification, not "close" — must NOT
  // read as NEAR_MISS just because short-circuiting left only one 'fail'
  // in the array. See classifyGate's NEAR_MISS_ELIGIBLE_PILLAR_IDS.
  assert.strictEqual(result.tier, null, 'a price failure must never classify as NEAR_MISS, regardless of how many other pillars are merely not-checked');
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
  assert.strictEqual(gate.classifyGate(makeResult(['pass', 'fail', 'fail', 'pass', 'not-checked'])), null, 'two failures -> neither tier (defensive — should not occur given short-circuiting, but classify must not misclassify it if it ever did)');
  assert.strictEqual(gate.classifyGate(makeResult(['not-checked', 'not-checked', 'not-checked', 'not-checked', 'not-checked'])), null, 'nothing checkable at all -> neither tier (not a vacuous QUALIFIED)');
}

async function testEvaluateGateBatchNeverCallsPerCandidate() {
  // Verifies the batch orchestration shape without live Alpaca access:
  // mocks the global fetchers gate.js calls and confirms it invokes them
  // ONCE for the whole survivor set, not once per candidate.
  const gate = await loadGate();
  let cumulativeCalls = 0, avgCalls = 0, newsCalls = 0;
  global._fetchCumulativeMinuteVolume = async (symbols) => { cumulativeCalls++; const v = {}; symbols.forEach(s => v[s] = 2_000_000); return { volumeBySymbol: v, requests: 1 }; };
  global._getSip30DayAvgVolume = async (symbols) => { avgCalls++; const v = {}; symbols.forEach(s => v[s] = 1_000_000); return { avgVolumes: v, requests: 1 }; };
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

async function testDiagnoseGateCostShapeAndStrategySelection() {
  const gate = await loadGate();
  let usedStrategy = null;
  global.getUniverse = async ({ session, strategy }) => {
    usedStrategy = strategy;
    return [{ symbol: 'A', price: 5, changePct: 20 }, { symbol: 'B', price: 50, changePct: 5 }]; // A qualifies, B fails price+change
  };
  global._fetchCumulativeMinuteVolume = async (symbols) => { const v = {}; symbols.forEach(s => v[s] = 2_000_000); return { volumeBySymbol: v, requests: 1 }; };
  global._getSip30DayAvgVolume = async (symbols) => { const v = {}; symbols.forEach(s => v[s] = 1_000_000); return { avgVolumes: v, requests: 1 }; };
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
  await run('gate: float pillar never stubbed as passing', testFloatNeverStubbedAsPassing);
  await run('gate: short-circuits on Pillar 1 failure without consulting rvol/news inputs', testGateShortCircuitsOnPillar1Failure);
  await run('gate: classify QUALIFIED / NEAR_MISS / neither', testClassifyQualifiedAndNearMiss);
  await run('gate: evaluateGateBatch fetches once for the whole survivor set, not per-candidate', testEvaluateGateBatchNeverCallsPerCandidate);
  await run('gate: diagnoseGateCost selects the right strategy per session and reports real shape', testDiagnoseGateCostShapeAndStrategySelection);
})();
