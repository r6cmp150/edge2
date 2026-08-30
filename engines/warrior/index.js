// engines/warrior/index.js — Warrior engine. docs/warrior-engine-spec-v2.md
// Phase 2 (scaffold) + Phase 3 (5 Pillars gate) + Phase 4 (replay harness)
// + Phase 5 (setup detection).
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
// getUniverse/renderWarriorTab/_countRequests/getAvailableBudget as
// ordinary globals. That's expected, not a boundary leak: the rule this
// phase enforces is "nothing outside this file reaches INTO Warrior code
// except through the registry," not "Warrior code can't read the app's
// shared globals or call its shared utilities" — Phase 2 already
// established calling showGlobalErrorToast this way, Phase 3 did the same
// for renderWarriorTab and core/universe.js's request-counting
// diagnostic, and Phase 5 does it again for app.js's getAvailableBudget
// (position-sizing's budget cap reuses EDGE's own budget-bar formula
// rather than computing a second, parallel notion of "available").
import { evaluateGateBatch, _selectStrategy } from './gate.js';
import { runReplayForSymbols } from './replay.js';
import { evaluateSetupsBatch, SETUP_REPLAY_CATALOG, ALL_SETUPS_ID, scanDateRangeForSetups, estimateRangeScanRequests, _tradingDaysBetween } from './setups.js';

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

    // Wrapped with _countRequests (core/universe.js — already relied on by
    // diagnosePremarketGap there) unconditionally, not just when logging
    // below: negligible overhead (it just proxies the shared alpacaGet for
    // the duration of one call), and keeping it unconditional means the
    // logging line below can be deleted on its own later without also
    // having to restore two different call shapes for getUniverse/
    // evaluateGateBatch.
    const { result: universe, count: universeRequests } = await _countRequests(() => getUniverse({ session, strategy }));
    const { result: gateResult, count: gateRequests } = await _countRequests(() => evaluateGateBatch(universe, session));
    const { results, rvolCheckable } = gateResult;

    // Phase 5: setup detection runs only for QUALIFIED candidates (NEAR
    // MISS gets no setups section — those aren't actionable candidates)
    // and only during PRE (armed levels only — no setup can trigger
    // before the open) or OPEN (full detection). This is a NEW fetch on
    // top of Phase 3's gate pipeline, which is why the PHASE-3-UNVERIFIED
    // request count below now covers all three stages together, not just
    // universe+gate — they're one pipeline now, not two to verify
    // separately.
    const qualified = results.filter(r => r.tier === 'QUALIFIED');
    const riskPerTradeDollars = (parseFloat(state.settings?.budget) || 0) * (parseFloat(state.settings?.riskPerTradePct) || 0) / 100;
    const availableBudget = (typeof getAvailableBudget === 'function') ? getAvailableBudget() : 0;
    const { result: setupsResult, count: setupsRequests } = await _countRequests(() =>
      evaluateSetupsBatch(qualified, session, { now: new Date(), riskPerTradeDollars, availableBudget })
    );
    for (const r of qualified) {
      const sr = setupsResult.resultsBySymbol[r.symbol];
      r.setups = sr ? sr.setups : [];
      r.primarySetup = sr ? sr.primary : null;
      r.armedLevels = sr ? sr.armedLevels : [];
    }

    // PHASE-3-UNVERIFIED (2026-08-26, updated 2026-08-28 for Phase 5's
    // added fetch): two live checks outstanding from Phase 3's merge —
    // feed=sip in the network log, and this exact request count against
    // the acceptance bullet's <30 target (the request count checked
    // during the merge's own live-check pass excluded the RVOL fetches,
    // since that check ran outside regular session — see docs/warrior-
    // engine-spec-v2.md Phase 3 acceptance). Now covers universe+gate+
    // setups together — Phase 5 added a real fetch to this same pipeline,
    // so a count that only covered the first two stages would no longer
    // answer the acceptance bullet's actual question. Logs every
    // regular-session scan, not just the first, so it's hard to miss
    // glancing at the console once. DELETE this whole block (and revert
    // the three _countRequests-wrapped calls above to plain, unwrapped
    // ones) once both are confirmed live.
    if (session === 'OPEN') {
      const total = universeRequests + gateRequests + setupsRequests;
      console.log(`[PHASE-3-UNVERIFIED] regular-session scan — universe: ${universeRequests} req, gate: ${gateRequests} req, setups: ${setupsRequests} req, total: ${total} req (acceptance: <30 for a 50-symbol universe). Also confirm feed=sip in the network log for this scan's requests.`);
    }

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

