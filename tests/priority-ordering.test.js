// tests/priority-ordering.test.js — core/api-client.js's _nextEligibleIndex
// priority ordering ("a background burst doesn't delay a foreground
// request"). Tests the actual claim by measuring dispatch ORDER, not just
// eventual success — a weak version of this test could assert both
// eventually resolve without error, which is true regardless of priority
// ordering (the same failure shape as the queue-pacing false alarms: a test
// that proves a proxy instead of the claim).
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const apiClientSrc = readSource('core/api-client.js');

function loadFreshQueue() {
  const exposeCode = 'global.__enqueue = enqueue; global.__MAX_CONCURRENT = MAX_CONCURRENT;';
  // eslint-disable-next-line no-eval
  eval(apiClientSrc + '\n' + exposeCode);
  return { enqueue: global.__enqueue, MAX_CONCURRENT: global.__MAX_CONCURRENT };
}

async function testForegroundPreemptsQueuedBackgroundBurst() {
  const { enqueue, MAX_CONCURRENT } = loadFreshQueue();
  const MOCK_LATENCY_MS = 300; // slow enough that the background burst is still mostly queued when the foreground request arrives
  const dispatchOrder = [];

  function mockRequest(label) {
    return async () => {
      dispatchOrder.push(label);
      await new Promise(r => setTimeout(r, MOCK_LATENCY_MS));
      return label;
    };
  }

  const BACKGROUND_COUNT = 50;
  const bgPromises = [];
  for (let i = 0; i < BACKGROUND_COUNT; i++) {
    bgPromises.push(enqueue(mockRequest(`bg${i}`), { engine: 'EDGE', priority: 'background' }));
  }

  // Enqueue the foreground request shortly after the burst starts — well
  // before the 50 background items could possibly have all dispatched
  // (only 1 worker, ~300ms each, so bg0 is likely still in flight).
  await new Promise(r => setTimeout(r, 50));
  const fgPromise = enqueue(mockRequest('FOREGROUND'), { engine: 'EDGE', priority: 'foreground' });

  await Promise.all([...bgPromises, fgPromise]);

  const fgDispatchIndex = dispatchOrder.indexOf('FOREGROUND');
  const bgDispatchedBeforeFg = dispatchOrder.slice(0, fgDispatchIndex).filter(l => l.startsWith('bg')).length;

  console.log('Full dispatch order:', dispatchOrder.join(', '));
  console.log(`Foreground dispatched at position ${fgDispatchIndex + 1} of ${BACKGROUND_COUNT + 1} total.`);
  console.log(`Background items dispatched BEFORE foreground: ${bgDispatchedBeforeFg} (of ${BACKGROUND_COUNT} total).`);

  // Whatever background items are ALREADY in flight (up to MAX_CONCURRENT
  // of them, with the elastic-worker concurrency fix) when foreground is
  // enqueued can't be preempted mid-request — up to MAX_CONCURRENT
  // background dispatches ahead of foreground is expected and correct.
  // More than that would mean priority ordering isn't actually working.
  assert.ok(bgDispatchedBeforeFg <= MAX_CONCURRENT, `expected at most ${MAX_CONCURRENT} background items ahead of foreground (the ones already in flight), got ${bgDispatchedBeforeFg} — priority ordering is not preempting the queued burst`);
}

(async () => {
  await run('priority-ordering: foreground preempts a queued background burst', testForegroundPreemptsQueuedBackgroundBurst);
})();
