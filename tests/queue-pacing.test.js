// tests/queue-pacing.test.js — core/api-client.js's token bucket.
//
// Phase 0.5 acceptance criterion (docs/warrior-engine-spec-v2.md, rewritten
// 2026-08-24): a rate assertion must ALSO prove it drove the bucket below
// its burst buffer, with token counts logged at start/mid/end as evidence.
//
// This file's own history is the evidence for why that rule exists — THREE
// separate false-alarm "violations" during its own construction, each one
// a measurement artifact, not a bucket bug:
//   1. 300 requests @ 200ms latency -> 288.8/min "violation". Root cause:
//      natural demand (300/min) never outpaced refill enough to exhaust the
//      200-token buffer within the run; _tokens sat at 76-198 throughout.
//      Never actually exercised the rate limit.
//   2. 260 requests @ 5ms latency, asserting over the literal last-100
//      dispatches -> 314/min "violation" even with _tokens=0.00 confirmed
//      at the end. Root cause: dispatches #200-208 were still burning
//      leftover banked capacity (~16ms gaps, tokens 8.16 -> 0.53, correctly
//      fast) before genuine throttling began at #209 (gaps jump to
//      330-410ms and stay there). The "last N" window straddled that
//      transition and averaged fast pre-exhaustion dispatches together
//      with correctly-throttled ones.
//   3. (This file's actual methodology, below): the rate must be measured
//      ONLY from the first dispatch where the token spent left less than 1
//      remaining — that's the actual boundary between "spending banked
//      capacity" and "genuinely rate-limited" — not a fixed-size tail
//      slice, which can straddle that boundary depending on how much
//      capacity happened to be left over at whatever point the slice starts.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const apiClientSrc = readSource('core/api-client.js');

// Loads a fresh, isolated copy of the module (its own _tokens/_queue/etc —
// eval'ing the source twice creates two disconnected states, so `enqueue`
// and the token accessor MUST come from the same eval call to actually
// share the module's internal state).
function loadFreshQueue() {
  const exposeCode = `
    global.__enqueue = enqueue;
    global.__readTokens = () => _tokens;
    global.__RATE_LIMIT_PER_MIN = RATE_LIMIT_PER_MIN;
    global.__RATE_LIMIT_TARGET_PER_MIN = RATE_LIMIT_TARGET_PER_MIN;
  `;
  // eslint-disable-next-line no-eval
  eval(apiClientSrc + '\n' + exposeCode);
  return {
    enqueue: global.__enqueue,
    readTokens: global.__readTokens,
    RATE_LIMIT_PER_MIN: global.__RATE_LIMIT_PER_MIN,
    RATE_LIMIT_TARGET_PER_MIN: global.__RATE_LIMIT_TARGET_PER_MIN,
  };
}