// ── Phase 5: setups, armed levels, entry/target/stop ─────────────────────
// Only QUALIFIED gateResults ever carry .setups/.armedLevels (index.js's
// _scanTick attaches them only for the QUALIFIED subset) — NEAR MISS
// results simply don't have these fields, so the checks below naturally
// render nothing for them without needing to separately track tier here.

// Raw price/level fields a *Pct margin was measured against (breakoutHigh
// for gap-and-go/hod-momentum's high-based checks, aLevel/cLevel for
// ABCD, vwap for VWAP Momentum) — shown explicitly so every margin is
// recomputable from numbers actually on the row, not just asserted.
// Named individually (not matched by suffix) since 'threshold' also lands
// in the plain-number fallback below and is never a dollar value.
const PRICE_MARGIN_KEYS = new Set(['breakoutHigh', 'aLevel', 'cLevel', 'vwap']);

function _fmtMargin(key, value) {
  if (typeof value !== 'number') return `${key}: —`;
  // *Pct/*Multiple/*Ratio fields are ratios/fractions; PRICE_MARGIN_KEYS
  // are dollar values; *SpanMinutes/*Minutes report real elapsed time
  // (how much wall-clock time actually backs a volume baseline — the
  // live-replay finding that a bar-count window can silently reach back
  // much further for a thin name than a dense one); *BarCount is a plain
  // integer; everything else (thresholds paired alongside a *Multiple/
  // *Ratio field) is a plain number at its own precision.
  if (/Pct$/.test(key)) return `${key}: ${(value * 100).toFixed(1)}%`;
  if (/Minutes$/.test(key)) return `${key}: ${value.toFixed(0)}m`;
  if (/Count$/.test(key)) return `${key}: ${value.toFixed(0)}`;
  if (/Multiple$|Ratio$/.test(key)) return `${key}: ${value.toFixed(2)}×`;
  if (PRICE_MARGIN_KEYS.has(key)) return `${key}: $${value.toFixed(2)}`;
  return `${key}: ${value.toFixed(2)}`;
}

function _renderMargins(margins) {
  if (!margins) return '';
  return Object.entries(margins).map(([k, v]) => `<span class="warrior-margin">${_fmtMargin(k, v)}</span>`).join(' ');
}

function _renderEntryTargetStop(setup) {
  const ets = setup.entryTargetStop;
  if (!ets) return '<div class="warrior-ets-unavailable">Entry/target/stop not computable for this trigger.</div>';
  const constraintNote = setup.sizingConstraint === 'budget' ? ' (capped by available budget)' : setup.sizingConstraint === 'risk' ? ' (risk-based)' : '';
  return `<div class="warrior-ets">
    <span>Entry $${ets.entry.toFixed(2)}</span>
    <span>Stop $${ets.stop.toFixed(2)}</span>
    <span>Target $${ets.target.toFixed(2)}</span>
    <span>Shares ${setup.suggestedShares}${constraintNote}</span>
  </div>`;
}

function _renderSetupRow(setup, isPrimary) {
  const lateFlag = setup.late ? '<span class="warrior-setup-late">LATE</span>' : '';
  const primaryFlag = isPrimary ? '<span class="warrior-setup-primary">PRIMARY</span>' : '';
  return `<div class="warrior-setup-row ${isPrimary ? 'is-primary' : ''}">
    <div class="warrior-setup-header">
      <span class="warrior-setup-id">${setup.id}</span>
      ${primaryFlag}${lateFlag}
      <span class="warrior-setup-time">$${setup.triggerPrice.toFixed(2)} @ ${_formatPTTime(new Date(setup.triggeredAt))} PT · ${Math.round(setup.minutesSinceTrigger)}m ago</span>
    </div>
    <div class="warrior-setup-margins">${_renderMargins(setup.margins)}</div>
    ${isPrimary ? _renderEntryTargetStop(setup) : ''}
  </div>`;
}

