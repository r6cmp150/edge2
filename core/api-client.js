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
//    a rolling 60s send-timestamp log per engine. Enforced ONLY while two
//    or more engines have actually sent a request within the current
//    window (see spec: a strict cap would throttle EDGE on Phase 1's wide
//    scans for a competitor — Warrior — that isn't running yet). The
//    global bucket above still protects Alpaca either way; this second
//    ceiling exists purely so neither engine can starve the other once
//    both are genuinely active.
//
// Within those ceilings the queue is priority-ordered, not FIFO: the
// oldest eligible 'foreground' entry is always chosen over a 'background'
// one. "Eligible" means both ceilings currently allow it.
//
// engine/priority aren't parameters of alpacaGet (the spec requires its
// signature stay unchanged). engine defaults to 'EDGE' — the only engine
// that exists; nothing else calls alpacaGet yet. priority comes from an
// ambient flag (see withBackgroundPriority) rather than being threaded
// through every intermediate function's signature.

const RATE_LIMIT_PER_MIN = 200;          // Alpaca Basic's actual hard limit
const RATE_LIMIT_TARGET_PER_MIN = 170;   // sustained refill target, headroom under the hard cap
const PER_ENGINE_BUDGET_FRACTION = 0.6;  // neither engine may exceed 60% of the hard cap, once 2+ engines are active
const PER_ENGINE_CAP = Math.floor(RATE_LIMIT_PER_MIN * PER_ENGINE_BUDGET_FRACTION); // 120/min
const WINDOW_MS = 60 * 1000;

const MAX_429_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

let _tokens = RATE_LIMIT_PER_MIN;
let _lastRefill = Date.now();
const _refillPerMs = RATE_LIMIT_TARGET_PER_MIN / WINDOW_MS;

const _engineTimestamps = { EDGE: [], WARRIOR: [], CORE: [] }; // rolling log of send times, last WINDOW_MS, per engine

const _queue = []; // { run, resolve, reject, engine, priority }
let _draining = false;
let _backoffUntil = 0;

let _ambientPriority = 'foreground';

// Wraps `fn` so every alpacaGet call reachable inside it (directly, or via
// other core/ functions such as fetchSnapshots) is tagged 'background'
// instead of the default 'foreground' — without changing any intermediate
// function's signature. Used by app.js's checkPriceAlerts, the one
// identified background poller this phase exists to isolate from whatever
// the user is actively looking at.
//
// The flag is restored in a `finally`, not just after the awaited call —
// restoring it only on the success path would leave 'background' set for
// the rest of the page's life if `fn` ever throws, permanently
// deprioritizing every future request (including the user's own Refresh)
// behind nothing. A thrown exception must not leak ambient state.
//
// Known, accepted limitation: this is ambient module-level state, not true
// per-call-chain context (browsers have no AsyncLocalStorage equivalent).
// If a genuinely foreground call fires while a background-wrapped call is
// still in flight, it can be briefly mistagged 'background' until the
// wrapped call finishes and its `finally` runs. checkPriceAlerts' own
// requests are brief, so the collision window is narrow, and the
// consequence is a few seconds of suboptimal priority, not a correctness
// break — nothing is dropped or mis-fetched.
async function withBackgroundPriority(fn) {
  const prev = _ambientPriority;
  _ambientPriority = 'background';
  try {
    return await fn();
  } finally {
    _ambientPriority = prev;
  }
}

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

// Number of engines with at least one send in the current rolling window —
// the per-engine cap only applies once this is >= 2 (see header comment).
function _activeEngineCount() {
  let count = 0;
  for (const engine of Object.keys(_engineTimestamps)) {
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

  const capApplies = _activeEngineCount() >= 2;

  let bestIdx = -1;
  for (let i = 0; i < _queue.length; i++) {
    const item = _queue[i];
    _pruneEngineWindow(item.engine);
    if (capApplies && _engineTimestamps[item.engine].length >= PER_ENGINE_CAP) continue;
    if (bestIdx === -1) { bestIdx = i; continue; }
    if (item.priority === 'foreground' && _queue[bestIdx].priority === 'background') bestIdx = i;
  }
  return bestIdx;
}

// Concurrency work (MAX_CONCURRENT / multi-worker _drain) reverted here
// pending root-causing a 290.7/min pacing violation found while testing it
// — the token bucket itself needs to be verified correct in isolation
// before concurrency is reintroduced on top of it. See
// docs/warrior-engine-spec-v2.md Phase 0.5's rewritten acceptance criteria.
async function _drain() {
  if (_draining) return;
  _draining = true;
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
      try {
        const result = await item.run();
        item.resolve(result);
      } catch (e) {
        item.reject(e);
      }
    }
  } finally {
    _draining = false;
  }
}

// enqueue(request, { engine, priority }) — docs/warrior-engine-spec-v2.md
// Phase 0.5. `request` is a zero-arg function returning a promise (the
// actual fetch). Resolves/rejects with request()'s own outcome once the
// queue has cleared it against the token bucket and per-engine budget.
function enqueue(request, { engine = 'EDGE', priority = 'foreground' } = {}) {
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
// Routes through enqueue() — see the Phase 0.5 section above. Signature is
// unchanged from before the queue existed: callers don't know or care that
// it's there. On a 429, retries up to MAX_429_RETRIES times with
// exponential backoff (pausing the whole queue meanwhile, since a 429
// usually signals the account-wide limit was hit, not just this engine's
// share of it) before finally throwing — existing callers' error handling
// is unaffected, they already handle a thrown Error from a non-2xx.
async function alpacaGet(path, params = {}, base = ALPACA_BASE) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const engine = 'EDGE'; // only engine that exists today — see queue section header comment
  const priority = _ambientPriority;

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

async function testAlpacaConnection() {
  try {
    await alpacaGet('/stocks/snapshots', { symbols: 'AAPL', feed:'iex' });
    return true;
  } catch(e) { return false; }
}
