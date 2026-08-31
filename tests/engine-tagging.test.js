// tests/engine-tagging.test.js — core/api-client.js's engine-tagging fix,
// added 2026-08-30.
//
// Family audit finding: alpacaGet hardcoded engine = 'EDGE' unconditionally
// for every caller, from either engine, since Phase 0.5. Every consumer of
// that tag — the per-engine budget (PER_ENGINE_CAP/_activeEngineCount/
// capApplies), the rolling _engineTimestamps log, the 429 backoff warning,
// this session's own byEngine request tally — was reading a lie. Because
// only 'EDGE' was ever populated, _activeEngineCount() could never reach
// 2, so capApplies could never become true: the per-engine cap has never
// once fired in this app's life, not rarely, never.
//
// Fix shape: createApiClient(engine) returns a client closing over a
// static engine value, not runtime/ambient state — rejected two other
// shapes first (see core/api-client.js's own comments): threading an
// engine parameter through every fetch function (worse than Q1's already-
// rejected per-call threading, since it's every caller, not just
// instrumented ones), and an ambient module-level tag mirroring
// _ambientPriority/withBackgroundPriority — proven unsafe by this same
// investigation (see testWithBackgroundPriorityMistagsConcurrentWork
// below): a shared mutable value saved/restored around an await has the
// same hazard class as the already-retired _countRequests, just a value
// instead of a function binding.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const apiClientSrc = readSource('core/api-client.js');

function loadFreshApiClient({ enableCap = false } = {}) {
  const src = enableCap
    ? apiClientSrc.replace('const ENABLE_PER_ENGINE_CAP = false;', 'const ENABLE_PER_ENGINE_CAP = true;')
    : apiClientSrc;
  if (enableCap) assert.ok(src !== apiClientSrc, 'the flag-flip replace must actually match — otherwise this test would silently test the default (off) twice');
  global.state = { settings: { alpacaKey: 'test-key', alpacaSecret: 'test-secret' } };
  const exposeCode = `
    global.__createApiClient = createApiClient;
    global.__alpacaGet = alpacaGet;
    global.__enqueue = enqueue;
    global.__getRequestStats = getRequestStats;
    global.__diffRequestStats = diffRequestStats;
    global.__nextEligibleIndex = _nextEligibleIndex;
    global.__queue = _queue;
    global.__engineTimestamps = _engineTimestamps;
    global.__PER_ENGINE_CAP = PER_ENGINE_CAP;
    global.__withBackgroundPriority = withBackgroundPriority;
    global.__readAmbientPriority = () => _ambientPriority;
  `;
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return {
    createApiClient: global.__createApiClient, alpacaGet: global.__alpacaGet, enqueue: global.__enqueue,
    getRequestStats: global.__getRequestStats, diffRequestStats: global.__diffRequestStats,
    nextEligibleIndex: global.__nextEligibleIndex, queue: global.__queue, engineTimestamps: global.__engineTimestamps,
    PER_ENGINE_CAP: global.__PER_ENGINE_CAP,
    withBackgroundPriority: global.__withBackgroundPriority, readAmbientPriority: global.__readAmbientPriority,
  };
}

// ── createApiClient tags requests with its OWN engine, through the real
//    alpacaGet/_alpacaGetImpl path — not the raw enqueue() bypass the
//    other request-stats tests use, so this proves the fix works for an
//    actual caller, not just the accounting primitive underneath it.
async function testCreateApiClientTagsRequestsWithItsOwnEngine() {
  const { createApiClient, getRequestStats, diffRequestStats } = loadFreshApiClient();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ bars: {} }) });

  const warrior = createApiClient('WARRIOR');
  const edge = createApiClient('EDGE');
  const beforeWarrior = getRequestStats('WARRIOR');
  const beforeEdge = getRequestStats('EDGE');

  await warrior.alpacaGet('/stocks/bars', { symbols: 'TEST' });
  await edge.alpacaGet('/stocks/bars', { symbols: 'TEST' });
  await edge.alpacaGet('/stocks/bars', { symbols: 'TEST2' });

  const warriorDiff = diffRequestStats(beforeWarrior, getRequestStats('WARRIOR'));
  const edgeDiff = diffRequestStats(beforeEdge, getRequestStats('EDGE'));
  console.log('createApiClient tagging:', { warrior: warriorDiff, edge: edgeDiff });
  assert.strictEqual(warriorDiff.issued, 1, 'the WARRIOR client\'s own request must be tagged WARRIOR, not EDGE');
  assert.strictEqual(edgeDiff.issued, 2, 'the EDGE client\'s own requests must be tagged EDGE, independently of the WARRIOR client');
}

// ── The bare global alpacaGet defaults to 'CORE', not 'EDGE' — honest
//    for unattributed code instead of assuming EDGE.
async function testBareGlobalAlpacaGetDefaultsToCore() {
  const { alpacaGet, getRequestStats, diffRequestStats } = loadFreshApiClient();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const before = getRequestStats('CORE');
  await alpacaGet('/stocks/bars', { symbols: 'TEST' });
  const diff = diffRequestStats(before, getRequestStats('CORE'));
  console.log('bare alpacaGet diff (CORE):', diff);
  assert.strictEqual(diff.issued, 1, 'the bare global must default to CORE, not silently assume EDGE');
}