function _renderArmedLevels(armedLevels) {
  if (!armedLevels || !armedLevels.length) return '';
  return `<div class="warrior-armed-levels">
    ${armedLevels.map(l => `<span class="warrior-armed-level">${l.id === 'gap-and-go' ? 'Gap and Go' : l.id} level: $${l.level.toFixed(2)}</span>`).join('')}
  </div>`;
}

function _renderSetupsSection(gateResult) {
  if (gateResult.armedLevels && gateResult.armedLevels.length) return _renderArmedLevels(gateResult.armedLevels);
  if (!gateResult.setups || !gateResult.setups.length) return '';
  return `<div class="warrior-setups">
    ${gateResult.setups.map(s => _renderSetupRow(s, s.id === gateResult.primarySetup?.id)).join('')}
  </div>`;
}

function _renderCandidateCard(gateResult) {
  return `<div class="warrior-card">
    <div class="warrior-card-header">
      <span class="warrior-card-symbol">${gateResult.symbol}</span>
    </div>
    <div class="warrior-card-halt">⚠ Halt status not checked — verify in your broker before buying.</div>
    ${gateResult.pillars.map(_renderPillarRow).join('')}
    ${_renderSetupsSection(gateResult)}
  </div>`;
}

// ── Phase 4: replay harness UI ──────────────────────────────────────────
// Dev-only — gated on state.settings.developerTools, a generic toggle
// (app.js/Settings; no Warrior-specific strings there, CLAUDE.md's rule).
// Warrior renders its own panel and wires its own handler; shell never
// stores a reference to any of this (register() below just assigns a
// plain global function, same connection mechanism every onclick in this
// app already uses — not a boundary exception).
let _lastReplayResult = null; // { dateStr, symbols, classifierId, resultsBySymbol, requests } | null (single-day mode)
let _lastRangeScanResult = null; // { setupIds, symbols, startDate, endDate, resultsByDate, tradingDays, requests, cancelled } | null
let _replayInFlight = false;
let _rangeScanInFlight = false;
let _rangeScanProgress = null; // { index, total, dateStr } | null, updated live during a scan
let _rangeScanCancelRequested = false;
let _rangeScanConfirmPending = false; // true after a first click that exceeded the confirm threshold, awaiting a second click
const _expandedScanCells = new Set(); // "date|symbol|setupId" keys currently expanded to show per-trigger detail

// Above this many trading days OR this many estimated requests (whichever
// hits first), Run requires a second explicit click — the estimate is
// already on screen by then, so the confirm is reading a number you can
// see, not guessing. Hard ceiling is a pure typo backstop (e.g. 2016
// instead of 2026), not a usable-range limit — capping below what's
// actually useful (a thin small-cap may only produce a handful of
// legitimate fires in a whole quarter) would make the tool decorative.
const RANGE_SCAN_CONFIRM_DAYS_THRESHOLD = 30;
const RANGE_SCAN_CONFIRM_REQUESTS_THRESHOLD = 100;
const RANGE_SCAN_HARD_CEILING_DAYS = 250;

// Phase 5 acceptance's own first bullet ("every setup validated through
// the replay harness before shipping") is not satisfied by unit-test
// fixtures alone — a fixture written from the same reasoning that
// produced the classifier tends to agree with it regardless of whether
// the classifier is actually right, which this session has found
// repeatedly elsewhere. 'example' keeps Phase 4's original placeholder
// available; the five real entries (plus ALL_SETUPS_ID, added so
// comparing all five costs one fetch instead of five) let this panel run
// ACTUAL setups against ACTUAL historical bars, a genuinely independent
// check.
const REPLAY_CLASSIFIER_OPTIONS = [
  { id: 'example', label: 'Example (Phase 4 placeholder)' },
  { id: ALL_SETUPS_ID, label: 'All setups' },
  ...SETUP_REPLAY_CATALOG.map(e => ({ id: e.id, label: e.label })),
];

