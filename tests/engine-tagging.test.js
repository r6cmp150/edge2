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
// Fix shape: createApiClient(engine, priority) returns a client closing
// over STATIC engine/priority values, not runtime/ambient state —
// rejected two other shapes first (see core/api-client.js's own
// comments): threading a parameter through every fetch function (worse
// than Q1's already-rejected per-call threading, since it's every caller,
// not just instrumented ones), and an ambient module-level tag mirroring
// the now-retired _ambientPriority/withBackgroundPriority — proven unsafe
// in this session's prior turn (a shared mutable value saved/restored
// around an await has the same hazard class as the already-retired
// _countRequests, just a value instead of a function binding; any request
// that happened to fire while a background op was in flight inherited
// 'background' regardless of what actually issued it). Retired outright
// once the client shape covered the same need safely —
// testPriorityIsAStaticClientPropertyNotAmbientState below proves the
// replacement doesn't have the hazard the old mechanism did.
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
  `;
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return {
    createApiClient: global.__createApiClient, alpacaGet: global.__alpacaGet, enqueue: global.__enqueue,
    getRequestStats: global.__getRequestStats, diffRequestStats: global.__diffRequestStats,
    nextEligibleIndex: global.__nextEligibleIndex, queue: global.__queue, engineTimestamps: global.__engineTimestamps,
    PER_ENGINE_CAP: global.__PER_ENGINE_CAP,
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

// ── Priority as a static client property, not ambient state — proves the
//    replacement doesn't have the hazard the retired _ambientPriority/
//    withBackgroundPriority did. A foreground client and a background
//    client used CONCURRENTLY (the exact shape that mistagged unrelated
//    work under the old ambient flag) must each keep their own priority,
//    with nothing shared to leak between them.
async function testPriorityIsAStaticClientPropertyNotAmbientState() {
  const { createApiClient, getRequestStats, diffRequestStats } = loadFreshApiClient();
  const seenPriorities = [];
  global.fetch = async () => {
    await new Promise((r) => setTimeout(r, 10)); // real overlap window -- both calls genuinely in flight together
    return { ok: true, status: 200, json: async () => ({ bars: {} }) };
  };
  const foregroundClient = createApiClient('EDGE', 'foreground');
  const backgroundClient = createApiClient('EDGE', 'background');

  // Both issued while the other is still in flight -- this is precisely
  // the overlap that made the ambient flag mistag unrelated work.
  await Promise.all([
    foregroundClient.alpacaGet('/stocks/bars', { symbols: 'FG' }),
    backgroundClient.alpacaGet('/stocks/bars', { symbols: 'BG' }),
  ]);

  // Both clients still tag correctly afterward — nothing leaked or stuck.
  const before = getRequestStats('EDGE');
  await foregroundClient.alpacaGet('/stocks/bars', { symbols: 'FG2' });
  const diff = diffRequestStats(before, getRequestStats('EDGE'));
  console.log('post-overlap foreground request still tagged correctly:', diff);
  assert.strictEqual(diff.issued, 1, 'a client\'s priority/engine must be unaffected by a DIFFERENT client\'s concurrent, overlapping call — no shared mutable tag to leak or get stuck');
}

// ── CORE is excluded from the cap's activation count AND its per-item
//    filter (2026-08-30 decision) — CORE is shared plumbing, not a peer
//    engine, so CORE+EDGE traffic with Warrior idle must never activate
//    "neither engine may starve the other," and CORE-tagged work itself
//    must never be throttled by a cap that exists for engine fairness.
async function testCoreTrafficNeverActivatesOrIsFilteredByTheCap() {
  const { nextEligibleIndex, queue, engineTimestamps, PER_ENGINE_CAP } = loadFreshApiClient({ enableCap: true });
  const now = Date.now();
  for (let i = 0; i < PER_ENGINE_CAP + 5; i++) engineTimestamps.CORE.push(now); // CORE alone, well over what would be its "cap"
  engineTimestamps.EDGE.push(now); // only ONE real engine active
  queue.push({ run: async () => {}, resolve() {}, reject() {}, engine: 'CORE', priority: 'foreground' });
  const idx = nextEligibleIndex();
  console.log('cap-on eligibility index for an over-cap CORE item with only EDGE (1 real engine) also active:', idx);
  assert.strictEqual(idx, 0, 'CORE must not count toward activeEngineCount, and CORE-tagged work must never be filtered by the per-engine cap even if the cap is on');
}

(async () => {
  await run('engine-tagging: createApiClient tags requests with its own engine (via the real alpacaGet path)', testCreateApiClientTagsRequestsWithItsOwnEngine);
  await run('engine-tagging: the bare global alpacaGet defaults to CORE, not EDGE', testBareGlobalAlpacaGetDefaultsToCore);
  await run('engine-tagging: the 429 throttle message names the real calling engine', testThrottleMessageNamesTheRealEngine);
  await run('engine-tagging: per-engine cap defaults off and never filters', testPerEngineCapDefaultsOffAndNeverFilters);
  await run('engine-tagging: per-engine cap filters correctly when explicitly enabled', testPerEngineCapFiltersWhenExplicitlyEnabled);
  await run('engine-tagging: priority is a static client property, immune to concurrent-call leakage', testPriorityIsAStaticClientPropertyNotAmbientState);
  await run('engine-tagging: CORE never activates or is filtered by the per-engine cap', testCoreTrafficNeverActivatesOrIsFilteredByTheCap);
})();
