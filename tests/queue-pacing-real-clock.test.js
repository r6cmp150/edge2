// tests/queue-pacing-real-clock.test.js — 2026-11-03. SLOW, ABOUT 25 SECONDS, ON
// PURPOSE: real timers and the real Date, and no virtual clock.
//
// tests/queue-pacing.test.js runs on a clock it owns, so it proves the bucket's
// arithmetic and can't see anything real timers do. This file is the check on
// the rest. It also exists because a failure is UNEXPLAINED: that test, then on
// real timers, failed once (2026-11-03 23:26Z, a full strict run, serial, nothing
// else of ours running) and passed on every rerun. The runner kept only the test's
// name, so the numbers are gone. "Load" was a guess; moving to a virtual clock
// removed the symptom without showing there was no defect. If this file ever
// fails, its message has the numbers.
//
// What can be asserted on a real clock:
//   - NEVER FASTER THAN THE BUCKET. From the first dispatch that leaves under one
//     token, dispatches can't exceed what refill paid for in the elapsed time. A
//     busy machine only delays timers, and refill counts real elapsed time, so
//     this has no load excuse: it is a hard failure, always.
//   - NOT MUCH SLOWER THAN TARGET, UNLESS THE TIMERS WERE MEASURABLY LATE. A
//     separate 10ms probe measures how late timers ran. A low rate with on-time
//     timers is the bucket's fault and fails. A low rate with late timers can't be
//     judged, and says NOT JUDGED with its numbers rather than passing silently.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const apiClientSrc = readSource('core/api-client.js');
const LATE_TIMER_MS = 50; // the workers poll every 50ms, so later than this costs them a poll

function loadQueue() {
  // eslint-disable-next-line no-eval
  eval(apiClientSrc + `
    global.__rc = { enqueue, readTokens: () => _tokens, TARGET: RATE_LIMIT_TARGET_PER_MIN, CAP: RATE_LIMIT_PER_MIN, WINDOW_MS };
  `);
  return global.__rc;
}

run('real clock: the bucket paces real dispatches (slow by design, see the header)', async () => {
  const { enqueue, readTokens, TARGET, CAP, WINDOW_MS } = loadQueue();
  const TOTAL = 260, LATENCY_MS = 5;
  const times = [], tokensAfter = [];
  const lateness = [];
  let expected = Date.now() + 10;
  const probe = setInterval(() => { const now = Date.now(); lateness.push(now - expected); expected = now + 10; }, 10);
  const promises = [];
  for (let i = 0; i < TOTAL; i++) {
    promises.push(enqueue(async () => {
      times.push(Date.now());
      tokensAfter.push(readTokens());
      await new Promise(r => setTimeout(r, LATENCY_MS));
      return 'ok';
    }, { engine: 'EDGE', priority: 'foreground' }));
  }
  await Promise.all(promises);
  clearInterval(probe);

  const start = tokensAfter.findIndex(t => t < 1);
  assert.ok(start !== -1 && start < TOTAL - 20, `never exhausted the buffer: first under one token at dispatch ${start}, end tokens ${readTokens().toFixed(2)}`);
  const window = times.slice(start);
  const elapsedMs = window[window.length - 1] - window[0];
  const dispatched = window.length - 1;
  const paidFor = elapsedMs * (TARGET / WINDOW_MS) + 1; // +1: the token in hand when the window opens
  const rate = dispatched / (elapsedMs / 60000);
  const sorted = lateness.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0, worst = sorted[sorted.length - 1] ?? 0;
  const gaps = window.slice(1).map((t, i) => t - window[i]);
  const numbers = `rate ${rate.toFixed(1)}/min (target ${TARGET}, cap ${CAP}) | ${dispatched} dispatches in ${elapsedMs}ms from #${start}, refill paid for ${paidFor.toFixed(1)} | widest gap ${Math.max(...gaps)}ms | timer lateness p95 ${p95}ms, worst ${worst}ms | end tokens ${readTokens().toFixed(2)}`;
  console.log(numbers);

  assert.ok(dispatched <= paidFor, `dispatched faster than refill allows: ${numbers}`);
  assert.ok(rate <= CAP, `over the hard cap: ${numbers}`);
  if (rate < TARGET * 0.85) {
    assert.ok(p95 > LATE_TIMER_MS, `too slow with on-time timers, so the bucket is at fault: ${numbers}`);
    console.log(`NOT JUDGED: too slow, and timers ran late (p95 ${p95}ms > ${LATE_TIMER_MS}ms), so the lower bound can't be judged on this run. The upper bound held.`);
  }
});
