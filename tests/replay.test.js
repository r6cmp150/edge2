// tests/replay.test.js — engines/warrior/replay.js, Phase 4's replay
// harness. docs/warrior-engine-spec-v2.md Phase 4. Loads the REAL module
// via dynamic import() (a genuine ES module, like gate.js) and exercises
// its pure functions directly.
'use strict';
const assert = require('assert');
const { run, readSource, evalModule } = require('./_lib');

function bar(t, o, h, l, c, v = 1000) {
  return { t, o, h, l, c, v };
}

// runReplay computes minutesOfSessionRemainingAtTrigger via the REAL
// getPT (core/clock.js), same reasoning as tests/setups.test.js's
// loadClockGlobals — mocking getPT would test nothing about whether
// that computation actually reads PT wall-clock fields correctly.
function loadClockGlobals() {
  global.state = { settings: {} };
  evalModule(readSource('core/clock.js'), { expose: ['getPT', 'ptDateStr', 'ptWallClockToInstant'] });
}

// One bar per minute starting at this PT-equivalent instant, for however
// many entries `closes` supplies. Keeps fixtures short to write and easy
// to reason about minute-offsets from.
function makeBars(closes, startISO = '2026-08-26T13:30:00.000Z') {
  const start = new Date(startISO).getTime();
  return closes.map((c, i) => {
    const t = new Date(start + i * 60000).toISOString();
    return bar(t, c, c, c, c); // flat OHLC unless a test overrides a specific bar
  });
}

async function loadReplay() {
  loadClockGlobals(); // real getPT/ptDateStr/ptWallClockToInstant; individual tests override ptWallClockToInstant with a deterministic stand-in where needed
  global._fetchRawMinuteBars = undefined; // each test sets its own mock before calling fetch-dependent functions
  return import('../engines/warrior/replay.js');
}

// ── runReplay: determinism, edge-triggering ─────────────────────────────

async function testRunReplayDeterministic() {
  const replay = await loadReplay();
  const bars = makeBars([1, 1, 1, 2, 2, 1, 1]); // simple flat-then-flat, threshold classifier below
  const classifier = (barsSoFar) => barsSoFar[barsSoFar.length - 1].c >= 2 ? { setupId: 'flat-jump' } : null;
  const first = replay.runReplay(bars, classifier);
  const second = replay.runReplay(bars, classifier);
  console.log('deterministic run triggers:', JSON.stringify(first));
  assert.deepStrictEqual(first, second, 'same bars + same classifier must produce identical trigger arrays');
}

async function testRunReplayEdgeTriggeredOncePerEpisode() {
  const replay = await loadReplay();
  // Rises above 2 at index 3, stays elevated through index 6, drops back,
  // rises again at index 9 (second, genuinely separate episode).
  const bars = makeBars([1, 1, 1, 2, 2, 2, 2, 1, 1, 2, 2]);
  const classifier = (barsSoFar) => barsSoFar[barsSoFar.length - 1].c >= 2 ? { setupId: 'flat-jump' } : null;
  const triggers = replay.runReplay(bars, classifier);
  console.log('edge-triggered indices:', triggers.map(t => t.triggerIndex));
  assert.strictEqual(triggers.length, 2, 'must record exactly one trigger per continuous episode, not one per elevated bar');
  assert.strictEqual(triggers[0].triggerIndex, 3);
  assert.strictEqual(triggers[1].triggerIndex, 9);
}

// ── Re-arm rule (Phase 5) ─────────────────────────────────────────────────