function _setupIdsForClassifierId(classifierId) {
  return classifierId === ALL_SETUPS_ID ? SETUP_REPLAY_CATALOG.map(e => e.id) : [classifierId];
}

function _readReplayFormInputs() {
  const g = (id) => (typeof document !== 'undefined') ? document.getElementById(id) : null;
  return {
    dateStr: g('warrior-replay-date')?.value,
    endDateStr: g('warrior-replay-end-date')?.value,
    symbols: (g('warrior-replay-symbols')?.value || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    classifierId: g('warrior-replay-classifier')?.value || 'example',
  };
}

// Direct DOM update, NOT a full renderWarriorTab() re-render — the panel
// has several text/date inputs, and a full innerHTML rebuild on every
// keystroke would drop focus/cursor position out from under whoever's
// typing. Wired via oninput/onchange on the date/symbol/classifier
// fields (see renderReplayPanel below).
function _updateReplayEstimateDisplay() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('warrior-replay-estimate');
  if (!el) return;
  const { dateStr, endDateStr, symbols, classifierId } = _readReplayFormInputs();
  if (!dateStr || !endDateStr || !symbols.length || classifierId === 'example') {
    el.textContent = '';
    return;
  }
  const setupIds = _setupIdsForClassifierId(classifierId);
  const tradingDays = _tradingDaysBetween(dateStr, endDateStr);
  if (tradingDays.length > RANGE_SCAN_HARD_CEILING_DAYS) {
    el.textContent = `${tradingDays.length} trading days exceeds the ${RANGE_SCAN_HARD_CEILING_DAYS}-day ceiling — narrow the range.`;
    el.className = 'settings-hint warrior-estimate-blocked';
    return;
  }
  const requests = estimateRangeScanRequests(setupIds, symbols.length, tradingDays.length);
  const needsConfirm = tradingDays.length > RANGE_SCAN_CONFIRM_DAYS_THRESHOLD || requests > RANGE_SCAN_CONFIRM_REQUESTS_THRESHOLD;
  el.textContent = `≈${requests} request(s) across ${tradingDays.length} trading day(s)${needsConfirm ? ' — will require confirmation' : ''}`;
  el.className = 'settings-hint';
}

async function _runReplayFromUI() {
  if (_replayInFlight || _rangeScanInFlight) return;
  const { dateStr, endDateStr, symbols, classifierId } = _readReplayFormInputs();
  if (!dateStr || !symbols.length) {
    if (typeof showGlobalErrorToast === 'function') showGlobalErrorToast('[Warrior] Replay needs a date and at least one symbol.');
    return;
  }
  // 'example' is Phase 4's disposable demo classifier (runReplayForSymbols,
  // replay.js) — not a real setup, can't go through scanDateRangeForSetups
  // (SETUP_REPLAY_CATALOG doesn't know it), stays its own small path.
  if (classifierId === 'example') {
    _replayInFlight = true;
    if (typeof renderWarriorTab === 'function') renderWarriorTab();
    try {
      const { resultsBySymbol, requests } = await runReplayForSymbols(symbols, dateStr);
      _lastReplayResult = { dateStr, symbols, classifierId, resultsBySymbol, requests };
      _lastRangeScanResult = null;
    } catch (err) {
      if (typeof showGlobalErrorToast === 'function') showGlobalErrorToast(`[Warrior] Replay failed: ${err.message}`);
    } finally {
      _replayInFlight = false;
      if (typeof renderWarriorTab === 'function') renderWarriorTab();
    }
    return;
  }
  // Every real setup goes through the range scan, single day included —
  // start === end when no end date was given. One code path for both
  // (2026-08-30 unification), not two that can drift: the Phase-4-era
  // single-day function this replaced had no not-evaluated concept at
  // all, so a symbol with zero bars on that path silently rendered as
  // "0 triggers" — indistinguishable from a real evaluated-and-didn't-
  // fire day. scanDateRangeForSetups already gets this right; collapsing
  // onto it removes the second implementation instead of teaching it the
  // same lesson separately.
  return _runRangeScanFromUI(dateStr, endDateStr || dateStr, symbols, classifierId);
}

