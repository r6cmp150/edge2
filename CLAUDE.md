# Architecture invariants — Warrior engine (docs/warrior-engine-spec-v2.md Phase 0)

These are hard rules, not suggestions. Violating any of them breaks engine isolation.

- `core/` never imports from `engines/`.
- `engines/*` never import each other (EDGE never imports Warrior, Warrior never imports EDGE).
- `shell/` reaches engines only through `shell/registry.js` — never a direct import, never a stored module reference (not even a short-lived one kept after `register()` returns), never an `if (engineSource === ...)` branch. A stored reference is still a way around the registry even with no id-branching, and it's the difference between the boundary check being mechanical (grep for stray references) versus a judgement call.
- No file under `shell/` or `engines/edge/` may contain engine-specific setup names: `ABCD`, `Gap and Go`, `VWAP Momentum`, `Red-to-Green` (or `HOD Momentum`).
- Every Warrior bar/snapshot request passes `feed: 'sip'` explicitly. Never omit it and rely on the default (the default elsewhere in this codebase is `iex`).
- `engines/warrior/` loads as its own file via dynamic `import()`, never concatenated into `app.js`. A syntax error in Warrior code must not take down the app.
- Every call to an Alpaca list endpoint must either follow `next_page_token` to exhaustion, or carry a comment proving the requested window cannot exceed the limit. No third option. "The arithmetic looks fine" is not a proof — write the arithmetic down or paginate. (Four functions had this exact defect as of 2026-08-24 — `fetchMultiBars`/Bug 1, `fetchSingleBars`, `fetchMinuteBars`, `fetchHourlyBars` — found two days apart; it's a systemic gap, not unlucky functions.)
