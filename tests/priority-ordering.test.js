// tests/priority-ordering.test.js — core/api-client.js's _nextEligibleIndex
// priority ordering ("a background burst doesn't delay a foreground
// request"). Tests the actual claim by measuring dispatch ORDER, not just
// eventual success — a weak version of this test could assert both
// eventually resolve without error, which is true regardless of priority
// ordering (the same failure shape as the queue-pacing false alarms: a test
// that proves a proxy instead of the claim).
'use strict';
const assert = require('assert');
const { readSource, run, virtualClock } = require('./_lib');
// Virtual time (2026-11-03): see tests/queue-pacing.test.js. The 50ms wait below
// must land before the 300ms requests finish; on real timers load could break that.
const clock = virtualClock();
const { Date, setTimeout } = clock; // shadow the globals: the eval below sees these

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
  await clock.runUntil(new Promise(r => setTimeout(r, 50)));
  const fgPromise = enqueue(mockRequest('FOREGROUND'), { engine: 'EDGE', priority: 'foreground' });

  await clock.runUntil(Promise.all([...bgPromises, fgPromise]));

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

async function testQueuedWorkKeepsItsOrder() {
  // Priority is the only thing that may reorder the queue. The test above can't
  // see a newest-first queue, because its foreground item is also the newest
  // (a mutant doing exactly that survived it, 2026-11-03). So: a foreground item
  // with background work enqueued AFTER it, and background order checked.
  const { enqueue, MAX_CONCURRENT } = loadFreshQueue();
  const order = [];
  const req = label => async () => { order.push(label); await new Promise(r => setTimeout(r, 300)); return label; };
  const all = [];
  for (let i = 0; i < 20; i++) all.push(enqueue(req(i), { engine: 'EDGE', priority: 'background' }));
  await clock.runUntil(new Promise(r => setTimeout(r, 50)));
  all.push(enqueue(req('FOREGROUND'), { engine: 'EDGE', priority: 'foreground' }));
  for (let i = 20; i < 30; i++) all.push(enqueue(req(i), { engine: 'EDGE', priority: 'background' }));
  await clock.runUntil(Promise.all(all));
  const fg = order.indexOf('FOREGROUND');
  assert.ok(fg >= 0 && fg <= MAX_CONCURRENT, `foreground dispatched at ${fg}, after background work that was still queued`);
  const bg = order.filter(x => x !== 'FOREGROUND');
  assert.deepStrictEqual(bg, bg.slice().sort((x, y) => x - y), 'background work must stay first in, first out');
  assert.strictEqual(bg.length, 30);
}

(async () => {
  await run('priority-ordering: foreground preempts a queued background burst', testForegroundPreemptsQueuedBackgroundBurst);
  await run('priority-ordering: nothing else reorders the queue (first in, first out within a priority)', testQueuedWorkKeepsItsOrder);
})();