async function _runRangeScanFromUI(startDate, endDate, symbols, classifierId) {
  if (classifierId === 'example') {
    if (typeof showGlobalErrorToast === 'function') showGlobalErrorToast('[Warrior] Range scan needs a real setup (or "All setups"), not the Phase 4 placeholder.');
    return;
  }
  const setupIds = _setupIdsForClassifierId(classifierId);
  const tradingDays = _tradingDaysBetween(startDate, endDate);
  if (tradingDays.length > RANGE_SCAN_HARD_CEILING_DAYS) {
    if (typeof showGlobalErrorToast === 'function') showGlobalErrorToast(`[Warrior] ${tradingDays.length} trading days exceeds the ${RANGE_SCAN_HARD_CEILING_DAYS}-day ceiling — narrow the range.`);
    return;
  }
  const requests = estimateRangeScanRequests(setupIds, symbols.length, tradingDays.length);
  const needsConfirm = tradingDays.length > RANGE_SCAN_CONFIRM_DAYS_THRESHOLD || requests > RANGE_SCAN_CONFIRM_REQUESTS_THRESHOLD;
  if (needsConfirm && !_rangeScanConfirmPending) {
    _rangeScanConfirmPending = true;
    if (typeof renderWarriorTab === 'function') renderWarriorTab();
    return; // first click just arms confirmation; the button's own label shows the estimate on the second click
  }
  _rangeScanConfirmPending = false;

  _rangeScanInFlight = true;
  _rangeScanCancelRequested = false;
  _rangeScanProgress = null;
  _expandedScanCells.clear();
  if (typeof renderWarriorTab === 'function') renderWarriorTab();
  try {
    const result = await scanDateRangeForSetups(classifierId, symbols, startDate, endDate, {
      onProgress: (p) => {
        _rangeScanProgress = p;
        if (typeof renderWarriorTab === 'function') renderWarriorTab();
      },
      isCancelled: () => _rangeScanCancelRequested,
    });
    _lastRangeScanResult = { setupIds, symbols, startDate, endDate, ...result };
    _lastReplayResult = null;
  } catch (err) {
    if (typeof showGlobalErrorToast === 'function') showGlobalErrorToast(`[Warrior] Range scan failed: ${err.message}`);
  } finally {
    _rangeScanInFlight = false;
    _rangeScanProgress = null;
    if (typeof renderWarriorTab === 'function') renderWarriorTab();
  }
}

function _cancelRangeScanFromUI() {
  _rangeScanCancelRequested = true;
}

function _toggleScanCellFromUI(key) {
  if (_expandedScanCells.has(key)) _expandedScanCells.delete(key);
  else _expandedScanCells.add(key);
  if (typeof renderWarriorTab === 'function') renderWarriorTab();
}

function _fmtHorizon(forwardReturns, key) {
  const f = forwardReturns[key];
  if (!f || f.return == null) return '—';
  return `${f.return.toFixed(1)}% (mfe ${f.mfe.toFixed(1)}% / mae ${f.mae.toFixed(1)}%)`;
}