async function testRearmSuppressesChopButAllowsGenuineSecondBreakout() {
  const replay = await loadReplay();
  // Reproduces the HVII 2026-08-24 shape found via the replay harness: a
  // breakout above 10.0, harmless chop back and forth across the level
  // (never retracing more than ~1%), then a REAL retreat (to 8.50, well
  // past the 1% band) before a genuinely new breakout.
  const bars = makeBars([9.90, 10.10, 9.95, 10.05, 9.95, 10.08, 8.50, 8.60, 10.20]);
  const classifier = (barsSoFar) => {
    const c = barsSoFar[barsSoFar.length - 1].c;
    return c > 10.0 ? { setupId: 'breakout', referenceLevel: 10.0, referenceDirection: 'above' } : null;
  };

  const naive = replay.runReplay(bars, classifier);
  const rearmed = replay.runReplay(bars, classifier, { rearmDistancePct: 1 });
  console.log('naive trigger indices:', naive.map(t => t.triggerIndex), '| re-armed:', rearmed.map(t => t.triggerIndex));

  assert.strictEqual(naive.length, 4, 'naive edge-triggering over-counts chop, same shape as the HVII finding (6 triggers for 1 real event)');
  assert.strictEqual(rearmed.length, 2, 'with rearmDistancePct, only the genuine breakout and the genuine second breakout (after a real retreat) count');
  assert.deepStrictEqual(rearmed.map(t => t.triggerIndex), [1, 8]);
}

async function testRearmBelowDirectionForBreakdownSetups() {
  const replay = await loadReplay();
  // 'below' direction: a breakdown-below-level setup re-arms only once
  // price rallies back ABOVE level*(1+rearmDistancePct/100) — the mirror
  // image of the 'above' case, included since a future short-side setup
  // would need it even though none of Phase 5's five setups do.
  const bars = makeBars([10.10, 9.90, 10.05, 9.95, 11.50, 11.40, 9.80]);
  const classifier = (barsSoFar) => {
    const c = barsSoFar[barsSoFar.length - 1].c;
    return c < 10.0 ? { setupId: 'breakdown', referenceLevel: 10.0, referenceDirection: 'below' } : null;
  };
  const rearmed = replay.runReplay(bars, classifier, { rearmDistancePct: 1 });
  console.log('below-direction re-armed indices:', rearmed.map(t => t.triggerIndex));
  // i=1 (9.90) triggers. i=3 (9.95) is still within 1% of 10.0, no re-arm.
  // i=4 (11.50) is well above 10.10 -> re-arms. i=6 (9.80) is a genuine new breakdown.
  assert.deepStrictEqual(rearmed.map(t => t.triggerIndex), [1, 6]);
}

async function testRearmTriggerRecordCarriesReferenceLevelAndMargins() {
  const replay = await loadReplay();
  const bars = makeBars([9.90, 10.10]);
  const classifier = (barsSoFar) => {
    const c = barsSoFar[barsSoFar.length - 1].c;
    return c > 10.0 ? { setupId: 'breakout', referenceLevel: 10.0, referenceDirection: 'above', margins: { volumeMultiple: 4.2, threshold: 3.0 } } : null;
  };
  const [trigger] = replay.runReplay(bars, classifier, { rearmDistancePct: 1 });
  assert.strictEqual(trigger.referenceLevel, 10.0);
  assert.deepStrictEqual(trigger.margins, { volumeMultiple: 4.2, threshold: 3.0 });
}

// ── No-lookahead: structural control ────────────────────────────────────