async function testBucketPacesUnderGenuineExhaustion() {
  const { enqueue, readTokens, RATE_LIMIT_PER_MIN, RATE_LIMIT_TARGET_PER_MIN } = loadFreshQueue();

  // 5ms mock latency -> natural unthrottled demand is 12,000/min, so the
  // 200-token buffer is provably exhausted well within this burst.
  const MOCK_LATENCY_MS = 5;
  const TOTAL = 260;
  const dispatchTimes = [];
  const tokensRemainingAfterDispatch = [];
  const tokenTrace = [];

  function mockRequest() {
    return async () => {
      dispatchTimes.push(Date.now());
      tokensRemainingAfterDispatch.push(readTokens());
      await new Promise(r => setTimeout(r, MOCK_LATENCY_MS));
      return 'ok';
    };
  }

  const t0 = Date.now();
  tokenTrace.push({ label: 'start', t: 0, tokens: readTokens() });

  const promises = [];
  for (let i = 0; i < TOTAL; i++) {
    promises.push(enqueue(mockRequest(), { engine: 'EDGE', priority: 'foreground' }));
    if (i === Math.floor(TOTAL / 2)) {
      tokenTrace.push({ label: 'mid-enqueue', t: Date.now() - t0, tokens: readTokens() });
    }
  }
  await Promise.all(promises);
  tokenTrace.push({ label: 'end', t: Date.now() - t0, tokens: readTokens() });

  console.log('Token trace (start/mid/end) — the burst-exhaustion proof:');
  tokenTrace.forEach(p => console.log(`  ${p.label.padEnd(12)} t=${p.t}ms  _tokens=${p.tokens.toFixed(2)}`));

  const endTokens = tokenTrace[tokenTrace.length - 1].tokens;
  assert.ok(endTokens < 5, `burst buffer was NOT exhausted (_tokens=${endTokens.toFixed(2)} at end)`);

  // The actual boundary between "spending banked capacity" (correctly
  // fast) and "genuinely rate-limited" (correctly ~refill-interval-paced)
  // is the first dispatch that leaves less than 1 token remaining — NOT an
  // arbitrary tail slice, which can straddle that boundary. Everything from
  // that index onward is the only valid window for a rate assertion.
  const throttleStartIdx = tokensRemainingAfterDispatch.findIndex(t => t < 1);
  assert.ok(throttleStartIdx !== -1 && throttleStartIdx < TOTAL - 20, `never observed genuine throttling (tokens stayed >= 1 after every dispatch) — burst was too small/short to prove anything`);

  const throttled = dispatchTimes.slice(throttleStartIdx);
  const throttledElapsedMs = throttled[throttled.length - 1] - throttled[0];
  const throttledRatePerMin = (throttled.length - 1) / (throttledElapsedMs / 60000);

  console.log(`\nGenuine throttling began at dispatch #${throttleStartIdx} (tokens dropped below 1 for the first time).`);
  console.log(`Rate measured from that point on (${throttled.length} dispatches, the only valid window): ${throttledRatePerMin.toFixed(1)}/min`);
  console.log(`Target: ${RATE_LIMIT_TARGET_PER_MIN}/min | Hard cap: ${RATE_LIMIT_PER_MIN}/min`);

  assert.ok(throttledRatePerMin <= RATE_LIMIT_PER_MIN, `throttled-phase rate ${throttledRatePerMin.toFixed(1)}/min exceeded the hard cap ${RATE_LIMIT_PER_MIN}/min`);
  assert.ok(throttledRatePerMin >= RATE_LIMIT_TARGET_PER_MIN * 0.85 && throttledRatePerMin <= RATE_LIMIT_TARGET_PER_MIN * 1.15, `throttled-phase rate ${throttledRatePerMin.toFixed(1)}/min is not within ~15% of target ${RATE_LIMIT_TARGET_PER_MIN}/min`);
}

async function testUnexhaustedBurstIsNotMistakenForAViolation() {
  // Documents the failure mode this whole file exists to prevent: a burst
  // that never exhausts the buffer produces a high "rate" that is NOT a
  // bucket violation. This is the exact shape of false alarm #1 above.
  const { enqueue, readTokens } = loadFreshQueue();

  const MOCK_LATENCY_MS = 200; // natural pace 300/min, close enough to target that a small burst won't exhaust the buffer
  function mockRequest() {
    return async () => { await new Promise(r => setTimeout(r, MOCK_LATENCY_MS)); return 'ok'; };
  }
  const TOTAL = 40;
  const promises = [];
  for (let i = 0; i < TOTAL; i++) promises.push(enqueue(mockRequest(), { engine: 'EDGE', priority: 'foreground' }));
  await Promise.all(promises);
  const endTokens = readTokens();
  console.log(`\n(Negative case) 40 requests at 200ms latency: _tokens=${endTokens.toFixed(2)} — buffer NOT exhausted, as expected.`);
  assert.ok(endTokens > 150, `expected the buffer to still be nearly full for this small a burst (got ${endTokens.toFixed(2)}) — if this fails, the burst-exhaustion threshold above may need revisiting`);
}

(async () => {
  await run('queue-pacing: bucket paces correctly once genuinely exhausted', testBucketPacesUnderGenuineExhaustion);
  await run('queue-pacing: small burst correctly does not exhaust the buffer (negative control)', testUnexhaustedBurstIsNotMistakenForAViolation);
})();