function _renderTriggerRow(trig) {
  const t = new Date(trig.triggerTime);
  const timeStr = isNaN(t.getTime()) ? trig.triggerTime : t.toISOString();
  const levelStr = typeof trig.referenceLevel === 'number' ? ` (level $${trig.referenceLevel.toFixed(2)})` : '';
  const marginsStr = trig.margins ? ` — ${_renderMargins(trig.margins).replace(/<[^>]+>/g, '')}` : '';
  // close is scored against whatever the fetched window's last bar
  // happens to be, not a fixed elapsed time — always paired with how much
  // session was actually left at the trigger, so a 6-minutes-to-close
  // number can't read as equivalent to a 5-hours-to-close one the way it
  // did before this was visible (live-replay finding, 2026-08-28).
  const remaining = typeof trig.minutesOfSessionRemainingAtTrigger === 'number'
    ? `${Math.round(trig.minutesOfSessionRemainingAtTrigger)}m left in session`
    : '—';
  return `<div class="settings-hint mono">
    ${trig.setupId} @ ${timeStr} $${trig.triggerPrice.toFixed(2)}${levelStr}${marginsStr} — ${remaining} —
    5m: ${_fmtHorizon(trig.forwardReturns, '5m')} |
    15m: ${_fmtHorizon(trig.forwardReturns, '15m')} |
    30m: ${_fmtHorizon(trig.forwardReturns, '30m')} |
    close: ${_fmtHorizon(trig.forwardReturns, 'close')}
  </div>`;
}

// 'example' placeholder shape only (runReplayForSymbols, replay.js) — every
// real setup goes through the range-scan matrix now, single day included
// (see _runReplayFromUI), never this function.
function _renderReplaySymbolResult(symbol, result) {
  if (!result.triggers.length) {
    return `<div class="settings-row"><span class="mono">${symbol}</span><span class="settings-hint muted">${result.barCount} bars, no triggers</span></div>`;
  }
  return `<div class="settings-row" style="flex-direction:column;align-items:stretch;">
    <div class="mono">${symbol} — ${result.triggers.length} trigger(s), ${result.barCount} bars</div>
    ${result.triggers.map(_renderTriggerRow).join('')}
  </div>`;
}

// ── Range-scan matrix ─────────────────────────────────────────────────────
// Rows = dates, columns = setups, cell = naive->re-armed counts. THREE
// states per cell, not two (spec's own "same rule as the pillars"):
// evaluated-with-triggers, evaluated-zero-triggers, and could-not-evaluate
// (with why) — collapsing the last two into "0" would make a market
// holiday or a fetch failure read as "the classifier correctly rejected
// this day," which is a different, unearned claim. One matrix per symbol
// (a scan can cover several) rather than trying to cram multiple
// symbols' numbers into one cell. Bottom totals row across the whole
// range is the actual point of this feature — "does ABCD ever fire on
// real bars" is a totals-row question, not a per-day one.
function _scanCellKey(dateStr, symbol, setupId) { return `${dateStr}|${symbol}|${setupId}`; }

function _renderScanCell(dateStr, symbol, setupId, dayResult) {
  const key = _scanCellKey(dateStr, symbol, setupId);
  if (dayResult.notEvaluated) {
    return `<td class="warrior-scan-cell not-evaluated" title="${dayResult.reason}">n/a</td>`;
  }
  const r = dayResult.bySetup[setupId];
  if (!r) return `<td class="warrior-scan-cell not-evaluated">—</td>`;
  // Per-setup not-evaluated (2026-08-30, Q3 fix): bars exist and the OTHER
  // setups on this row evaluated fine, but this one specifically needs a
  // verified previous-trading-day close and doesn't have one — distinct
  // from the whole-day not-evaluated case above, same visual treatment.
  if (r.notEvaluated) {
    return `<td class="warrior-scan-cell not-evaluated" title="${r.reason}">n/a</td>`;
  }
  const label = `${r.naiveTriggers.length}→${r.rearmedTriggers.length}`;
  if (!r.rearmedTriggers.length) return `<td class="warrior-scan-cell zero">${label}</td>`;
  const expanded = _expandedScanCells.has(key);
  const detail = expanded ? `<div class="warrior-scan-cell-detail">${r.rearmedTriggers.map(_renderTriggerRow).join('')}</div>` : '';
  return `<td class="warrior-scan-cell fired" onclick="warriorToggleScanCell('${key.replace(/'/g, "\\'")}')">${label}${detail}</td>`;
}

