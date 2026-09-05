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
// getUniverse/renderWarriorTab/getRequestStats/diffRequestStats/
// getAvailableBudget as ordinary globals. That's expected, not a boundary
// leak: the rule this phase enforces is "nothing outside this file reaches
// INTO Warrior code except through the registry," not "Warrior code can't
// read the app's shared globals or call its shared utilities" — Phase 2
// already established calling showGlobalErrorToast this way, Phase 3 did
// the same for renderWarriorTab and (below) core/api-client.js's shared
// request-stats tally (getRequestStats/diffRequestStats, 2026-08-30 —
// replaces the retired core/universe.js:_countRequests, which all three
// of this function's fetch stages used to call), and Phase 5 does it
// again for app.js's getAvailableBudget (position-sizing's budget cap
// reuses EDGE's own budget-bar formula rather than computing a second,
// parallel notion of "available").
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
// Carried forward across scans that had zero pillar12Survivors (float is
// never fetched then, so evaluateGateBatch reports null that scan) --
// without this, the coverage line's table-age display would blink to
// "unknown" on any all-fail-early scan even though the table itself
// hasn't changed. Only updated when a scan actually reports a real value.
let _lastKnownFloatTableBuiltAt = null;
let _lastKnownFloatTableStalenessDays = null;

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

    // Snapshot-diffed via the shared request-stats tally (core/api-client.js,
    // 2026-08-30), not counted unconditionally, not just when logging below:
    // negligible overhead (two object-spread snapshots per call), and
    // keeping it unconditional means the logging line below can be deleted
    // on its own later without restoring two different call shapes for
    // getUniverse/evaluateGateBatch. Snapshotting the GLOBAL tally, not
    // engine-scoped ('WARRIOR') — alpacaGet still hardcodes engine='EDGE'
    // for every request regardless of caller (a stale Phase 0.5 assumption,
    // not yet fixed), so a 'WARRIOR'-scoped read would silently show zero
    // here rather than actually isolating Warrior's own traffic.
    const beforeUniverse = getRequestStats();
    const universe = await getUniverse({ session, strategy });
    const universeRequestsObserved = diffRequestStats(beforeUniverse, getRequestStats()).issued;

    const beforeGate = getRequestStats();
    const gateResult = await evaluateGateBatch(universe, session);
    const gateRequestsObserved = diffRequestStats(beforeGate, getRequestStats()).issued;
    const { results, rvolCheckable, floatTableBuiltAt, floatTableStalenessDays } = gateResult;

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
    const beforeSetups = getRequestStats();
    const setupsResult = await evaluateSetupsBatch(qualified, session, { now: new Date(), riskPerTradeDollars, availableBudget });
    const setupsRequestsObserved = diffRequestStats(beforeSetups, getRequestStats()).issued;
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
    // the three snapshot-diffed calls above to plain, unwrapped ones)
    // once both are confirmed live.
    if (session === 'OPEN') {
      const total = universeRequestsObserved + gateRequestsObserved + setupsRequestsObserved;
      console.log(`[PHASE-3-UNVERIFIED] regular-session scan — universe: ${universeRequestsObserved} req observed, gate: ${gateRequestsObserved} req observed, setups: ${setupsRequestsObserved} req observed, total: ${total} req (acceptance: <30 for a 50-symbol universe). Also confirm feed=sip in the network log for this scan's requests.`);
    }

    if (floatTableBuiltAt != null) {
      _lastKnownFloatTableBuiltAt = floatTableBuiltAt;
      _lastKnownFloatTableStalenessDays = floatTableStalenessDays;
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
  // fetch-failed (2026-09-04): checked as its own branch, ahead of the
  // not-checked one below — same reason field, but must never render with
  // not-checked's neutral wording ("not checked" reads as a deliberate
  // choice; a fetch failure is not one). See gate.js's classifyGate
  // comment for the full fetch-failed vs not-checked distinction.
  // rvol-premarket (2026-09-04): checked BEFORE the generic not-checked
  // fallback below, even though its status is ALWAYS 'not-checked' by
  // design (see gate.js's evaluatePillarPreMarketRvol — it never gates,
  // on purpose, since there's no validated threshold). Status alone can't
  // distinguish "structurally skipped" from "genuinely measured, just not
  // gating" — the real ratio must still reach the card, or this pillar is
  // functionally invisible despite being the whole point of building it.
  if (pillar.id === 'rvol-premarket' && typeof pillar.value === 'number') {
    const today = pillar.todayPreMarketVolume != null ? Math.round(pillar.todayPreMarketVolume).toLocaleString() : '—';
    const avg = pillar.avgPreMarketVolume != null ? Math.round(pillar.avgPreMarketVolume).toLocaleString() : '—';
    const days = pillar.daysInAverage != null ? pillar.daysInAverage : '?';
    return `${pillar.value.toFixed(2)}× — unvalidated threshold (today ${today}, ${days}-day avg ${avg})`;
  }
  if (pillar.status === 'fetch-failed') return pillar.reason || 'could not be measured';
  if (pillar.status === 'not-checked') return pillar.reason || 'not checked';
  if (pillar.id === 'rvol' && typeof pillar.value === 'number') {
    const expected = pillar.expectedByNow != null ? Math.round(pillar.expectedByNow).toLocaleString() : '—';
    const actual = pillar.todayVolume != null ? Math.round(pillar.todayVolume).toLocaleString() : '—';
    return `${pillar.value.toFixed(2)}× (expected by now ${expected}, actual ${actual})`;
  }
  // float (revised 2026-09-03): value is now EntityPublicFloat's dollar
  // figure divided by the historical close on ITS OWN reference date --
  // an ESTIMATED free-tradable share count, not a filed share count, so
  // labeled "implied float" and rounded for display. asOfDate carries that
  // reference date (the price-measurement date, not a filing date) and
  // stalenessDays is days since THAT date -- spec's own explicit
  // requirement to show the value's date/staleness alongside it, same as
  // every other pillar carries its own provenance.
  //
  // dilutionCorrected disclosure (2026-09-04, explicit requirement — "state
  // the residual bias on the card, not just know it"): the correction
  // rescales the reference-date derivation for share issuance since then,
  // assuming the FREE-TRADING FRACTION held constant -- newly issued
  // shares are often restricted at issuance and become free-trading later,
  // so even a corrected value can still UNDERSTATE today's true float
  // (the dangerous direction — a false pass). An UNCORRECTED value (no
  // shares-outstanding history existed to correct with, ~16% of usable
  // entries, confirmed for real established filers like GPRO) carries that
  // same risk with no correction attempt at all. Both are disclosed
  // distinctly rather than the card reading as unqualified certainty.
  if (pillar.id === 'float' && typeof pillar.value === 'number') {
    const shares = Math.round(pillar.value).toLocaleString();
    const asOf = pillar.asOfDate ? `ref. ${pillar.asOfDate}` : 'reference date unknown';
    const staleness = pillar.stalenessDays != null ? ` (${pillar.stalenessDays}d old)` : '';
    const correctionNote = pillar.dilutionCorrected
      ? ' — dilution-adj., assumes constant free-float %'
      : ' — NOT dilution-adjusted (no shares data)';
    return `~${shares} implied float shares${correctionNote} — ${asOf}${staleness}`;
  }
  if (pillar.id === 'change' && typeof pillar.value === 'number') return `${pillar.value.toFixed(1)}%`;
  if (pillar.id === 'price' && typeof pillar.value === 'number') return `$${pillar.value.toFixed(2)}`;
  return pillar.value == null ? '—' : String(pillar.value);
}

