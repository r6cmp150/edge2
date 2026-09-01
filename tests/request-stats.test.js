// tests/request-stats.test.js — core/api-client.js's shared request-stats
// tally (getRequestStats/diffRequestStats), added 2026-08-30.
//
// Why this exists: every diagnostic request count in this app used to
// increment AFTER its own fetch resolved, inside a try whose catch
// swallowed the error — so a failed attempt (still a real HTTP call,
// still consumed quota) contributed 0. Found via the Playwright
// replay-scan harness recording real calls independently and catching a
// 6-observed/0-reported mismatch under a rejected API key. This tally
// fixes the timing at the one place every Alpaca request actually passes
// through (_drainWorker, right next to the existing correct-timing token
// debit) instead of the nine places that each threaded their own
// after-the-fact counter.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const apiClientSrc = readSource('core/api-client.js');

function loadFreshQueue() {
  const exposeCode = `
    global.__enqueue = enqueue;
    global.__getRequestStats = getRequestStats;
    global.__diffRequestStats = diffRequestStats;
  `;
  // eslint-disable-next-line no-eval
  eval(apiClientSrc + '\n' + exposeCode);
  return {
    enqueue: global.__enqueue,
    getRequestStats: global.__getRequestStats,
    diffRequestStats: global.__diffRequestStats,
  };
}

async function testIssuedIncrementsEvenWhenTheRequestFails() {
  const { enqueue, getRequestStats, diffRequestStats } = loadFreshQueue();
  const before = getRequestStats('EDGE');
  await enqueue(async () => { throw new Error('simulated failure'); }, { engine: 'EDGE' }).catch(() => {});
  const diff = diffRequestStats(before, getRequestStats('EDGE'));
  console.log('failed-request diff:', diff);
  assert.strictEqual(diff.issued, 1, 'a failed request is still a real request — issued must increment regardless of outcome');
  assert.strictEqual(diff.succeeded, 0);
  assert.strictEqual(diff.failed, 1);
}

async function testIssuedEqualsSucceededPlusFailedAcrossAMixedBatch() {
  const { enqueue, getRequestStats, diffRequestStats } = loadFreshQueue();
  const before = getRequestStats('EDGE');
  const outcomes = [true, false, true, true, false]; // 3 succeed, 2 fail
  await Promise.all(outcomes.map(ok =>
    enqueue(async () => { if (!ok) throw new Error('fail'); return 'ok'; }, { engine: 'EDGE' }).catch(() => {})
  ));
  const diff = diffRequestStats(before, getRequestStats('EDGE'));
  console.log('mixed-batch diff:', diff);
  assert.strictEqual(diff.issued, 5);
  assert.strictEqual(diff.succeeded, 3);
  assert.strictEqual(diff.failed, 2);
  assert.strictEqual(diff.issued, diff.succeeded + diff.failed, 'issued must always equal succeeded + failed — every attempt resolves one way or the other');
}

async function testPerEngineBreakdownTracksTheGivenEngineTag() {
  const { enqueue, getRequestStats, diffRequestStats } = loadFreshQueue();
  const beforeEdge = getRequestStats('EDGE');
  const beforeWarrior = getRequestStats('WARRIOR');
  await enqueue(async () => 'ok', { engine: 'EDGE' });
  await enqueue(async () => 'ok', { engine: 'WARRIOR' });
  await enqueue(async () => 'ok', { engine: 'WARRIOR' });
  const edgeDiff = diffRequestStats(beforeEdge, getRequestStats('EDGE'));
  const warriorDiff = diffRequestStats(beforeWarrior, getRequestStats('WARRIOR'));
  console.log('per-engine diffs:', { edge: edgeDiff, warrior: warriorDiff });
  assert.strictEqual(edgeDiff.issued, 1, 'EDGE-tagged calls must not be counted against WARRIOR');
  assert.strictEqual(warriorDiff.issued, 2, 'WARRIOR-tagged calls must not be counted against EDGE');
  // Mechanically correct at this layer (enqueue's own engine tag) — does
  // NOT prove alpacaGet actually tags Warrior's real calls 'WARRIOR' today;
  // it still hardcodes 'EDGE' unconditionally (see alpacaGet's own
  // comment). That's a separate, pre-existing gap this fix documents but
  // does not close.
}

async function testGetRequestStatsReturnsAnImmutableSnapshot() {
  const { enqueue, getRequestStats } = loadFreshQueue();
  const snapshot = getRequestStats('EDGE');
  await enqueue(async () => 'ok', { engine: 'EDGE' });
  console.log('snapshot after a later request:', snapshot, '| live:', getRequestStats('EDGE'));
  assert.strictEqual(snapshot.issued, 0, 'a snapshot taken before a request must not be mutated by that later request');
}

async function testGlobalTallySumsAcrossEngines() {
  const { enqueue, getRequestStats, diffRequestStats } = loadFreshQueue();
  const before = getRequestStats(); // no engine arg -> global
  await enqueue(async () => 'ok', { engine: 'EDGE' });
  await enqueue(async () => 'ok', { engine: 'WARRIOR' });
  const diff = diffRequestStats(before, getRequestStats());
  console.log('global diff across two engines:', diff);
  assert.strictEqual(diff.issued, 2, 'the unscoped global tally must count every engine\'s requests, not just one');
}

// ── _countRequests is retired — grep-based, same style as this project's
// other "no path references X" checks (e.g. setups.test.js's
// calcEntryTargetStop check). A monkey-patch of the shared alpacaGet
// binding with no concurrency protection: two overlapping scoped counts
// completing out of nesting order could permanently corrupt the binding
// itself (see the commit that removed it for the full trace). Retired,
// not just unused, so nothing can call back into it by habit.
async function testCountRequestsIsFullyRetired() {
  const fs = require('fs');
  const path = require('path');
  const filesToCheck = [
    'core/universe.js',
    'core/api-client.js',
    'engines/warrior/index.js',
    'engines/warrior/gate.js',
    'engines/warrior/replay.js',
  ];
  for (const rel of filesToCheck) {
    const full = path.join(__dirname, '..', rel);
    if (!fs.existsSync(full)) continue; // setups.js/its own index.js additions aren't on every branch
    const src = fs.readFileSync(full, 'utf8');
    const codeOnly = src.split('\n').map(line => line.replace(/\/\/.*/, '')).join('\n');
    assert.ok(!/\b_countRequests\s*\(/.test(codeOnly), `${rel} must never call the retired _countRequests`);
  }
}

(async () => {
  await run('request-stats: issued increments even when the request fails', testIssuedIncrementsEvenWhenTheRequestFails);
  await run('request-stats: issued === succeeded + failed across a mixed batch', testIssuedEqualsSucceededPlusFailedAcrossAMixedBatch);
  await run('request-stats: per-engine breakdown tracks the given engine tag', testPerEngineBreakdownTracksTheGivenEngineTag);
  await run('request-stats: getRequestStats returns an immutable snapshot', testGetRequestStatsReturnsAnImmutableSnapshot);
  await run('request-stats: unscoped global tally sums across engines', testGlobalTallySumsAcrossEngines);
  await run('request-stats: _countRequests is fully retired, no path calls it', testCountRequestsIsFullyRetired);
})();