function _renderScanMatrixForSymbol(symbol, setupIds, tradingDays, resultsByDate) {
  const totals = {};
  setupIds.forEach(id => { totals[id] = { naive: 0, rearmed: 0 }; });
  const rows = tradingDays.map(dateStr => {
    const dayResult = resultsByDate[dateStr]?.[symbol] || { notEvaluated: true, reason: 'not run' };
    if (!dayResult.notEvaluated) {
      setupIds.forEach(id => {
        const r = dayResult.bySetup[id];
        if (r && !r.notEvaluated) { totals[id].naive += r.naiveTriggers.length; totals[id].rearmed += r.rearmedTriggers.length; }
      });
    }
    // barCount visible on every evaluated row — the only thing that
    // distinguishes "evaluated, didn't fire" from "never evaluated" when
    // reading a matrix by eye (2026-08-30 live-validation note: this is
    // what kept a genuine live check from being fooled by an empty-bars
    // day rendering the same as a real zero).
    const barCountLabel = dayResult.notEvaluated ? '' : ` <span class="warrior-scan-barcount">(${dayResult.barCount} bars)</span>`;
    return `<tr><td class="warrior-scan-date">${dateStr}${barCountLabel}</td>${setupIds.map(id => _renderScanCell(dateStr, symbol, id, dayResult)).join('')}</tr>`;
  }).join('');
  const totalsRow = `<tr class="warrior-scan-totals"><td>TOTAL</td>${setupIds.map(id => `<td class="warrior-scan-cell">${totals[id].naive}→${totals[id].rearmed}</td>`).join('')}</tr>`;
  return `<div class="settings-row" style="flex-direction:column;align-items:stretch;">
    <div class="mono">${symbol}</div>
    <div style="overflow-x:auto;">
      <table class="warrior-scan-matrix">
        <thead><tr><th></th>${setupIds.map(id => `<th>${id}</th>`).join('')}</tr></thead>
        <tbody>${rows}${totalsRow}</tbody>
      </table>
    </div>
  </div>`;
}

function _renderRangeScanResult(result) {
  const { setupIds, symbols, tradingDays, resultsByDate, requests, cancelled, startDate, endDate } = result;
  const cancelNote = cancelled ? ` — cancelled, showing ${Object.keys(resultsByDate).length} of ${tradingDays.length} days evaluated` : '';
  return `<div class="settings-row"><span class="settings-hint">${requests} request(s), ${startDate} → ${endDate} (${tradingDays.length} trading days)${cancelNote}</span></div>
    ${symbols.map(sym => _renderScanMatrixForSymbol(sym, setupIds, tradingDays, resultsByDate)).join('')}`;
}

