// engines/warrior/index.js — Warrior engine. docs/warrior-engine-spec-v2.md
// Phase 2.
//
// Real ES module (uses `export`) — loaded ONLY via dynamic import() from
// app.js's boot sequence, never a <script> tag, never statically imported.
// That's what makes a syntax error here a rejected promise instead of a
// page-load-blocking parse error. See CLAUDE.md's isolation invariants and
// scripts/check-boundaries.sh's enforcement of them.
//
// Phase 2 scope: scaffold only. No 5 Pillars gate (Phase 3), no setup
// detection (Phase 5) yet — renderTab below is a stub on purpose. This
// phase proves the registry contract and the error-isolation boundaries
// work; it doesn't ship a real scanner.
//
// Runs in the same global scope as app.js/core/*.js despite being a module
// (only this file's own top-level declarations are module-scoped) — so it
// references registerEngine/state/showGlobalErrorToast as ordinary
// globals, same as core/*.js does. That's expected, not a boundary leak:
// the boundary this phase enforces is "nothing outside this file reaches
// INTO Warrior code except through the registry," not "Warrior code can't
// read the app's shared globals."

const WARRIOR_SCAN_INTERVAL_MS = 60 * 1000;
let _scanIntervalId = null;

// Placeholder for the real scan (Phase 3+). Deliberately a separate, named
// function rather than inlined into the interval callback, so a test (or a
// deliberate manual injection) can replace it to verify the error boundary
// without real scan logic needing to exist yet.
async function _scanTick() {
  // Nothing to scan (Phase 3/5 not built). Exists so the interval and its
  // error-boundary structure are real and testable now, rather than added
  // later when there's a lot more to get wrong at once.
}

// Every error that escapes Warrior code toward a shared surface is tagged
// with the '[Warrior]' prefix in its message — a convention, not a special
// case in the shared code that reads it. The global unhandledrejection
// handler (app.js) stays engine-agnostic; it just shows whatever message
// arrives. Tagging happens here, at the source, so attribution doesn't
// require the shared handler to know Warrior exists.
function _tag(err) {
  const msg = err?.message ?? String(err);
  return msg.startsWith('[Warrior]') ? msg : `[Warrior] ${msg}`;
}

function _handleScanError(err) {
  const tagged = _tag(err);
  console.error(tagged);
  if (typeof state !== 'undefined') {
    state.warrior = state.warrior || {};
    state.warrior.lastScanError = tagged;
  }
  if (typeof showGlobalErrorToast === 'function') {
    showGlobalErrorToast(tagged);
  }
}

// Spec's error-boundary rule, enforced exactly: the try/catch goes INSIDE
// the callback body, not around the setInterval() call — a try/catch
// around setInterval itself only catches a throw during registration,
// never one from inside the ticking callback. Also catches rejections
// (try/catch alone doesn't catch an unhandled async rejection from a
// callback whose returned promise isn't awaited), so a rejecting
// _scanTick can't become an unhandled rejection at all — this interval
// is fully self-contained regardless of what future scan logic does here.
function _startScanInterval() {
  _scanIntervalId = setInterval(() => {
    try {
      const result = _scanTick();
      if (result && typeof result.catch === 'function') {
        result.catch(_handleScanError);
      }
    } catch (err) {
      _handleScanError(err);
    }
  }, WARRIOR_SCAN_INTERVAL_MS);
}

function _stopScanInterval() {
  if (_scanIntervalId != null) {
    clearInterval(_scanIntervalId);
    _scanIntervalId = null;
  }
}

function renderTab() {
  return `<div class="tab-header">
    <h1 class="tab-title">WARRIOR</h1>
  </div>
  <div class="empty-state">
    <div class="empty-icon">🥋</div>
    <p>Warrior engine loaded — scanning not yet implemented.<br>
    5 Pillars gate (Phase 3) and setup detection (Phase 5) land in later phases.</p>
  </div>`;
}

function renderBadge(position) {
  return `<span class="badge" style="background:rgba(160,120,255,0.15);color:#a078ff;border:1px solid rgba(160,120,255,0.35)">WARRIOR</span>`;
}

function renderSnapshot(signalSnapshot) {
  return `<div class="card-sub">Warrior signal detail not yet implemented (Phase 3+).</div>`;
}

// Generic conservative rule until Phase 6 supplies Warrior-specific exit
// logic — stop breach only, matching the spec's stated fallback shape for
// when a real evaluateExit isn't available yet.
function evaluateExit(position, liveData) {
  const price = liveData?.price;
  if (typeof price === 'number' && typeof position?.stop === 'number' && price <= position.stop) {
    return { status: 'SELL', reasons: ['Stop-loss breached'] };
  }
  return { status: 'HOLD', reasons: [] };
}

function summarizeForReport(trades) {
  return `Warrior: ${trades.length} trade(s) — per-engine statistics not yet implemented (Phase 8).`;
}

export function register() {
  registerEngine('WARRIOR', {
    label: 'Warrior',
    renderTab,
    renderBadge,
    renderSnapshot,
    evaluateExit,
    summarizeForReport,
  });
  _startScanInterval();
}

// Not called by app.js today (nothing tears Warrior down at runtime yet),
// but exported so a future engine-reload path and this module's own tests
// have a clean way to stop the interval without leaking it.
export function unregister() {
  _stopScanInterval();
}
