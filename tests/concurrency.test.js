// tests/concurrency.test.js — core/api-client.js's elastic worker spin-up
// (_activeWorkers / MAX_CONCURRENT / _drain / _drainWorker).
//
// The hard condition this exists to prove (per the Phase 0.5 gate):
// concurrency must never let dispatch outrun the token bucket. Both limits
// have to hold AT THE SAME TIME, under a burst large enough to genuinely
// exhaust the bucket — not a burst too small to exercise it (see
// queue-pacing.test.js's header for why that distinction matters; the same
// methodology is reused here).
//
// This also replaces the first (buggy) concurrency attempt's test, which
// asserted over an arbitrary "last N dispatches" window and never caught
// that maxInFlight was actually 1 — the fixed-Promise.all(6) design starved
// itself down to a single effective worker on a shallow-queue burst. That
// bug is exactly why _drain is now elastic (see core/api-client.js).
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const apiClientSrc = readSource('core/api-client.js');

function loadFreshQueue() {
  const exposeCode = `
    global.__enqueue = enqueue;
    global.__readTokens = () => _tokens;
    global.__readActiveWorkers = () => _activeWorkers;
    global.__RATE_LIMIT_PER_MIN = RATE_LIMIT_PER_MIN;
    global.__RATE_LIMIT_TARGET_PER_MIN = RATE_LIMIT_TARGET_PER_MIN;
    global.__MAX_CONCURRENT = MAX_CONCURRENT;
  `;
  // eslint-disable-next-line no-eval
  eval(apiClientSrc + '\n' + exposeCode);
  return {
    enqueue: global.__enqueue,
    readTokens: global.__readTokens,
    readActiveWorkers: global.__readActiveWorkers,
    RATE_LIMIT_PER_MIN: global.__RATE_LIMIT_PER_MIN,
    RATE_LIMIT_TARGET_PER_MIN: global.__RATE_LIMIT_TARGET_PER_MIN,
    MAX_CONCURRENT: global.__MAX_CONCURRENT,
  };
}

async function testMaxInFlightRespectedOnAShallowBurst() {
  // Deliberately reproduces the exact shape that broke the first attempt:
  // enqueue many items synchronously, back-to-back, so _drain() first fires
  // while _queue is still shallow (1 item). If workers are still spun up as
  // a one-time fixed batch, this reproduces maxInFlight=1. With the elastic
  // design, later enqueue() calls should top workers back up to
  // MAX_CONCURRENT as the queue fills.
  const { enqueue, MAX_CONCURRENT } = loadFreshQueue();
  const MOCK_LATENCY_MS = 200;
  let inFlight = 0, maxInFlight = 0;

  function mockRequest() {
    return async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, MOCK_LATENCY_MS));
      inFlight--;
      return 'ok';
    };
  }

  const TOTAL = 30; // small burst, well under the 200-token buffer — isolates concurrency behavior from bucket exhaustion
  const promises = [];
  for (let i = 0; i < TOTAL; i++) promises.push(enqueue(mockRequest(), { engine: 'EDGE', priority: 'foreground' }));
  await Promise.all(promises);

  console.log(`Max concurrent in flight: ${maxInFlight} (expect exactly ${MAX_CONCURRENT}, not 1 — the original bug's signature)`);
  assert.strictEqual(maxInFlight, MAX_CONCURRENT, `expected max in-flight to reach MAX_CONCURRENT (${MAX_CONCURRENT}); got ${maxInFlight} — this is the exact symptom of the reverted fixed-batch bug if it regresses`);
}

async function testConcurrencyNeverExceedsCap() {
  // Same shallow-burst-at-start shape, but asserts the cap is never
  // EXCEEDED (a different failure mode than "starves to 1" — over-spawning).
  const { enqueue, MAX_CONCURRENT } = loadFreshQueue();
  let inFlight = 0, maxInFlight = 0, overCapObserved = false;

  function mockRequest() {
    return async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight > MAX_CONCURRENT) overCapObserved = true;
      await new Promise(r => setTimeout(r, 50));
      inFlight--;
      return 'ok';
    };
  }

  const TOTAL = 60;
  const promises = [];
  for (let i = 0; i < TOTAL; i++) promises.push(enqueue(mockRequest(), { engine: 'EDGE', priority: 'foreground' }));
  await Promise.all(promises);

  console.log(`Max concurrent in flight: ${maxInFlight}, ever exceeded cap: ${overCapObserved}`);
  assert.strictEqual(overCapObserved, false, `concurrency cap ${MAX_CONCURRENT} was exceeded at some point during the run`);
  assert.ok(maxInFlight <= MAX_CONCURRENT);
}

