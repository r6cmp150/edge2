// engines/warrior/index.js — Warrior engine. docs/warrior-engine-spec-v2.md
// Phase 2 (scaffold) + Phase 3 (5 Pillars gate).
//
// Real ES module (uses `export`/`import`) — loaded ONLY via dynamic
// import() from app.js's boot sequence, never a <script> tag, never
// statically imported from outside engines/warrior/. That's what keeps a
// syntax error in Warrior code from blocking page parse. See CLAUDE.md's
// isolation invariants and scripts/check-boundaries.sh's enforcement.
// gate.js is a static import WITHIN engines/warrior/ — fine, that's
// Warrior's own file importing its own sibling, not crossing the
// shell/core/EDGE boundary CLAUDE.md protects.
//
// Runs in the same global scope as app.js/core/*.js despite being a module
// (only this file's own top-level declarations are module-scoped) — so it
// references registerEngine/state/showGlobalErrorToast/getMarketStatus/
// getUniverse/renderWarriorTab as ordinary globals. That's expected, not a
// boundary leak: the rule this phase enforces is "nothing outside this
// file reaches INTO Warrior code except through the registry," not
// "Warrior code can't read the app's shared globals or call its shared
// utilities" — Phase 2 already established calling showGlobalErrorToast
// this way, and Phase 3 does the same for renderWarriorTab.
import { evaluateGateBatch, _selectStrategy } from './gate.js';

const WARRIOR_SCAN_INTERVAL_MS = 60 * 1000;
let _scanIntervalId = null;

// Scan state lives here, module-scoped — NOT exposed as a stored reference
// to any caller. The only way anything outside this file reaches it is
// through the registry's renderTab/rescan hooks, both defined and
// registered from this same module (Phase 2 acceptance: no stored
// reference, no exceptions).
let _lastScanResults = null; // { session, results: [gateResult...], scannedAt }
let _scanInFlight = false;

// Self-contained: catches its own errors internally rather than relying on
// the caller to wrap it, so the interval path and the manual-refresh path
// (rescan(), below) get IDENTICAL error handling — one candidate implicit
// contract instead of two call sites needing to independently remember to
// wrap it. _startScanInterval's own try/catch (unchanged from Phase 2)
// stays in place regardless, as a defensive backstop — belt and suspenders,
// not a substitute for this.
async function _scanTick() {
  if (_scanInFlight) return; // don't overlap an interval tick with an in-flight manual rescan or vice versa
  _scanInFlight = true;
  if (typeof setRefreshSpinning === 'function') setRefreshSpinning(true);
  try {
    const session = (typeof getMarketStatus === 'function') ? getMarketStatus().status : 'CLOSED';
    const strategy = _selectStrategy(session);
    const universe = await getUniverse({ session, strategy });
    const { results, rvolCheckable } = await evaluateGateBatch(universe, session);
    _lastScanResults = { session, results, scannedAt: new Date(), rvolCheckable };
    if (typeof state !== 'undefined' && state.activeTab === 'warrior' && typeof renderWarriorTab === 'function') {
      renderWarriorTab();
    }
  } catch (err) {
    _handleScanError(err);
  } finally {
    _scanInFlight = false;
    if (typeof setRefreshSpinning === 'function') setRefreshSpinning(false);
  }
}