async function testNoLookaheadStructuralControl() {
  const replay = await loadReplay();
  const SENTINEL = 999999;
  const closes = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  closes[6] = SENTINEL; // the "future event," planted at index 6
  const bars = makeBars(closes);
  // Checks whether the sentinel is visible ANYWHERE in what it's given —
  // not just the current bar — because a leaking loop that hands out the
  // full array every call would otherwise still only expose its true
  // final element as "the last bar," which isn't where the sentinel
  // lives; this shape is also more representative of a real
  // lookahead-sensitive classifier (cumulative/history-aware, not just a
  // single-bar check).
  const classifier = (barsSoFar) => barsSoFar.some(b => b.c === SENTINEL) ? { setupId: 'sentinel' } : null;

  const realTriggers = replay.runReplay(bars, classifier);
  console.log('real (truncating) loop trigger index:', realTriggers[0]?.triggerIndex);
  assert.strictEqual(realTriggers.length, 1);
  assert.strictEqual(realTriggers[0].triggerIndex, 6, 'the real loop must only trigger once the replay index actually reaches the sentinel bar');

  // Deliberately broken stand-in — the exact mistake the spec calls "the
  // single easiest mistake to make here": hands the classifier the FULL
  // array every call instead of a truncated prefix. If runReplay ever
  // regressed to this shape, this same test would catch it, because the
  // classifier can now see the sentinel from bar 0 onward.
  function brokenReplay(allBars, fn) {
    const triggers = [];
    let active = null;
    for (let i = 0; i < allBars.length; i++) {
      const verdict = fn(allBars); // BUG: full array, not allBars.slice(0, i + 1)
      if (!verdict) { active = null; continue; }
      if (verdict.setupId === active) continue;
      active = verdict.setupId;
      triggers.push({ setupId: verdict.setupId, triggerIndex: i });
    }
    return triggers;
  }
  const brokenTriggers = brokenReplay(bars, classifier);
  console.log('broken (leaking) loop trigger index:', brokenTriggers[0]?.triggerIndex);
  assert.strictEqual(brokenTriggers[0].triggerIndex, 0, 'a genuinely leaking loop would trigger immediately at index 0 — proving the real loop\'s correct index-6 result is a real guarantee, not a coincidence of this fixture');
}

// ── No-lookahead: anchoring control (mitigation, not prevention) ────────

async function testNoLookaheadAnchoringControlIsAMitigationNotAGuarantee() {
  const replay = await loadReplay();
  const bars = makeBars([1, 1, 1, 1, 1]);
  // Deliberately closes over the full array from OUTSIDE the harness —
  // a real, plausible authoring mistake (e.g. a classifier that reads
  // module-level state instead of its own argument) that no amount of
  // argument-slicing inside runReplay can prevent; JS cannot sandbox a
  // closure. This classifier ignores barsSoFar entirely and self-reports
  // a fabricated future price the moment it's first called.
  const cheatingClassifier = () => ({ setupId: 'cheat', triggerPrice: 888888, triggerTime: '2099-01-01T00:00:00.000Z' });

  const triggers = replay.runReplay(bars, cheatingClassifier);
  assert.strictEqual(triggers.length, 1, 'the cheat is NOT prevented from deciding to trigger early — that is the honest limitation, documented, not hidden');
  assert.strictEqual(triggers[0].triggerIndex, 0);
  // What IS guaranteed: the harness never reads price/time off the
  // classifier's return value. It derives both from barsSoFar's own last
  // element (== bars[0] here), so the recorded trigger reflects only what
  // was actually knowable at that replay position, regardless of what the
  // classifier itself tried to claim.
  console.log('cheat requested price 888888 / recorded price:', triggers[0].triggerPrice);
  assert.strictEqual(triggers[0].triggerPrice, bars[0].c, 'triggerPrice must come from the actual bar at the trigger index, never the classifier\'s self-report');
  assert.strictEqual(triggers[0].triggerTime, bars[0].t, 'triggerTime must likewise be harness-derived, never classifier-supplied');
  assert.notStrictEqual(triggers[0].triggerPrice, 888888);
}

// ── computeForwardReturns: values, nulls, MFE/MAE ────────────────────────

async function testComputeForwardReturnsCorrectValues() {
  const replay = await loadReplay();
  // Trigger at index 0, price 100. Spikes to 130 at +3m (well inside the
  // 5m horizon) then settles back to 102 by +5m — exactly the "+20% then
  // closes flat" shape the spec calls out: the close-based 5m return
  // (2%) alone would read this as a mediocre trade; MFE (30%) shows what
  // it actually was.
  const bars = [
    bar('2026-08-26T13:30:00.000Z', 100, 100, 100, 100),
    bar('2026-08-26T13:31:00.000Z', 100, 105, 99, 104),
    bar('2026-08-26T13:32:00.000Z', 104, 110, 103, 108),
    bar('2026-08-26T13:33:00.000Z', 108, 130, 107, 128), // MFE peak: high=130
    bar('2026-08-26T13:34:00.000Z', 128, 129, 95, 96),   // MAE trough: low=95
    bar('2026-08-26T13:35:00.000Z', 96, 103, 96, 102),   // the +5m horizon bar
  ];
  const fr = replay.computeForwardReturns(bars, 0);
  console.log('5m horizon:', fr['5m']);
  assert.ok(Math.abs(fr['5m'].return - 2) < 0.001, `expected +2% close-based return, got ${fr['5m'].return}`);
  assert.ok(Math.abs(fr['5m'].mfe - 30) < 0.001, `expected +30% MFE (high=130 vs trigger=100), got ${fr['5m'].mfe}`);
  assert.ok(Math.abs(fr['5m'].mae - (-5)) < 0.001, `expected -5% MAE (low=95 vs trigger=100), got ${fr['5m'].mae}`);
}

