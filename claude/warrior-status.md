# Warrior engine status

Quick-reference for picking this back up. Full detail lives in
`warrior-engine-spec-v2.md` (acceptance checklists per phase) and
`CLAUDE.md` (architecture invariants). This file is just "where are we
and what's outstanding," so a new session doesn't have to re-derive it
from git log.

## Current state

Phases 0 through 4 are merged to `main` (Phase 4 merged 2026-08-28, live-
checked against HVII 2026-08-24 first). Phase 3 (the 5 Pillars gate) still
has two live checks outstanding from its own merge — deliberately, not by
oversight. See below.

## Outstanding: Phase 3 live checks (regular session only)

Both require the market to actually be open — can't be checked outside
regular trading hours. Blocked on the user being at a computer during
market hours. Not touched by the Phase 4 work.

1. **`feed=sip` in the network log.** Every Warrior bar/snapshot request
   must carry it explicitly (CLAUDE.md rule). Untested against a live
   regular-session scan.
2. **Full scan stays under 30 requests**, measured with RVOL's 30-day-average
   and cumulative-minute-bar fetches actually running (they don't run
   outside regular session, so a scan checked while the market was closed
   doesn't count — that was tried 2026-08-26 and came in at ~6 requests,
   but with RVOL skipped entirely).

**Merge rationale:** a wrong `feed` produces a visible 403, not silent bad
data. Phase 2's isolation boundary was verified live under three failure
modes (missing module, syntax error, thrown error in the scan interval),
so a broken Warrior tab can't take down EDGE. Both risks are contained
even unverified.

**Reminder mechanism:** `engines/warrior/index.js`'s `_scanTick()` logs
`[PHASE-3-UNVERIFIED]` to the console on every regular-session scan, with
the actual per-stage request count (universe fetch vs. gate evaluation).
**Delete that logging block** (comment marks exactly where) **once both
checks are confirmed**, and check off the corresponding bullets in
`warrior-engine-spec-v2.md`'s Phase 3 acceptance section — they're
explicitly marked `**OUTSTANDING**` there, not just unchecked.

## Also not yet visually confirmed live (lower stakes, still open)

- QUALIFIED/NEAR MISS section headers show an "RVOL not evaluated this
  session" caveat outside the window where RVOL is checkable. Unit-tested
  (16 gate tests), fixed in response to a live-check finding, but not yet
  seen rendered in the browser.
- Pillar 3 `not-checked` specifically during PRE-market (verified during
  CLOSED, which is a different code path — same not-checked outcome,
  different reason string).

## Phase 4 (replay harness) — merged, confirmed live

`engines/warrior/replay.js`, gated behind Settings > Developer tools.
Fetch → replay bar-by-bar → score (forward return + MFE/MAE per horizon),
decoupled from live market hours. Two no-lookahead negative controls in
`tests/replay.test.js` (structural + anchoring — the anchoring one is
documented as a mitigation, not a guarantee: a classifier can still
*decide* to trigger early via a closure-based cheat, but the harness never
trusts its self-reported price/time for the record).

Live-checked 2026-08-27 against HVII 2026-08-24: 6 triggers/192 bars,
correct timing (no lookahead fingerprint), correct null-handling at the
window's edge (AMIX), correct zero-trigger result for thin trading (DAAQ).
Also did what it's for: HVII's MFE (~0.4%) against its MAE (-10.4%) and
close (-9.0%) exposed a bad entry invisible from live scanning alone.

**Real finding, carried into the Phase 5 spec, not fixed in Phase 4:**
edge-triggering recorded 6 triggers for one HOD break — a single price
oscillating across a threshold, not 6 separate events. Harmless for
Phase 4's disposable example classifier; would inflate Phase 8's
per-setup attribution for a real setup. Phase 5's spec section now has a
"Re-arm rule" requirement: price retracement from each setup's own
reference level (not a fixed time cooldown, which was considered and
rejected as primary — it'd discard a genuinely new breakout landing
inside the cooldown window). `rearmDistancePct` joins the existing
sweepable-threshold config; use the replay harness to calibrate it against
real history rather than picking a value by feel.

## Known, accepted (not scheduled) limitations

- Chart X-axis labels (`app.js:3503-3510`) render browser-local time, not
  PT — display-only inconsistency, not a wrong-answer bug.
- A countdown window spanning a US DST transition reads ~1h off in a
  timezone that doesn't observe DST on the US calendar (e.g. Tokyo).
  Documented and regression-tested (`tests/clock-timezone.test.js`), not
  worth fixing.

## Also fixed this session, unrelated to Warrior (EDGE-side)

Sold tab was localStorage-only per device — phone and computer showed
different trade histories (20 vs 2). Root cause: Supabase's `trades`
table only ever got a best-effort write-mirror, nothing read it back.
Fixed 2026-08-28 (`v2.9.6`): `loadSoldFromSupabase()` now syncs
`state.sold` from Supabase on boot, non-blocking with a local-cache
fallback (unlike Portfolio/Settings' hard-blocking load). Two confirmed
duplicate rows (a known $0-profit double-sell bug) and 7 stale rows were
cleaned out of Supabase directly as part of this fix — both devices now
show the same 20 real trades.

**Known residual risk, not yet fixed:** the sold-trade *write* path
(`writeTradeToSupabase`) is still fire-and-forget with no retry — the
same mechanism that produced the rows just cleaned up. A future sell
whose mirror write silently fails would reintroduce the same kind of
drift. Flagged to the user, not actioned yet.

## Next up

Phase 5 (setup detection) is next per the spec's phase checklist. Its
spec section now includes the re-arm rule requirement above — build it
into every setup definition from the start, not as a retrofit.
