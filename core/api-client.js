// core/api-client.js — owned by neither engine. core/ never imports from engines/.
// Alpaca auth + transport, and the Phase 0.5 shared rate-limit queue
// (docs/warrior-engine-spec-v2.md Phase 0.5). Moved from app.js's
// "── 6. ALPACA API ───" section (Phase 0 extraction); the queue is new
// logic added on top, not moved code.

const ALPACA_BASE = 'https://data.alpaca.markets/v2';

// Pre-approved Phase 0 exception to "move-only" (see spec's "Known debt to
// record, not fix" note + explicit sign-off on this one guard): asserts an
// ordering assumption instead of silently trusting it. Today alpacaHeaders()
// is never called before loadState() populates state.settings, because
// init() runs last — but that's implicit, and Warrior will call through this
// same path on a different schedule, which is exactly when an implicit
// ordering assumption becomes a real bug. Throwing here instead of sending
// an empty key turns a confusing 401 into a diagnosable error at the source.
function alpacaHeaders() {
  if (typeof state.settings.alpacaKey !== 'string' || typeof state.settings.alpacaSecret !== 'string') {
    throw new Error('AlpacaSettingsNotLoadedError: alpacaHeaders() called before state.settings was populated by loadState() — caller is running ahead of app init.');
  }
  return {
    'APCA-API-KEY-ID': state.settings.alpacaKey,
    'APCA-API-SECRET-KEY': state.settings.alpacaSecret,
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// See CLAUDE.md's pagination rule. Every unconditional-pagination loop in
// this codebase already follows next_page_token to exhaustion -- this
// catches the one failure mode that loop can't see on its own: a page that
// comes back essentially full (row count at/near the requested `limit`)
// with next_page_token already null. A well-behaved paginated API should
// never do that -- a full page implies more data waiting, which implies a
// token -- so if it ever happens, either a chunk-size/worst-case assumption
// baked in somewhere upstream is silently wrong, or Alpaca's pagination
// contract changed underneath us. Loud, not fatal — matches the existing
// pagination-proof-violated check this generalizes (core/universe.js's
// _fetchHistoricalDailyBars had a bespoke version of exactly this before
// 2026-09-02; found the underlying loop wasn't even following the token at
// all when a caller-supplied date range widened past what the original
// chunk-size proof covered — this assertion is the backstop for every
// OTHER loop in the codebase having the same class of latent gap, not
// discovered yet only because no one has hit it live).
function assertPageNotSuspiciouslyFull(label, rowCount, limit, nextPageToken) {
  if (!nextPageToken && typeof limit === 'number' && limit > 0 && rowCount >= limit * 0.95) {
    console.error(`assertPageNotSuspiciouslyFull: ${label} returned ${rowCount} rows (limit=${limit}) with no next_page_token — a page this close to the requested ceiling with no continuation token is exactly the shape of a silent-truncation bug. Re-verify before trusting this result.`);
  }
}

// Alpaca rejects an entire batch request with a 400 if ANY symbol in it is
// malformed (confirmed in production via AAC-U) — a hyphen, space, or other
// non-alphanumeric character kills the whole batch, not just that ticker.
// Applied at every batch-request entry point below so a single bad ticker
// in any universe can't take down an entire scan.
function sanitizeTickerBatch(tickers) {
  return tickers.filter(t => /^[A-Z0-9]+$/.test(t));
}

// ── Phase 0.5: shared rate-limit queue ──────────────────────────────────
// Single, shared arbiter for every Alpaca request from either engine.
// Replaces today's uncoordinated concurrent awaits: each caller's own loop
// already serializes ITS OWN requests (e.g. fetchMultiBars awaits each
// chunk in turn), but nothing today coordinates ACROSS callers — a scan's
// bars fetch and checkPriceAlerts' background poll compete for the same
// 200/min quota with zero visibility into each other.
//
// Two ceilings, enforced independently:
//
// 1. Global token bucket — capacity RATE_LIMIT_PER_MIN (200, Alpaca Basic's
//    actual hard limit), refilling at RATE_LIMIT_TARGET_PER_MIN (170)
//    tokens/min. Starts full (a cold app can burst once), sustains at
//    170/min under continuous load — headroom under Alpaca's real cap so
//    our own throttling, not Alpaca's 429, is what limits us in practice.
//    Always enforced, regardless of how many engines are active.
//
// 2. Per-engine budget — PER_ENGINE_CAP (60% of 200 = 120/min), tracked as
//    a rolling 60s send-timestamp log per REAL engine (EDGE, WARRIOR —
//    see REAL_ENGINES below; CORE is shared plumbing, not a peer engine,
//    and is excluded from both the activation check and the cap itself).
//    Enforced ONLY while two or more real engines have actually sent a
//    request within the current window (see spec: a strict cap would
//    throttle EDGE on Phase 1's wide scans for a competitor — Warrior —
//    that isn't running yet). The global bucket above still protects
//    Alpaca either way; this second ceiling exists purely so neither
//    engine can starve the other once both are genuinely active.
//    Currently shipped OFF (ENABLE_PER_ENGINE_CAP = false, 2026-08-30) —
//    see that constant's own comment for why.
//
// Within those ceilings the queue is priority-ordered, not FIFO: the
// oldest eligible 'foreground' entry is always chosen over a 'background'
// one. "Eligible" means both ceilings currently allow it.
//
// engine/priority are NOT parameters of the bare alpacaGet global (kept
// unchanged for the many callers that don't need a specific tag — it
// defaults to 'CORE'/'foreground'). A caller that wants a real tag gets
// its own client from createApiClient(engine, priority) instead — a
// static pair fixed at construction, not runtime state (2026-08-30,
// replacing both the hardcoded 'EDGE' engine and the ambient priority
// flag this section used to describe here).

const RATE_LIMIT_PER_MIN = 200;          // Alpaca Basic's actual hard limit
const RATE_LIMIT_TARGET_PER_MIN = 170;   // sustained refill target, headroom under the hard cap
const PER_ENGINE_BUDGET_FRACTION = 0.6;  // neither engine may exceed 60% of the hard cap, once 2+ engines are active
const PER_ENGINE_CAP = Math.floor(RATE_LIMIT_PER_MIN * PER_ENGINE_BUDGET_FRACTION); // 120/min
const WINDOW_MS = 60 * 1000;

// Default OFF (2026-08-30) — deliberately, not as an oversight. Fixing the
// engine-tagging defect above (alpacaGet used to hardcode 'EDGE'
// unconditionally) is what finally lets _activeEngineCount() reach 2 and
// capApplies become true — this cap has never once fired in this app's
// life, because the condition for it firing was never reachable before
// this fix. Flipping the tagging fix and the cap's activation on
// simultaneously would mean the first time this cap has EVER run is
// silently, in production, the moment Warrior's own traffic gets tagged
// correctly — surfacing as a scan that pauses for no visible reason,
// which is the exact "waited five minutes, nothing happened" symptom this
// project has already cost real time diagnosing once. Flip this only
// after deliberately measuring a scan with it on (see the harness's
// before/after negative-control run) — not as a side effect of the
// truthfulness fix landing. Whether the cap is worth keeping at all, once
// it's measurable, is a separate, open question — the account has run on
// global-bucket pacing alone for its entire life without missing this.
const ENABLE_PER_ENGINE_CAP = false;

const MAX_429_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

let _tokens = RATE_LIMIT_PER_MIN;
let _lastRefill = Date.now();
const _refillPerMs = RATE_LIMIT_TARGET_PER_MIN / WINDOW_MS;

const _engineTimestamps = { EDGE: [], WARRIOR: [], CORE: [] }; // rolling log of send times, last WINDOW_MS, per engine

const _queue = []; // { run, resolve, reject, engine, priority }
let _activeWorkers = 0;
let _backoffUntil = 0;

// ── Request accounting: one place to be right ────────────────────────────
// Every diagnostic count this app has ever shown (Phase 3's PHASE-3-
// UNVERIFIED log, Phase 4/5's replay-panel summary line, core/universe.js's
// diagnosePremarketGap) was computed by threading a `requests` return value
// up through each layer, incrementing it AFTER its own fetch call resolved
// — so a failed attempt, which still consumes real quota and still hits
// the wire, contributed 0 everywhere. Found 2026-08-30 via the Playwright
// replay-scan harness (a separate, non-Warrior-specific tool) recording
// real HTTP calls as an independent witness and catching a 6-observed/
// 0-reported mismatch under a rejected API key. Nine call sites had this
// exact bug independently; fixing each one leaves nine places a tenth can
// reintroduce it.
//
// This tally lives at the one place every Alpaca request from either
// engine actually passes through — _drainWorker, right next to the line
// that already gets timing correct for the token bucket (_tokens -= 1,
// unconditional, before the request is sent). issued increments there,
// unconditionally; succeeded/failed increment once the attempt resolves
// one way or the other. issued === succeeded + failed always holds.
// retried is a separate, narrower count — see alpacaGet's retry branch —
// of how many failures were followed by another attempt rather than
// given up on.
//
// Callers that want a SCOPED count (e.g. "how many requests did this one
// range-scan make") don't get a tag threaded through every intermediate
// layer down to alpacaGet — that would touch more call sites than it
// fixes, for instrumentation those layers have no other reason to carry.
// Instead: getRequestStats(engine) snapshots the running total, the
// caller runs its operation, snapshots again, and diffRequestStats reports
// the difference. This is what replaced core/universe.js's retired
// _countRequests (a monkey-patch of the shared alpacaGet binding with no
// concurrency protection — see the commit that removed it for the exact
// failure mode: two overlapping scoped counts, completing out of nesting
// order, could permanently corrupt the alpacaGet binding itself).
//
// Known, accepted limitation of the diff approach: it's exact only if
// nothing ELSE hits the queue during the window between the two
// snapshots. A genuinely concurrent second operation would have its own
// requests counted in the diff too — over-attributing, never under. That
// direction matters: a number that reads high after the fact makes a
// human cautious; a number that reads low (the original bug) makes the
// system trust itself when it shouldn't. Report this number as
// requestsObserved, not requests — it is a diff over a shared counter,
// not a per-operation ledger, and the name should say that plainly.
//
// Per-engine breakdown: real today only in the sense that it WILL
// separate engines once alpacaGet actually tags requests by caller. As of
// this fix, alpacaGet still hardcodes engine = 'EDGE' unconditionally
// (see alpacaGet's own comment — a stale Phase 0.5 assumption from before
// Warrior existed and started calling this same function). Every request
// from both engines currently lands in byEngine.EDGE; byEngine.WARRIOR
// will read zero until that tagging gap is closed separately. Recording
// this now, honestly, rather than shipping a per-engine number that looks
// like it solves the Warrior/EDGE contamination case without actually
// doing so.
function _freshStats() { return { issued: 0, succeeded: 0, failed: 0, retried: 0 }; }
const _requestStats = { global: _freshStats(), byEngine: {} };

function _recordRequest(engine, outcome) {
  _requestStats.global[outcome]++;
  if (!_requestStats.byEngine[engine]) _requestStats.byEngine[engine] = _freshStats();
  _requestStats.byEngine[engine][outcome]++;
}

// Snapshot only — a plain object safe to hold onto and diff later, never
// mutated in place by further requests.
function getRequestStats(engine) {
  const src = engine ? (_requestStats.byEngine[engine] || _freshStats()) : _requestStats.global;
  return { ...src };
}

function diffRequestStats(before, after) {
  return {
    issued: after.issued - before.issued,
    succeeded: after.succeeded - before.succeeded,
    failed: after.failed - before.failed,
    retried: after.retried - before.retried,
  };
}

// _ambientPriority/withBackgroundPriority retired (2026-08-30) — same
// hazard class as the already-retired _countRequests, confirmed rather
// than assumed (tests/engine-tagging.test.js's
// testWithBackgroundPriorityMistagsConcurrentWork reproduces it directly):
// a shared mutable value saved/restored around an await means any request
// that happens to fire while a background op is in flight inherits
// 'background' regardless of what actually issued it. Priority is now a
// property of the client that issues the request (see createApiClient
// below), the same shape as the engine fix — one design decision for both,
// not two different mechanisms for two instances of the same underlying
// problem (a property that should travel WITH the request, not be
// inferred from ambient/global state at the moment it happens to run).

function _refillTokens() {
  const now = Date.now();
  const elapsed = now - _lastRefill;
  _tokens = Math.min(RATE_LIMIT_PER_MIN, _tokens + elapsed * _refillPerMs);
  _lastRefill = now;
}

function _pruneEngineWindow(engine) {
  const cutoff = Date.now() - WINDOW_MS;
  const arr = _engineTimestamps[engine];
  while (arr.length && arr[0] < cutoff) arr.shift();
}

// Decided 2026-08-30, before the cap is ever switched on: CORE is not an
// engine for this purpose. "Neither engine may starve the other" is a
// claim about EDGE and WARRIOR specifically — CORE is shared plumbing
// serving whichever engine actually called it, not a third peer competing
// for its own share. Counting it would let the cap activate on CORE+EDGE
// traffic with Warrior entirely idle, which is not the situation it was
// designed for. Excluded from both the activation count below AND the
// per-item filter in _nextEligibleIndex — CORE-tagged work is never
// throttled by this cap, whether or not it's active.
const REAL_ENGINES = ['EDGE', 'WARRIOR'];

// Number of real engines with at least one send in the current rolling
// window — the per-engine cap only applies once this is >= 2 (see header
// comment).
function _activeEngineCount() {
  let count = 0;
  for (const engine of REAL_ENGINES) {
    _pruneEngineWindow(engine);
    if (_engineTimestamps[engine].length > 0) count++;
  }
  return count;
}

// Index of the highest-priority eligible queue entry, or -1 if nothing is
// currently eligible (no global tokens, an active backoff, or — when 2+
// engines are active — every queued item's engine is at its own cap).
// "Highest-priority": oldest 'foreground' entry beats any 'background'
// entry; ties (including all-background) keep FIFO order.
function _nextEligibleIndex() {
  _refillTokens();
  if (Date.now() < _backoffUntil) return -1;
  if (_tokens < 1) return -1;

  const capApplies = ENABLE_PER_ENGINE_CAP && _activeEngineCount() >= 2;

  let bestIdx = -1;
  for (let i = 0; i < _queue.length; i++) {
    const item = _queue[i];
    _pruneEngineWindow(item.engine);
    if (capApplies && item.engine !== 'CORE' && _engineTimestamps[item.engine].length >= PER_ENGINE_CAP) continue;
    if (bestIdx === -1) { bestIdx = i; continue; }
    if (item.priority === 'foreground' && _queue[bestIdx].priority === 'background') bestIdx = i;
  }
  return bestIdx;
}

// Found live, 2026-08-24: a single-worker _drain made wall-clock bounded by
// requests * round-trip latency, not by the token bucket — a ~3,854-symbol
// premarket-gap scan needing 36 requests took 61s at ~1.7s/round-trip, even
// though the bucket had budget to clear them in ~13s.
//
// First attempt at fixing this (a fixed one-time Promise.all(MAX_CONCURRENT
// workers) inside _drain) had a real bug, caught by tests/priority-ordering
// -style dispatch-order testing rather than assumed correct: when _drain()
// fires while _queue is still shallow (e.g. mid-burst-enqueue), most of the
// N workers find nothing and exit immediately, leaving only 1 effective
// worker — and the old _draining boolean then blocked any later _drain()
// call from spinning up replacements until that original Promise.all
// resolved, which doesn't happen until the queue is fully drained. Net
// effect: silently back to serial.
//
// Fixed by making worker count elastic instead of a one-time fixed batch:
// _activeWorkers tracks how many are currently alive, and _drain() (now
// synchronous — it doesn't await anything itself, workers run
// independently) tops up to MAX_CONCURRENT on every call, including every
// enqueue(). A worker that finds the queue empty decrements _activeWorkers
// in its own finally and exits; the NEXT enqueue() (or any concurrent
// worker finishing its current request) can then spin up a replacement.
// This self-corrects regardless of how shallow the queue was at any one
// _drain() call — see tests/concurrency.test.js for the max-in-flight and
// pacing-under-genuine-exhaustion proof.
//
// Every worker shares the same _nextEligibleIndex()/_tokens gate below, and
// the pick-token-splice sequence (_nextEligibleIndex through
// _engineTimestamps[...].push) has no `await` in it — JS's
// run-to-completion means that whole sequence is already atomic across
// however many workers call it, so N workers can't double-spend a token or
// pick the same queue entry twice. MAX_CONCURRENT only changes how many
// workers are ready to grab a token the instant it's available; it can
// never cause more tokens to be spent per unit time than _refillTokens()
// allows (proven under genuine exhaustion in tests/queue-pacing.test.js,
// independent of concurrency).
const MAX_CONCURRENT = 6;

async function _drainWorker() {
  try {
    while (_queue.length) {
      const idx = _nextEligibleIndex();
      if (idx === -1) {
        await new Promise(r => setTimeout(r, 50)); // tokens refilling, in backoff, or every queued engine is at its cap — check again shortly
        continue;
      }
      const [item] = _queue.splice(idx, 1);
      _tokens -= 1;
      _engineTimestamps[item.engine].push(Date.now());
      _recordRequest(item.engine, 'issued');
      try {
        const result = await item.run();
        _recordRequest(item.engine, 'succeeded');
        item.resolve(result);
      } catch (e) {
        _recordRequest(item.engine, 'failed');
        item.reject(e);
      }
    }
  } finally {
    _activeWorkers--;
  }
}

// Synchronous by design (doesn't await _drainWorker — workers run
// independently once spun up). Tops up active workers to MAX_CONCURRENT
// whenever there's queue depth to justify them; the `_activeWorkers <
// _queue.length` guard avoids spawning a worker that would just find
// nothing (harmless either way, since it self-corrects via its own
// finally, but this keeps worker count from overshooting actual demand).
// Called on every enqueue() so a worker can always be topped back up after
// one exits, however shallow the queue was at any single call.
function _drain() {
  while (_activeWorkers < MAX_CONCURRENT && _activeWorkers < _queue.length) {
    _activeWorkers++;
    _drainWorker();
  }
}

// enqueue(request, { engine, priority }) — docs/warrior-engine-spec-v2.md
// Phase 0.5. `request` is a zero-arg function returning a promise (the
// actual fetch). Resolves/rejects with request()'s own outcome once the
// queue has cleared it against the token bucket and per-engine budget.
// Default 'CORE', not 'EDGE' (2026-08-30) — an unattributed request is
// honestly unattributed, not silently assumed to be EDGE's. Every real
// caller today (_alpacaGetImpl below) always passes engine explicitly;
// this default only matters for some future direct caller that doesn't.
function enqueue(request, { engine = 'CORE', priority = 'foreground' } = {}) {
  return new Promise((resolve, reject) => {
    _queue.push({ run: request, resolve, reject, engine, priority });
    _drain();
  });
}

// `base` defaults to ALPACA_BASE ('.../v2') — the market-data endpoints all
// live there. News is the one exception: Alpaca serves it from '/v1beta1',
// not '/v2' (see core/news.js), so callers on a different base pass it
// explicitly rather than this function guessing per-path.
//
// Routes through enqueue() — see the Phase 0.5 section above. On a 429,
// retries up to MAX_429_RETRIES times with exponential backoff (pausing
// the whole queue meanwhile, since a 429 usually signals the account-wide
// limit was hit, not just this engine's share of it) before finally
// throwing — existing callers' error handling is unaffected, they already
// handle a thrown Error from a non-2xx.
//
// engine is a real parameter now (2026-08-30), not a hardcoded 'EDGE' —
// see createApiClient below for how a caller gets one bound to itself.
// This was the actual defect the whole per-engine-budget/throttle-
// messaging family audit traced back to: every consumer of item.engine
// (the per-engine cap, the rolling timestamp log, the 429 backoff
// message, this session's own byEngine request tally) was reading a
// literal, unconditional 'EDGE' regardless of which engine's code called
// alpacaGet — so capApplies (_activeEngineCount() >= 2) could never
// become true, the per-engine cap has never once fired since Warrior
// started calling this function, and every 429 warning has claimed
// "engine EDGE throttled" even when Warrior's own traffic triggered it.
async function _alpacaGetImpl(engine, priority, path, params = {}, base = ALPACA_BASE) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));

  let attempt = 0;
  for (;;) {
    try {
      return await enqueue(async () => {
        const r = await fetch(url.toString(), { headers: alpacaHeaders() });
        if (r.status === 429) {
          const err = new Error(`Alpaca 429: ${await r.text()}`);
          err.status = 429;
          throw err;
        }
        if (!r.ok) throw new Error(`Alpaca ${r.status}: ${await r.text()}`);
        return r.json();
      }, { engine, priority });
    } catch (e) {
      if (e.status === 429 && attempt < MAX_429_RETRIES) {
        attempt++;
        _recordRequest(engine, 'retried'); // this failure gets another attempt, not a terminal one — see retried's own definition above
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        _backoffUntil = Date.now() + backoffMs;
        console.warn(`Alpaca 429 — engine ${engine} throttled, backing off ${backoffMs}ms (attempt ${attempt}/${MAX_429_RETRIES})`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      throw e;
    }
  }
}

// Bare global — unchanged call shape from before this fix (callers don't
// know or care that the queue, or now the engine tag, exists), but tagged
// 'CORE' rather than the old hardcoded 'EDGE'. Every classic-script file
// that calls this directly (core/market-data.js's own fetchers, core/
// news.js, core/universe.js's shared helpers) is either genuinely shared
// between engines (universe.js's getUniverse, news.js's
// fetchNewsForTickers — both real dual-engine callers, confirmed by
// grepping actual call sites) or hasn't been given its own tagged client
// yet — either way, 'CORE' is the honest label: "not attributed to a
// specific engine," not "assumed to be EDGE."
async function alpacaGet(path, params = {}, base = ALPACA_BASE) {
  return _alpacaGetImpl('CORE', 'foreground', path, params, base);
}

// createApiClient(engine, priority) — a client whose engine AND priority
// are static properties of who constructed it, not runtime state. This is
// what replaces three rejected approaches: a parameter threaded through
// every intermediate fetch function (Q1's own rejected shape, worse here
// since it's every caller, not just instrumented ones); an ambient
// module-level value set around an await (proven unsafe by this fix —
// _ambientPriority/withBackgroundPriority, retired above, had the
// identical hazard class as the already-retired _countRequests: a shared
// mutable value saved/restored around an await means work that happens to
// run while it's set inherits the wrong tag, and two overlapping wrapped
// calls completing out of nesting order can leave it permanently stuck).
// A client object is immutable once created; nothing about calling it
// concurrently can corrupt another caller's tag, because there is no
// shared mutable tag — each client closes over its own values for its own
// lifetime. One shape fixes both the engine defect and the priority
// defect, because they were the same underlying mistake twice.
//
// Coverage, stated plainly rather than implied: this correctly tags any
// call written directly against a client returned here. It does NOT
// retroactively tag calls made on a caller's behalf by a DIFFERENT file's
// shared helper unless that helper itself accepts and forwards a client —
// see core/universe.js's own client parameter (2026-08-30) for the
// pattern that closes this specific gap for the shared fetch helpers
// found not to have direct alpacaGet calls of their own. Classic-script
// scoping still means one file's client instance has no way to reach into
// a DIFFERENT file's own top-level reference to the bare global — Warrior
// code that calls alpacaGet directly (engines/warrior/*.js, real ES
// modules) can shadow it cheaply (`const alpacaGet = createApiClient(...)
// .alpacaGet;`, module-scoped, zero collision risk); classic scripts
// sharing the page's one global scope (app.js, core/*.js) can't use that
// same shadow (a parse-time redeclaration collision, not a local shadow —
// same class of hazard core/store.js's own header comment documents for
// `supabaseClient` vs `const supabase`) and instead hold their own named
// client (see app.js's edgeApiClient) or accept one as a parameter.
function createApiClient(engine, priority = 'foreground') {
  return { alpacaGet: (path, params, base) => _alpacaGetImpl(engine, priority, path, params, base) };
}

// Shared default for functions in OTHER classic scripts that now accept a
// client parameter (core/universe.js, core/market-data.js's fetchSnapshots)
// — defined once, here, because classic scripts share one global lexical
// scope: a second `const _coreClient = createApiClient('CORE')` declared
// in another script tag would be a parse-time redeclaration collision,
// the same hazard createApiClient's own comment documents for `alpacaGet`
// itself. One instance, referenced by name everywhere else.
const _coreClient = createApiClient('CORE');

async function testAlpacaConnection() {
  try {
    await alpacaGet('/stocks/snapshots', { symbols: 'AAPL', feed:'iex' });
    return true;
  } catch(e) { return false; }
}