async function testComputeForwardReturnsNullWhenHorizonUnavailable() {
  const replay = await loadReplay();
  // Only 3 bars total: trigger at index 0, two bars after it (+1m, +2m).
  // None of 5m/15m/30m/close... close DOES resolve (last bar exists);
  // the timed horizons do not.
  const bars = [
    bar('2026-08-26T13:30:00.000Z', 100, 100, 100, 100),
    bar('2026-08-26T13:31:00.000Z', 100, 102, 99, 101),
    bar('2026-08-26T13:32:00.000Z', 101, 103, 100, 103),
  ];
  const fr = replay.computeForwardReturns(bars, 0);
  console.log('short-session horizons:', fr);
  assert.strictEqual(fr['5m'].return, null, '5m horizon must be null when the session doesn\'t reach it — not a partial/misleading 2-minute window mislabeled as 5m');
  assert.strictEqual(fr['5m'].mfe, null);
  assert.strictEqual(fr['5m'].mae, null);
  assert.strictEqual(fr['15m'].return, null);
  assert.strictEqual(fr['30m'].return, null);
  assert.notStrictEqual(fr.close.return, null, 'close must resolve as long as at least one bar exists after the trigger');
  assert.ok(Math.abs(fr.close.return - 3) < 0.001);
}

async function testComputeForwardReturnsAllNullWhenTriggerIsLastBar() {
  const replay = await loadReplay();
  const bars = [bar('2026-08-26T13:30:00.000Z', 100, 100, 100, 100)];
  const fr = replay.computeForwardReturns(bars, 0);
  console.log('trigger-is-last-bar horizons:', fr);
  for (const key of ['5m', '15m', '30m', 'close']) {
    assert.strictEqual(fr[key].return, null, `${key} must be null when the trigger is the last available bar`);
  }
}

// ── minutesOfSessionRemainingAtTrigger (close-horizon comparability) ─────
// Live-replay finding (2026-08-28): AMIX triggers 6 minutes before the
// window's close scored +9.7%/+15.9% "to close"; HVII triggers hours
// earlier scored -3.3%/-7.3% — not because one setup was better, but
// because "close" measures completely different amounts of real time
// depending on when the trigger happened. Kept as a metric (free,
// sometimes genuinely useful) rather than deleted, but every trigger now
// carries this field precisely so that incomparability is visible on the
// row instead of silently misleading a reader who takes "close" at face
// value the way the live run's first pass did.

async function testMinutesOfSessionRemainingAtTriggerComputedFromPTClose() {
  const replay = await loadReplay();
  // makeBars' default start (2026-08-26T13:30:00.000Z) is exactly 6:30am
  // PT (PDT, UTC-7) -- bar index N is N minutes after the regular-session
  // open, so "minutes until 1:00pm PT close" for bar N is 390 - N.
  const bars = makeBars([1, 1, 1, 1, 1, 2]); // trigger at index 5
  const classifier = (barsSoFar) => barsSoFar[barsSoFar.length - 1].c >= 2 ? { setupId: 'x' } : null;
  const [trigger] = replay.runReplay(bars, classifier);
  console.log('minutesOfSessionRemainingAtTrigger:', trigger.minutesOfSessionRemainingAtTrigger);
  assert.strictEqual(trigger.minutesOfSessionRemainingAtTrigger, 390 - 5);
}