// ── The 429 throttle message names the real caller, not a hardcoded lie.
async function testThrottleMessageNamesTheRealEngine() {
  const { createApiClient } = loadFreshApiClient();
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, text: async () => 'slow down' };
    return { ok: true, status: 200, json: async () => ({ bars: {} }) };
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await createApiClient('WARRIOR').alpacaGet('/stocks/bars', { symbols: 'TEST' });
  } finally {
    console.warn = realWarn;
  }
  console.log('throttle warning:', warnings[0]);
  assert.ok(warnings.length >= 1, 'a 429 must produce a backoff warning');
  assert.match(warnings[0], /engine WARRIOR throttled/, 'the warning must name the real calling engine, not a hardcoded EDGE');
}

// ── The per-engine cap: off by default, and correctly gates eligibility
//    when explicitly enabled. Tests _nextEligibleIndex directly (queue/
//    timestamp state set up by hand) rather than a real async drain —
//    deterministic, no timing flakiness, and isolates exactly the
//    capApplies/ENABLE_PER_ENGINE_CAP gating logic this fix added.
async function testPerEngineCapDefaultsOffAndNeverFilters() {
  const { nextEligibleIndex, queue, engineTimestamps, PER_ENGINE_CAP } = loadFreshApiClient({ enableCap: false });
  const now = Date.now();
  for (let i = 0; i < PER_ENGINE_CAP + 5; i++) engineTimestamps.WARRIOR.push(now);
  engineTimestamps.EDGE.push(now); // 2 engines active in the window -- capApplies WOULD be true if the flag were on
  queue.push({ run: async () => {}, resolve() {}, reject() {}, engine: 'WARRIOR', priority: 'foreground' });
  const idx = nextEligibleIndex();
  console.log('cap-off eligibility index for an over-cap WARRIOR item:', idx);
  assert.strictEqual(idx, 0, 'with ENABLE_PER_ENGINE_CAP false (the shipped default), an over-cap engine must still be eligible -- this cap has never filtered anything in production and must not start silently');
}

async function testPerEngineCapFiltersWhenExplicitlyEnabled() {
  const { nextEligibleIndex, queue, engineTimestamps, PER_ENGINE_CAP } = loadFreshApiClient({ enableCap: true });
  const now = Date.now();
  for (let i = 0; i < PER_ENGINE_CAP + 5; i++) engineTimestamps.WARRIOR.push(now);
  engineTimestamps.EDGE.push(now); // 2 engines active -> capApplies becomes true
  queue.push({ run: async () => {}, resolve() {}, reject() {}, engine: 'WARRIOR', priority: 'foreground' });
  const idx = nextEligibleIndex();
  console.log('cap-on eligibility index for an over-cap WARRIOR item (2 engines active):', idx);
  assert.strictEqual(idx, -1, 'with the flag explicitly enabled and 2+ engines active, an over-cap engine\'s item must be filtered out -- proves the gate is reachable and correct once turned on, not just inert');
}

// ── _ambientPriority safety — same hazard class as the retired
//    _countRequests, confirmed directly rather than assumed. A shared
//    mutable value saved/restored around an await: work that happens to
//    run WHILE it's set to 'background' inherits that tag even if it has
//    nothing to do with the background operation.
async function testWithBackgroundPriorityMistagsConcurrentWork() {
  const { withBackgroundPriority, readAmbientPriority } = loadFreshApiClient();
  assert.strictEqual(readAmbientPriority(), 'foreground', 'must start foreground');

  let observedDuringOverlap = null;
  const backgroundOp = withBackgroundPriority(async () => {
    await new Promise((r) => setTimeout(r, 20)); // in flight -- ambient is 'background' for this whole window
  });
  await new Promise((r) => setTimeout(r, 5)); // let the background op's ambient-set actually take effect
  observedDuringOverlap = readAmbientPriority(); // an UNRELATED foreground caller reading the ambient flag right now
  await backgroundOp;

  console.log('ambient priority observed by unrelated code during an in-flight background op:', observedDuringOverlap);
  assert.strictEqual(observedDuringOverlap, 'background', 'an ordinary foreground caller that happens to check priority while ANY background-wrapped operation is in flight sees background -- mistagging, not a hypothetical: any alpacaGet call issued during this window is deprioritized regardless of what actually issued it');
  assert.strictEqual(readAmbientPriority(), 'foreground', 'must be restored once the background op completes (this part is fine when only one wrapped call is ever in flight at a time, which is checkPriceAlerts\' actual usage today -- see the file header for the narrower, still-real hazard when two overlap out of nesting order)');
}

(async () => {
  await run('engine-tagging: createApiClient tags requests with its own engine (via the real alpacaGet path)', testCreateApiClientTagsRequestsWithItsOwnEngine);
  await run('engine-tagging: the bare global alpacaGet defaults to CORE, not EDGE', testBareGlobalAlpacaGetDefaultsToCore);
  await run('engine-tagging: the 429 throttle message names the real calling engine', testThrottleMessageNamesTheRealEngine);
  await run('engine-tagging: per-engine cap defaults off and never filters', testPerEngineCapDefaultsOffAndNeverFilters);
  await run('engine-tagging: per-engine cap filters correctly when explicitly enabled', testPerEngineCapFiltersWhenExplicitlyEnabled);
  await run('engine-tagging: withBackgroundPriority mistags unrelated concurrent work (confirmed hazard)', testWithBackgroundPriorityMistagsConcurrentWork);
})();
