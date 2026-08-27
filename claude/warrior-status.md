# Warrior engine status

Quick-reference for picking this back up. Full detail lives in
`warrior-engine-spec-v2.md` (acceptance checklists per phase) and
`CLAUDE.md` (architecture invariants). This file is just "where are we
and what's outstanding," so a new session doesn't have to re-derive it
from git log.

## Current state

Phases 0 through 3 are merged to `main`. Phase 3 (the 5 Pillars gate) was
merged 2026-08-26 **with two live checks still outstanding** — deliberately,
not by oversight. See below.

## Outstanding: Phase 3 live checks (regular session only)

Both require the market to actually be open — can't be checked outside
regular trading hours. Blocked on the user being at a computer during
market hours.

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

## Also not yet visually confirmed live (lower stakes, same day's work)

- QUALIFIED/NEAR MISS section headers show an "RVOL not evaluated this
  session" caveat outside the window where RVOL is checkable. Unit-tested
  (16 gate tests), fixed in response to a live-check finding, but not yet
  seen rendered in the browser.
- Pillar 3 `not-checked` specifically during PRE-market (verified during
  CLOSED, which is a different code path — same not-checked outcome,
  different reason string).

## Known, accepted (not scheduled) limitations

- Chart X-axis labels (`app.js:3503-3510`) render browser-local time, not
  PT — display-only inconsistency, not a wrong-answer bug.
- A countdown window spanning a US DST transition reads ~1h off in a
  timezone that doesn't observe DST on the US calendar (e.g. Tokyo).
  Documented and regression-tested (`tests/clock-timezone.test.js`), not
  worth fixing.

## Next up

Phase 4 (replay harness) is next per the spec's phase checklist —
recommended before the Phase 5 setup detectors, so pattern detection has
been watched against real history before it's watching the live market.