async function testMinutesOfSessionRemainingAtTriggerMakesCloseHorizonInterpretable() {
  const replay = await loadReplay();
  const classifier = (barsSoFar) => barsSoFar[barsSoFar.length - 1].c >= 2 ? { setupId: 'x' } : null;

  // Early trigger: hours of real time left before the window's close.
  const earlyBars = makeBars([1, 2, ...Array(60).fill(1.5)]); // trigger at index 1 (6:31am PT), 60 more bars follow
  const [earlyTrigger] = replay.runReplay(earlyBars, classifier);

  // Late trigger: minutes before the window's close (mirrors AMIX firing
  // 6 minutes before end of window).
  const lateBars = [...makeBars(Array(383).fill(1)), ...makeBars([2, 1, 1, 1, 1, 1], '2026-08-26T19:53:00.000Z')];
  const [lateTrigger] = replay.runReplay(lateBars, classifier);

  console.log('early remaining:', earlyTrigger.minutesOfSessionRemainingAtTrigger, '| late remaining:', lateTrigger.minutesOfSessionRemainingAtTrigger);
  assert.ok(earlyTrigger.minutesOfSessionRemainingAtTrigger > 300, 'an early trigger should show hours of session remaining');
  assert.ok(lateTrigger.minutesOfSessionRemainingAtTrigger <= 10, 'a late trigger should show only minutes of session remaining');
  assert.ok(earlyTrigger.minutesOfSessionRemainingAtTrigger - lateTrigger.minutesOfSessionRemainingAtTrigger > 250,
    'the whole point: two triggers whose "close" return might look superficially comparable have wildly different real time behind that number, and this field is what makes that visible');
}

// ── examplePriceMoveClassifier ───────────────────────────────────────────

async function testExamplePriceMoveClassifierThreshold() {
  const replay = await loadReplay();
  const under = [bar('t0', 100, 100, 100, 100), bar('t1', 100, 109, 100, 109)]; // +9%, below CHANGE_MIN_PCT (10)
  const at = [bar('t0', 100, 100, 100, 100), bar('t1', 100, 110, 100, 110)]; // exactly +10%
  const over = [bar('t0', 100, 100, 100, 100), bar('t1', 100, 115, 100, 115)]; // +15%
  assert.strictEqual(replay.examplePriceMoveClassifier(under), null);
  assert.ok(replay.examplePriceMoveClassifier(at), 'exactly at CHANGE_MIN_PCT must trigger (>=), matching Pillar 2\'s own >= semantics');
  assert.ok(replay.examplePriceMoveClassifier(over));
}

// ── fetchReplayBars: window, chunk size, ordering ────────────────────────