function renderReplayPanel() {
  if (!(typeof state !== 'undefined' && state.settings && state.settings.developerTools)) return '';

  let body;
  if (_rangeScanInFlight) {
    const p = _rangeScanProgress;
    body = `<div class="settings-row" style="flex-direction:column;align-items:stretch;">
      <span class="settings-hint">${p ? `Day ${p.index + 1} of ${p.total} — ${p.dateStr}` : 'Starting…'}</span>
      <button class="btn btn-ghost btn-sm mt4" onclick="warriorCancelRangeScan()">Cancel</button>
    </div>`;
  } else if (_lastRangeScanResult) {
    body = _renderRangeScanResult(_lastRangeScanResult);
  } else if (_lastReplayResult) {
    body = Object.entries(_lastReplayResult.resultsBySymbol).map(([sym, r]) => _renderReplaySymbolResult(sym, r)).join('');
  } else {
    body = '<div class="settings-row"><span class="settings-hint muted">No replay run yet.</span></div>';
  }

  const classifierOptions = REPLAY_CLASSIFIER_OPTIONS.map(o =>
    `<option value="${o.id}" ${(_lastReplayResult?.classifierId === o.id) ? 'selected' : ''}>${o.label}</option>`
  ).join('');

  const runDisabled = _replayInFlight || _rangeScanInFlight;
  const runLabel = _replayInFlight ? 'Running…' : _rangeScanInFlight ? 'Scanning…' : _rangeScanConfirmPending ? 'Confirm: Run Anyway' : 'Run Replay';
  const summaryLine = _lastRangeScanResult
    ? `<span class="settings-hint">${_lastRangeScanResult.requests} request(s) for ${_lastRangeScanResult.startDate} → ${_lastRangeScanResult.endDate}</span>`
    : _lastReplayResult
      ? `<span class="settings-hint">${_lastReplayResult.requests} request(s) for ${_lastReplayResult.dateStr} (${REPLAY_CLASSIFIER_OPTIONS.find(o => o.id === _lastReplayResult.classifierId)?.label || _lastReplayResult.classifierId})</span>`
      : '';

  return `<div class="settings-section mt12">
    <div class="settings-section-title">Replay Harness (dev only)</div>
    <div class="settings-row">
      <span class="settings-hint">Fetch → replay bar-by-bar → score against real history. Pick a real setup (or "All setups") to validate against actual bars, not just unit-test fixtures. Fill in an end date to scan a range instead of one day — "ABCD: 0" on one day means nothing; the same across weeks of real bars means something. See docs/warrior-engine-spec-v2.md Phase 4/5.</span>
    </div>
    <div class="settings-row">
      <select id="warrior-replay-classifier" class="settings-input" onchange="warriorUpdateReplayEstimate()">${classifierOptions}</select>
    </div>
    <div class="settings-row">
      <input type="date" id="warrior-replay-date" class="settings-input" style="max-width:160px;" value="${_lastReplayResult?.dateStr || _lastRangeScanResult?.startDate || ''}" onchange="warriorUpdateReplayEstimate()">
      <input type="date" id="warrior-replay-end-date" class="settings-input" style="max-width:160px;" value="${_lastRangeScanResult?.endDate || ''}" onchange="warriorUpdateReplayEstimate()">
      <input type="text" id="warrior-replay-symbols" class="settings-input" placeholder="AAPL, TSLA" value="${(_lastReplayResult?.symbols || _lastRangeScanResult?.symbols)?.join(', ') || ''}" oninput="warriorUpdateReplayEstimate()">
    </div>
    <div class="settings-row">
      <button class="btn btn-primary btn-sm" onclick="warriorRunReplay()" ${runDisabled ? 'disabled' : ''}>${runLabel}</button>
      <span id="warrior-replay-estimate" class="settings-hint"></span>
    </div>
    <div class="settings-row">${summaryLine}</div>
    ${body}
  </div>`;
}

function renderTab() {
  const replayPanel = renderReplayPanel();
  if (!_lastScanResults) {
    return `<div class="tab-header">
      <h1 class="tab-title">WARRIOR</h1>
    </div>
    <div class="empty-state">
      <div class="empty-icon">🥋</div>
      <p>No scan yet — tap ↻ Refresh to run one.</p>
    </div>
    ${replayPanel}`;
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
  ${nearMiss.length ? nearMiss.map(_renderCandidateCard).join('') : '<div class="empty-state"><p>No near-miss candidates this scan.</p></div>'}
  ${replayPanel}`;
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
  // Warrior wires its own dev-panel handler here, as a plain global —
  // the exact same connection mechanism every onclick in this app already
  // uses, not a registry exception. Shell/app.js never references this
  // name; only the HTML this file itself renders does.
  if (typeof window !== 'undefined') {
    window.warriorRunReplay = _runReplayFromUI;
    window.warriorCancelRangeScan = _cancelRangeScanFromUI;
    window.warriorUpdateReplayEstimate = _updateReplayEstimateDisplay;
    window.warriorToggleScanCell = _toggleScanCellFromUI;
  }
  _startScanInterval();
}

// Not called by app.js today (nothing tears Warrior down at runtime yet),
// but exported so a future engine-reload path and this module's own tests
// have a clean way to stop the interval without leaking it.
export function unregister() {
  _stopScanInterval();
}