// fetch-failed gets its own icon/class (2026-09-04) — before this, it fell
// through to the same '—'/wp-notchecked treatment as a genuine not-checked,
// which is exactly the misleading-display problem this whole pass exists
// to close: a card reading "RVOL not checked" that actually means "we
// tried and the fetch failed" looks identical to a deliberate skip. '?' /
// wp-fetchfailed reads as "unknown," not "fine to ignore."
// 'rvol' and 'rvol-premarket' are DISTINCT metrics (2026-09-04, explicit
// requirement — never the same number in the same slot) but
// .warrior-pillar-label is a fixed 48px column sized for short ids
// ("price", "change", "rvol"...) — "rvol-premarket" would overflow it and
// "RVOL (pre-market)" doubly so. RVOL-SES/RVOL-PM keep both short enough
// to fit while staying visually distinguishable from each other; the full
// "pre-market, unvalidated threshold" context lives in the value text
// instead, which has the room for it.
const _PILLAR_LABELS = { rvol: 'RVOL-SES', 'rvol-premarket': 'RVOL-PM' };
function _renderPillarRow(pillar) {
  const icon = pillar.status === 'pass' ? '✓' : pillar.status === 'fail' ? '✗' : pillar.status === 'fetch-failed' ? '?' : '—';
  const cls = pillar.status === 'pass' ? 'wp-pass' : pillar.status === 'fail' ? 'wp-fail' : pillar.status === 'fetch-failed' ? 'wp-fetchfailed' : 'wp-notchecked';
  return `<div class="warrior-pillar-row ${cls}">
    <span class="warrior-pillar-icon">${icon}</span>
    <span class="warrior-pillar-label">${_PILLAR_LABELS[pillar.id] || pillar.id}</span>
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

// Last pre-flight estimate this display computed, module-scoped alongside
// _lastRangeScanResult/_lastReplayResult (below) so _publishReplayDebugHook
// can expose the NUMBER a harness/test can assert against, instead of
// parsing it back out of the '≈N request(s)...' text the element renders
// for a human. Cleared (null) whenever the display itself goes blank/
// blocked, so a stale number from a previous, different form state can
// never be read as if it applied to the current one.
let _lastEstimatedRequests = null;

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
    _lastEstimatedRequests = null;
    return;
  }
  const setupIds = _setupIdsForClassifierId(classifierId);
  const tradingDays = _tradingDaysBetween(dateStr, endDateStr);
  if (tradingDays.length > RANGE_SCAN_HARD_CEILING_DAYS) {
    el.textContent = `${tradingDays.length} trading days exceeds the ${RANGE_SCAN_HARD_CEILING_DAYS}-day ceiling — narrow the range.`;
    el.className = 'settings-hint warrior-estimate-blocked';
    _lastEstimatedRequests = null;
    return;
  }
  const requests = estimateRangeScanRequests(setupIds, symbols.length, tradingDays.length);
  const needsConfirm = tradingDays.length > RANGE_SCAN_CONFIRM_DAYS_THRESHOLD || requests > RANGE_SCAN_CONFIRM_REQUESTS_THRESHOLD;
  el.textContent = `≈${requests} request(s) across ${tradingDays.length} trading day(s)${needsConfirm ? ' — will require confirmation' : ''}`;
  el.className = 'settings-hint';
  _lastEstimatedRequests = requests;
  // This is a direct DOM update, not a renderWarriorTab() re-render (see
  // above), so it's the only place that touches _lastEstimatedRequests
  // that would otherwise re-publish window.__warriorReplayDebug — without
  // this call the debug hook would keep showing whatever estimate (or
  // null) was live the last time a full render happened, not the one this
  // function just computed.
  _publishReplayDebugHook();
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
    // classifierId stored explicitly (2026-08-31) — setupIds alone (the
    // EXPANDED array: all 5 for 'all-setups', one for a specific id)
    // can't tell the dropdown which option was actually selected, which
    // left it always falling back to the first option ('example') after
    // any range scan. Not cosmetic: it already caused a real
    // misreading of a run's own results in this project.
    _lastRangeScanResult = { classifierId, setupIds, symbols, startDate, endDate, ...result };
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

// Test-harness hook — NOT used by any production code path. Published on
// every renderReplayPanel() call (i.e. every render tick this panel is
// visible), gated the same developerTools-only way as the panel itself,
// so a Playwright harness can read the exact structured result objects
// instead of re-deriving them by parsing rendered HTML — the DOM already
// has to stay in sync with these for the panel to render correctly, so
// exposing the same objects directly is strictly less fragile than
// scraping table cells/title attributes back out of the markup.
function _publishReplayDebugHook() {
  if (typeof window === 'undefined') return;
  window.__warriorReplayDebug = {
    lastReplayResult: _lastReplayResult,
    lastRangeScanResult: _lastRangeScanResult,
    rangeScanInFlight: _rangeScanInFlight,
    rangeScanProgress: _rangeScanProgress,
    rangeScanConfirmPending: _rangeScanConfirmPending,
    replayInFlight: _replayInFlight,
    lastEstimatedRequests: _lastEstimatedRequests,
  };
}

function renderReplayPanel() {
  if (!(typeof state !== 'undefined' && state.settings && state.settings.developerTools)) return '';
  _publishReplayDebugHook();

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

  // Reads BOTH result types (2026-08-31 fix) — checking only
  // _lastReplayResult meant the dropdown always fell back to showing
  // "Example (Phase 4 placeholder)" selected after any completed range
  // scan, regardless of which real setup(s) actually ran. Not cosmetic:
  // a control that shows the wrong classifier is a UI that lies about
  // what it did, and it already caused a real misreading of a run's
  // results in this project.
  const lastUsedClassifierId = _lastRangeScanResult?.classifierId ?? _lastReplayResult?.classifierId;
  const classifierOptions = REPLAY_CLASSIFIER_OPTIONS.map(o =>
    `<option value="${o.id}" ${(lastUsedClassifierId === o.id) ? 'selected' : ''}>${o.label}</option>`
  ).join('');

  const runDisabled = _replayInFlight || _rangeScanInFlight;
  const runLabel = _replayInFlight ? 'Running…' : _rangeScanInFlight ? 'Scanning…' : _rangeScanConfirmPending ? 'Confirm: Run Anyway' : 'Run Replay';
  const summaryLine = _lastRangeScanResult
    ? `<span class="settings-hint">${_lastRangeScanResult.requests} request(s) for ${_lastRangeScanResult.startDate} → ${_lastRangeScanResult.endDate}</span>`
    : _lastReplayResult
      ? `<span class="settings-hint">${_lastReplayResult.requests} request(s) for ${_lastReplayResult.dateStr} (${REPLAY_CLASSIFIER_OPTIONS.find(o => o.id === _lastReplayResult.classifierId)?.label || _lastReplayResult.classifierId})</span>`
      : '';

  return `<div class="settings-section mt12" id="warrior-replay-panel">
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

// 2026-09-04: the 18-month backtest found no edge, but the universe
// reconstruction it depends on (/v2/assets only returns today's listed
// symbols — no point-in-time query) was the weakest link in that test.
// Forward-testing against live data is a legitimate next step, not a
// disregard of the backtest result. Same tone as the EDGE scan's
// dropped-count suffix (.tab-subtitle, muted, not a warning banner) — an
// honest line, not an alarm. Shown on every render of the tab, including
// before a first scan has ever run.
const _PHASE5_UNVALIDATED_LINE = `<div class="tab-subtitle">Phase 5 — unvalidated. Backtest over Jun 2025–Aug 2026 found no edge; this is a live forward test, not a confirmed strategy.</div>`;

// Float coverage ceiling (2026-09-03, corrected 2026-09-04) — same
// salience treatment as the Phase 5 line above (.tab-subtitle, shown on
// every render, not buried in a pillar row) and for the same reason: a
// not-checked rate this high on one pillar is a fact about the
// free-filing-data ceiling, not something Roman should have to notice
// from a pattern of individual cards before trusting it isn't a bug.
//
// POPULATION-CORRECTED (2026-09-04): the original ~58%/42% figure was
// measured against the WHOLE instrument-eligible universe (~5,700
// symbols, everything tradable on NASDAQ/NYSE/AMEX) — not what the live
// gate's float check actually runs against, which is scoped to
// price+change survivors (small, moving, $1-$20 names). Recomputed
// against the 340 backtest gate-QUALIFIED symbols instead (the best
// available proxy for "reaches the float check" — the live captured
// movers-snapshot log is still too sparse, a handful of captures from one
// morning, to use yet), with core/edgar.js's ACTUAL production matching
// method (nearest filing preceding today, not nearest-by-date). Without a
// staleness bound this read 60.9% usable — but that measurement never
// applied one, and a real boot check found WHY that matters: BIAF and GRI
// both PASSED the <10M gate on 431-day-old filings.
//
// STALENESS BOUND: added, then dropped, same day (2026-09-04). A hard
// 180-day bound (the backtest's own primary analysis uses the same figure)
// collapsed usable to 4/340 (1.2%) — EntityPublicFloat is annual-only and
// 74% of filings share one reference date (2025-06-30), so a 180-day bound
// only has real coverage roughly half the year. That number was the
// symptom of the wrong fix: BIAF/GRI weren't wrong because they were old,
// they were wrong because the derivation never accounted for share
// issuance since the reference date. core/edgar.js's dilution correction
// (below) fixes that directly using EDGAR's own dated shares-outstanding
// history — confirmed BIAF's corrected value now correctly FAILS the gate
// and GRI's now genuinely passes a live volume-consistency check. Bound
// dropped once re-measurement confirmed the correction does the job the
// bound was only proxying for (see core/float-table.js's header for the
// full trace). FINAL, corrected, bound-free number: 178/340 usable
// (52.4%), 118/340 no filing (34.7%), 43/340 unresolvable — guard-
// discarded or no price data (12.6%). Higher discard rate than the
// uncorrected measurement (38 vs. 10) is real, not a regression: Ross-
// eligible low-float microcaps are exactly the population most prone to
// splits/dilution the old, uncorrected derivation was blind to.
const FLOAT_TABLE_STALE_WARNING_DAYS = 14;

// Function, not a const, as of 2026-09-04 (static-table architecture) --
// needs the CURRENT table's builtAt/staleness, which only exists after a
// scan has actually run one. _lastKnownFloatTableBuiltAt/StalenessDays
// carry forward across scans that had zero pillar12Survivors (see their
// own declaration comment above) so this doesn't blink to "unknown" on an
// all-fail-early scan.
//
// The staleness warning is DELIBERATELY separate markup from the base
// coverage line, not appended text within it (2026-09-04, explicit ask):
// "a visible warning... not a silent aging artifact." If the weekly
// GitHub Action ever breaks, the committed table just sits there and
// keeps serving -- a stale table looks exactly like a fresh one unless
// something says otherwise. .stale-table-warning (styles.css) gets the
// same yellow/bold salience as the update-available banner, not the muted
// .tab-subtitle treatment the rest of this disclosure uses.
function _renderPhase6FloatCoverageBlock() {
  const baseLine = `<div class="tab-subtitle">Float check covers ~52% of gate-qualified candidates (backtest-measured, dilution-corrected) — ~35% have no EDGAR float filing, ~13% more unresolvable (guard-discarded or no price data); not-checked, not a fail.</div>`;
  // Clustering-norm note (2026-09-04, explicit ask): most EntityPublicFloat
  // filings reference the same date (2025-06-30 currently, ~74% of them) --
  // an annual disclosure, not a per-symbol red flag. Without this, a large
  // "Nd old" figure on every single card reads as alarming for a
  // structural reason that has nothing to do with that stock specifically.
  const clusteringNote = `<div class="tab-subtitle">Most float filings reference the same date (annual disclosure) — a large age shown on a card is the norm here, not a red flag on that stock.</div>`;
  if (_lastKnownFloatTableBuiltAt == null) return baseLine + clusteringNote;
  const builtAtDateStr = _lastKnownFloatTableBuiltAt.slice(0, 10);
  const ageLine = `<div class="tab-subtitle">Float table built ${builtAtDateStr} (${_lastKnownFloatTableStalenessDays}d ago).</div>`;
  const staleWarning = (_lastKnownFloatTableStalenessDays != null && _lastKnownFloatTableStalenessDays > FLOAT_TABLE_STALE_WARNING_DAYS)
    ? `<div class="stale-table-warning">⚠ Float table is ${_lastKnownFloatTableStalenessDays} days old (expected weekly) — the weekly build job may have stopped running. Float pass/fail values below may be outdated.</div>`
    : '';
  return baseLine + clusteringNote + ageLine + staleWarning;
}

function renderTab() {
  const replayPanel = renderReplayPanel();
  if (!_lastScanResults) {
    return `<div class="tab-header">
      <h1 class="tab-title">WARRIOR</h1>
    </div>
    ${_PHASE5_UNVALIDATED_LINE}
    ${_renderPhase6FloatCoverageBlock()}
    <div class="empty-state">
      <div class="empty-icon">🥋</div>
      <p>No scan yet — tap ↻ Refresh to run one.</p>
    </div>
    ${replayPanel}`;
  }
  const { session, results, scannedAt, rvolCheckable } = _lastScanResults;
  const qualified = results.filter(r => r.tier === 'QUALIFIED');
  const nearMiss = results.filter(r => r.tier === 'NEAR_MISS');
  // BLOCKED (2026-09-04): a candidate that cleared price+change but had a
  // REQUEST failure on RVOL or news — not a real pass, not a real fail,
  // not the same as a structural not-checked. Shown as its own section,
  // muted rather than alarming (see _renderCandidateCard — the pillar rows
  // already carry the honest "could not be measured" wording and yellow
  // styling; this section just says "here's who that affected"). See
  // gate.js's classifyGate for the full fetch-failed-blocks-qualification
  // rationale: a stock we couldn't measure is not a stock that passed.
  const blocked = results.filter(r => r.tier === 'BLOCKED');
  // RVOL is the most selective of the 5 pillars — a section header that
  // just says "QUALIFIED (10)" outside regular session (or in the first 15
  // minutes) claims more confidence than the pillars underneath it earned:
  // those candidates cleared price+change+news, never RVOL, since RVOL was
  // structurally not-checked, not passed. Same "say what you don't know"
  // principle already applied to individual pillar rows, one level up. See
  // gate.js's evaluateGateBatch/classifyGate comments for why this isn't a
  // classification change — the tiers themselves are still correct.
  // Salience fix (2026-09-04): the caveat text used to be plain string
  // concatenation into .section-label — same bold/uppercase/letter-spaced
  // treatment as "QUALIFIED (12)" itself, so nothing told the eye this
  // trailing clause was a lower-confidence qualifier rather than more of
  // the same headline. .section-label-caveat below overrides weight/case/
  // tracking (not color — the label is already --muted end to end) so it
  // reads as an aside under a fast pre-open skim, not shouted prose.
  // Keeps the pillar name (RVOL specifically), not a generic "3 of 4" —
  // the caveat was never missing information, only visual separation.
  const rvolCaveat = rvolCheckable ? '' : ' <span class="section-label-caveat">— RVOL not evaluated this session</span>';
  // Condition, not a bug (2026-09-04, explicit ask): pre-open qualification
  // runs on 3 pillars (price, change, news) -- RVOL-PM is measured (see the
  // card rows below) but deliberately never gates (evaluatePillarPreMarketRvol
  // has no validated threshold to gate on yet). Stated plainly here, not just
  // implied by the rvolCaveat above, so reviewing the forward test in 30
  // trades or 60 days doesn't require reconstructing what was actually being
  // tested from the code -- it's on the screen every session it was true.
  const preOpenConditionLine = session === 'PRE'
    ? `<div class="tab-subtitle">Pre-open gate: 3 pillars (price, change, news) — RVOL-PM is measured, not yet gating.</div>`
    : '';
  // Outage-burial fix (2026-09-03, explicit rule): a quiet market and a
  // broken data source must not look alike on a fast skim. When QUALIFIED
  // is empty AND blocked is non-empty, the reason a data source failed
  // this scan is surfaced HERE, at the very top of the QUALIFIED section —
  // not after two separate "nothing here" empty-states (QUALIFIED's own,
  // then NEAR MISS's) that would otherwise read as an unremarkably quiet
  // morning before COULD NOT VERIFY finally explained why. Replaces
  // (rather than joins) the plain "No qualified candidates" line in this
  // case — that line would be actively misleading once a real fetch
  // failure is in play.
  const outageNotice = (qualified.length === 0 && blocked.length > 0)
    ? `<div class="empty-state outage-notice">
      <div class="empty-icon">⚠️</div>
      <p><strong>${blocked.length} candidate${blocked.length === 1 ? '' : 's'} could not be verified this scan</strong> — a data source (RVOL, news, or float) failed to respond, not a quiet market. See COULD NOT VERIFY below.</p>
    </div>`
    : '';
  return `<div class="tab-header">
    <h1 class="tab-title">WARRIOR</h1>
  </div>
  ${_PHASE5_UNVALIDATED_LINE}
  ${_renderPhase6FloatCoverageBlock()}
  <div class="tab-subtitle">Session: ${session} · ${results.length} scanned · last scan ${_formatPTTime(scannedAt)} PT</div>
  ${preOpenConditionLine}
  <div class="section-label">QUALIFIED (${qualified.length})${rvolCaveat}</div>
  ${outageNotice}
  ${qualified.length ? qualified.map(_renderCandidateCard).join('') : (outageNotice ? '' : '<div class="empty-state"><p>No qualified candidates this scan.</p></div>')}
  <div class="section-label mt12">NEAR MISS (${nearMiss.length})${rvolCaveat}</div>
  ${nearMiss.length ? nearMiss.map(_renderCandidateCard).join('') : '<div class="empty-state"><p>No near-miss candidates this scan.</p></div>'}
  ${blocked.length ? `<div class="section-label mt12">COULD NOT VERIFY (${blocked.length})</div>${blocked.map(_renderCandidateCard).join('')}` : ''}
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
    // Test-only escape hatch: the replay panel's own <input> values are
    // re-derived from _lastReplayResult/_lastRangeScanResult on every
    // render, including the automatic WARRIOR_SCAN_INTERVAL_MS tick's
    // renderWarriorTab() call (fires whenever state.activeTab === 'warrior',
    // regardless of what the replay panel is doing) — a real, if narrow,
    // race between a harness filling those inputs and that tick firing
    // mid-fill, which would silently blank them back to '' before Run gets
    // clicked. No production caller has ever needed to stop this interval;
    // exposing the existing _stopScanInterval lets a Playwright harness
    // eliminate the race deterministically instead of outrunning it by luck.
    window.warriorStopScanInterval = _stopScanInterval;
  }
  _startScanInterval();
}

// Not called by app.js today (nothing tears Warrior down at runtime yet),
// but exported so a future engine-reload path and this module's own tests
// have a clean way to stop the interval without leaking it.
export function unregister() {
  _stopScanInterval();
}