async function testFetchReplayBarsUsesCorrectWindowChunkSizeAndOrdering() {
  const replay = await loadReplay();
  let captured = null;
  global.ptWallClockToInstant = (dateStr, hour, minute) => new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`); // deterministic stand-in, not the real PT conversion (that's pt-wall-clock.test.js's job)
  global._fetchRawMinuteBars = async (symbols, start, end, chunkSize, label) => {
    captured = { symbols, start, end, chunkSize, label };
    return {
      barsBySymbolAll: { AAPL: [bar('t2', 3, 3, 3, 3), bar('t1', 2, 2, 2, 2), bar('t0', 1, 1, 1, 1)] }, // desc order, as the real primitive returns
      requests: 1,
    };
  };

  const { barsBySymbol, requests } = await replay.fetchReplayBars(['AAPL'], '2026-08-26');
  console.log('captured fetch args:', { chunkSize: captured.chunkSize, start: captured.start.toISOString(), end: captured.end.toISOString() });
  assert.strictEqual(captured.chunkSize, replay.REPLAY_CHUNK_SIZE);
  assert.strictEqual(captured.start.toISOString(), '2026-08-26T01:00:00.000Z', 'default start must be 1:00am (stand-in maps straight through)');
  assert.strictEqual(captured.end.toISOString(), '2026-08-26T13:00:00.000Z', 'default end must be 1:00pm');
  assert.strictEqual(requests, 1);
  assert.deepStrictEqual(barsBySymbol.AAPL.map(b => b.c), [1, 2, 3], 'must be reversed to ascending (chronological) order for replay');
}

// ── fetchPrevCloseAsOf ────────────────────────────────────────────────────

async function testFetchPrevCloseAsOfPicksMostRecentCloseBeforeReplayWindow() {
  const replay = await loadReplay();
  global.ptWallClockToInstant = (dateStr, hour, minute) => new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
  let capturedParams = null;
  global.alpacaGet = async (path, params) => {
    capturedParams = params;
    return {
      bars: {
        AAPL: [
          { t: '2026-08-25T20:00:00Z', c: 150.25 }, // most recent (sort:desc -> first)
          { t: '2026-08-24T20:00:00Z', c: 148.00 },
        ],
      },
    };
  };
  const { prevCloseBySymbol, requests } = await replay.fetchPrevCloseAsOf(['AAPL'], '2026-08-26');
  console.log('prevClose result:', prevCloseBySymbol, '| params:', { timeframe: capturedParams.timeframe, sort: capturedParams.sort, feed: capturedParams.feed });
  assert.strictEqual(prevCloseBySymbol.AAPL.close, 150.25, 'must take the most recent (first, since sort:desc) close strictly before the replay window');
  assert.strictEqual(prevCloseBySymbol.AAPL.date, '2026-08-25', 'must report the PT calendar date the close is actually FROM, not assume it matches the caller\'s expectation');
  assert.strictEqual(capturedParams.timeframe, '1Day');
  assert.strictEqual(capturedParams.sort, 'desc');
  assert.strictEqual(capturedParams.feed, 'sip', 'must use feed=sip like every other Warrior bar request (CLAUDE.md rule)');
  assert.strictEqual(requests, 1);
}

async function testFetchPrevCloseAsOfFollowsPagination() {
  const replay = await loadReplay();
  global.ptWallClockToInstant = (dateStr, hour, minute) => new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
  let callCount = 0;
  global.alpacaGet = async (path, params) => {
    callCount++;
    if (!params.page_token) {
      return { bars: { AAPL: [{ t: '2026-08-25T20:00:00Z', c: 150.25 }] }, next_page_token: 'page2' };
    }
    return { bars: { AAPL: [{ t: '2026-08-24T20:00:00Z', c: 148.00 }] } };
  };
  const { prevCloseBySymbol, requests } = await replay.fetchPrevCloseAsOf(['AAPL'], '2026-08-26');
  console.log('paginated prevClose:', prevCloseBySymbol, 'calls:', callCount);
  assert.strictEqual(callCount, 2, 'must follow next_page_token to exhaustion, not stop at the first page');
  assert.strictEqual(requests, 2);
  assert.strictEqual(prevCloseBySymbol.AAPL.close, 150.25, 'first page (sort:desc) still carries the actual most-recent close');
  assert.strictEqual(prevCloseBySymbol.AAPL.date, '2026-08-25', 'date must come from the actual most-recent bar even when pagination was needed to find it');
}

async function testReplayChunkSizeIsSinglePageForDefaultWindow() {
  const replay = await loadReplay();
  const DEFAULT_WINDOW_MIN = 720;
  const worstCaseBars = replay.REPLAY_CHUNK_SIZE * DEFAULT_WINDOW_MIN;
  console.log(`REPLAY_CHUNK_SIZE=${replay.REPLAY_CHUNK_SIZE}, worst-case bars at ${DEFAULT_WINDOW_MIN}min = ${worstCaseBars}`);
  assert.ok(worstCaseBars <= 10000, `must stay single-page: ${worstCaseBars} > 10000`);
  const nextSize = (replay.REPLAY_CHUNK_SIZE + 1) * DEFAULT_WINDOW_MIN;
  assert.ok(nextSize > 10000, `REPLAY_CHUNK_SIZE must be the TIGHT bound — ${replay.REPLAY_CHUNK_SIZE + 1} would give ${nextSize}, still under 10000, meaning REPLAY_CHUNK_SIZE is needlessly small`);
}

// ── runReplayForSymbols: orchestration ───────────────────────────────────

async function testRunReplayForSymbolsOrchestratesFetchAndReplay() {
  const replay = await loadReplay();
  global.ptWallClockToInstant = (dateStr, hour, minute) => new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
  global._fetchRawMinuteBars = async (symbols) => {
    const barsBySymbolAll = {};
    symbols.forEach(sym => {
      barsBySymbolAll[sym] = [bar('2026-08-26T13:31:00.000Z', 100, 115, 100, 115), bar('2026-08-26T13:30:00.000Z', 100, 100, 100, 100)];
    });
    return { barsBySymbolAll, requests: 1 };
  };
  const { resultsBySymbol, requests } = await replay.runReplayForSymbols(['AAPL', 'TSLA'], '2026-08-26');
  console.log('orchestration result:', JSON.stringify(resultsBySymbol, null, 0));
  assert.strictEqual(requests, 1);
  assert.strictEqual(resultsBySymbol.AAPL.triggers.length, 1, 'the example classifier should fire on the +15% second bar');
  assert.strictEqual(resultsBySymbol.TSLA.triggers.length, 1);
  assert.strictEqual(resultsBySymbol.AAPL.barCount, 2);
}

(async () => {
  await run('replay: runReplay is deterministic', testRunReplayDeterministic);
  await run('replay: runReplay is edge-triggered, one record per episode', testRunReplayEdgeTriggeredOncePerEpisode);
  await run('replay: re-arm rule suppresses chop, allows a genuine second breakout (reproduces the HVII finding)', testRearmSuppressesChopButAllowsGenuineSecondBreakout);
  await run('replay: re-arm rule, below-direction for breakdown setups', testRearmBelowDirectionForBreakdownSetups);
  await run('replay: re-arm trigger record carries referenceLevel and margins', testRearmTriggerRecordCarriesReferenceLevelAndMargins);
  await run('replay: no-lookahead structural control (real loop correct, broken stand-in exposed)', testNoLookaheadStructuralControl);
  await run('replay: no-lookahead anchoring control is a mitigation, not a guarantee', testNoLookaheadAnchoringControlIsAMitigationNotAGuarantee);
  await run('replay: computeForwardReturns — correct return/MFE/MAE values', testComputeForwardReturnsCorrectValues);
  await run('replay: computeForwardReturns — null (not fabricated) when a horizon is unreachable', testComputeForwardReturnsNullWhenHorizonUnavailable);
  await run('replay: computeForwardReturns — all null when trigger is the last bar', testComputeForwardReturnsAllNullWhenTriggerIsLastBar);
  await run('replay: minutesOfSessionRemainingAtTrigger computed from PT session close', testMinutesOfSessionRemainingAtTriggerComputedFromPTClose);
  await run('replay: minutesOfSessionRemainingAtTrigger makes the close horizon interpretable (reproduces the AMIX/HVII finding)', testMinutesOfSessionRemainingAtTriggerMakesCloseHorizonInterpretable);
  await run('replay: examplePriceMoveClassifier threshold (reuses gate.js\'s real CHANGE_MIN_PCT)', testExamplePriceMoveClassifierThreshold);
  await run('replay: fetchReplayBars — window/chunk-size/ordering', testFetchReplayBarsUsesCorrectWindowChunkSizeAndOrdering);
  await run('replay: fetchPrevCloseAsOf picks the most recent close before the replay window', testFetchPrevCloseAsOfPicksMostRecentCloseBeforeReplayWindow);
  await run('replay: fetchPrevCloseAsOf follows pagination to exhaustion', testFetchPrevCloseAsOfFollowsPagination);
  await run('replay: REPLAY_CHUNK_SIZE is provably single-page for the default window, and tight', testReplayChunkSizeIsSinglePageForDefaultWindow);
  await run('replay: runReplayForSymbols orchestrates fetch + per-symbol replay', testRunReplayForSymbolsOrchestratesFetchAndReplay);
})();