// Registry hook (Phase 3 addition, not in Phase 2's original five) — the
// header ↻ Refresh button's onclick reaches this through
// getEngine('WARRIOR').rescan(), never a stored module reference. Just
// _scanTick(): identical error handling and in-flight guarding as the
// automatic interval, by construction rather than by remembering to
// duplicate it.
async function rescan() {
  await _scanTick();
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
// callback whose returned promise isn't awaited). _scanTick is now
// self-contained (see above) so this rarely has anything to actually
// catch in practice — kept anyway as a defensive backstop against a
// future _scanTick that forgets its own try/catch.
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

// Matches app.js's own buyTime/sellTime convention (getPT() then read
// hour/minute) rather than toLocaleTimeString(), which defaults to the
// viewer's browser-local time — inconsistent with every other timestamp
// this app shows, all of which are PT. Found and fixed same-session
// (2026-08-26): this file's own first draft used toLocaleTimeString()
// with no options at all.
function _formatPTTime(date) {
  const pt = getPT(date);
  return `${String(pt.getHours()).padStart(2, '0')}:${String(pt.getMinutes()).padStart(2, '0')}`;
}

function _pillarValueDisplay(pillar) {
  if (pillar.status === 'not-checked') return pillar.reason || 'not checked';
  if (pillar.id === 'rvol' && typeof pillar.value === 'number') {
    const expected = pillar.expectedByNow != null ? Math.round(pillar.expectedByNow).toLocaleString() : '—';
    const actual = pillar.todayVolume != null ? Math.round(pillar.todayVolume).toLocaleString() : '—';
    return `${pillar.value.toFixed(2)}× (expected by now ${expected}, actual ${actual})`;
  }
  if (pillar.id === 'change' && typeof pillar.value === 'number') return `${pillar.value.toFixed(1)}%`;
  if (pillar.id === 'price' && typeof pillar.value === 'number') return `$${pillar.value.toFixed(2)}`;
  return pillar.value == null ? '—' : String(pillar.value);
}

function _renderPillarRow(pillar) {
  const icon = pillar.status === 'pass' ? '✓' : pillar.status === 'fail' ? '✗' : '—';
  const cls = pillar.status === 'pass' ? 'wp-pass' : pillar.status === 'fail' ? 'wp-fail' : 'wp-notchecked';
  return `<div class="warrior-pillar-row ${cls}">
    <span class="warrior-pillar-icon">${icon}</span>
    <span class="warrior-pillar-label">${pillar.id}</span>
    <span class="warrior-pillar-value">${_pillarValueDisplay(pillar)}</span>
  </div>`;
}

function _renderCandidateCard(gateResult) {
  return `<div class="warrior-card">
    <div class="warrior-card-header">
      <span class="warrior-card-symbol">${gateResult.symbol}</span>
    </div>
    <div class="warrior-card-halt">⚠ Halt status not checked — verify in your broker before buying.</div>
    ${gateResult.pillars.map(_renderPillarRow).join('')}
  </div>`;
}

function renderTab() {
  if (!_lastScanResults) {
    return `<div class="tab-header">
      <h1 class="tab-title">WARRIOR</h1>
    </div>
    <div class="empty-state">
      <div class="empty-icon">🥋</div>
      <p>No scan yet — tap ↻ Refresh to run one.</p>
    </div>`;
  }
  const { session, results, scannedAt, rvolCheckable } = _lastScanResults;
  const qualified = results.filter(r => r.tier === 'QUALIFIED');
  const nearMiss = results.filter(r => r.tier === 'NEAR_MISS');
  // RVOL is the most selective of the 5 pillars — a section header that
  // just says "QUALIFIED (10)" outside regular session (or in the first 15
  // minutes) claims more confidence than the pillars underneath it earned:
  // those candidates cleared price+change+news, never RVOL, since RVOL was
  // structurally not-checked, not passed. Same "say what you don't know"
  // principle already applied to individual pillar rows, one level up. See
  // gate.js's evaluateGateBatch/classifyGate comments for why this isn't a
  // classification change — the tiers themselves are still correct.
  const rvolCaveat = rvolCheckable ? '' : ' — RVOL not evaluated this session';
  return `<div class="tab-header">
    <h1 class="tab-title">WARRIOR</h1>
  </div>
  <div class="tab-subtitle">Session: ${session} · ${results.length} scanned · last scan ${_formatPTTime(scannedAt)} PT</div>
  <div class="section-label">QUALIFIED (${qualified.length})${rvolCaveat}</div>
  ${qualified.length ? qualified.map(_renderCandidateCard).join('') : '<div class="empty-state"><p>No qualified candidates this scan.</p></div>'}
  <div class="section-label mt12">NEAR MISS (${nearMiss.length})${rvolCaveat}</div>
  ${nearMiss.length ? nearMiss.map(_renderCandidateCard).join('') : '<div class="empty-state"><p>No near-miss candidates this scan.</p></div>'}`;
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
    rescan,
  });
  _startScanInterval();
}

// Not called by app.js today (nothing tears Warrior down at runtime yet),
// but exported so a future engine-reload path and this module's own tests
// have a clean way to stop the interval without leaking it.
export function unregister() {
  _stopScanInterval();
}