async function testConcurrencyAndBucketBothHoldUnderGenuineExhaustion() {
  // The actual hard condition from the user's gate: concurrency and the
  // token bucket enforced SIMULTANEOUSLY, under a burst large enough to
  // genuinely exhaust the 200-token buffer (same burst-exhaustion
  // methodology as queue-pacing.test.js — the rate window is selected from
  // the first dispatch where tokens actually drop below 1, not a fixed
  // tail slice, for the same reason documented there).
  const { enqueue, readTokens, MAX_CONCURRENT, RATE_LIMIT_PER_MIN, RATE_LIMIT_TARGET_PER_MIN } = loadFreshQueue();
  const MOCK_LATENCY_MS = 5;
  const TOTAL = 260;
  let inFlight = 0, maxInFlight = 0;
  const dispatchTimes = [];
  const tokensRemainingAfterDispatch = [];

  function mockRequest() {
    return async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      dispatchTimes.push(Date.now());
      tokensRemainingAfterDispatch.push(readTokens());
      await new Promise(r => setTimeout(r, MOCK_LATENCY_MS));
      inFlight--;
      return 'ok';
    };
  }

  const t0 = Date.now();
  const promises = [];
  for (let i = 0; i < TOTAL; i++) promises.push(enqueue(mockRequest(), { engine: 'EDGE', priority: 'foreground' }));
  await Promise.all(promises);
  const totalMs = Date.now() - t0;
  const endTokens = readTokens();

  console.log(`\nCompleted ${TOTAL} requests in ${(totalMs / 1000).toFixed(1)}s (concurrency enabled, MAX_CONCURRENT=${MAX_CONCURRENT})`);
  console.log(`Max concurrent in flight: ${maxInFlight} (must be <= ${MAX_CONCURRENT})`);
  console.log(`_tokens at end: ${endTokens.toFixed(2)} (must be near-zero to prove genuine exhaustion)`);

  assert.ok(maxInFlight <= MAX_CONCURRENT, `max in-flight ${maxInFlight} exceeded MAX_CONCURRENT ${MAX_CONCURRENT}`);
  assert.ok(endTokens < 5, `burst buffer was not exhausted (_tokens=${endTokens.toFixed(2)}) — this run proves nothing about bucket pacing`);

  const throttleStartIdx = tokensRemainingAfterDispatch.findIndex(t => t < 1);
  assert.ok(throttleStartIdx !== -1 && throttleStartIdx < TOTAL - 20, 'never observed genuine throttling — burst too small to prove anything');

  const throttled = dispatchTimes.slice(throttleStartIdx);
  const throttledElapsedMs = throttled[throttled.length - 1] - throttled[0];
  const throttledRatePerMin = (throttled.length - 1) / (throttledElapsedMs / 60000);

  console.log(`Genuine throttling began at dispatch #${throttleStartIdx}.`);
  console.log(`Rate measured from that point on (${throttled.length} dispatches): ${throttledRatePerMin.toFixed(1)}/min (target ${RATE_LIMIT_TARGET_PER_MIN}, hard cap ${RATE_LIMIT_PER_MIN})`);

  assert.ok(throttledRatePerMin <= RATE_LIMIT_PER_MIN, `throttled-phase rate ${throttledRatePerMin.toFixed(1)}/min exceeded the hard cap`);
  assert.ok(throttledRatePerMin >= RATE_LIMIT_TARGET_PER_MIN * 0.85 && throttledRatePerMin <= RATE_LIMIT_TARGET_PER_MIN * 1.15, `throttled-phase rate ${throttledRatePerMin.toFixed(1)}/min not within ~15% of target — concurrency may be letting dispatch outrun the bucket`);

  // Wall-clock sanity: with concurrency, this should be dramatically faster
  // than the single-worker equivalent (61s observed live for 36 requests at
  // ~1.7s latency) despite this run using MORE requests than that live scan.
  console.log(`Wall-clock for ${TOTAL} requests with concurrency: ${(totalMs / 1000).toFixed(1)}s`);
}

(async () => {
  await run('concurrency: max in-flight reaches MAX_CONCURRENT on a shallow-start burst (not the starvation bug)', testMaxInFlightRespectedOnAShallowBurst);
  await run('concurrency: cap is never exceeded', testConcurrencyNeverExceedsCap);
  await run('concurrency: max-in-flight AND bucket pacing both hold simultaneously under genuine exhaustion', testConcurrencyAndBucketBothHoldUnderGenuineExhaustion);
})();
