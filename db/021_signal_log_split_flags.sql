-- Phase 9 follow-on (2026-09-15, found during §1.1's post-approval review):
-- fill-outcomes.mjs Pass 1 computes signal_log.ret_close/1d/3d/5d as
-- ret(reference_price, daily[anchorIdx+N].c) -- reference_price is a raw
-- live quote (getLivePrice), daily is fetched with adjustment='all'. Same
-- units mismatch as trades_v2's MSTU row (§1.1), no detectSplitInWindow
-- call. Pass 1 is being fixed (app-side, this commit) to check for a
-- split before computing any of these four columns; a one-time audit of
-- every already-filled row (scripts/audit-signal-log-splits.mjs) found
-- zero existing corruption as of 2026-09-15 -- nothing to backfill, but
-- the columns below are still needed so the fix has somewhere to write
-- "invalidated by a detected split" instead of a silent null.
--
-- THREE-STATE, NOT A NUMBER-OR-NULL COLLAPSE: ret_5d = NULL already means
-- two different things today with nothing to tell them apart -- "hasn't
-- been attempted yet" and (after this fix) "was attempted, a split was
-- detected in the window, and the value was refused." A forward test
-- that can't distinguish "not filled yet" from "filled and then
-- invalidated" draws the wrong conclusion from a thin sample the same way
-- a NOT_EVALUATED cell being silently treated as 0% would (phase-9-entry-
-- exit-spec.md §3.7's own rule, applied here one section early because
-- the same failure mode showed up before Section 3 existed). One boolean
-- per horizon, not one shared flag: a split landing between day 3 and
-- day 5 corrupts ret_5d while leaving ret_close/1d/3d clean, and a single
-- row-level flag would null good data alongside the bad.
--
-- ret_5m/15m/30m get NO corresponding column: they come from minute bars
-- fetched with no `adjustment` param (Alpaca's raw default), same-day
-- only, and cannot span a split boundary -- splits take effect between
-- sessions, never mid-session. Adding flags for columns that can't be
-- corrupted would be schema clutter posing as thoroughness.
alter table signal_log add column if not exists ret_close_split_in_window boolean not null default false;
alter table signal_log add column if not exists ret_1d_split_in_window boolean not null default false;
alter table signal_log add column if not exists ret_3d_split_in_window boolean not null default false;
alter table signal_log add column if not exists ret_5d_split_in_window boolean not null default false;

-- NO REVOKE FIRST, unlike db/019/db/005: this is not narrowing a broader
-- existing grant down to a column list -- outcome_filler's signal_log
-- UPDATE grant (db/017) was ALREADY column-scoped, never table-wide, so
-- there is nothing broad to revoke. Column-level GRANT is additive in
-- Postgres (confirmed against the Postgres GRANT reference before writing
-- this): this statement adds four columns to the existing privilege set
-- without touching the ones db/017 already granted (ret_5m..ret_5d,
-- outcomes_filled_at, taken_resolution, matched_trade_id all remain
-- exactly as they were). A revoke here would be actively wrong -- run
-- unqualified, `revoke update on signal_log from outcome_filler` strips
-- EVERY column, not just these four, breaking Pass 1/2's existing writes.
grant update (
  ret_close_split_in_window, ret_1d_split_in_window,
  ret_3d_split_in_window, ret_5d_split_in_window
) on signal_log to outcome_filler;

-- No new RLS policy needed: db/017's existing "outcome filler update"
-- policy on signal_log is `using (true) with check (true)` -- row-level,
-- already covers every row regardless of which columns a given UPDATE
-- touches. Column-level GRANT (above) is the only thing that needed
-- widening.

-- VERIFICATION PLAN (same shape as db/019's, scoped to the four new
-- columns):
--   check A: PATCH signal_log.ret_5d_split_in_window on a real row
--     (filtered by id) via the outcome_filler JWT -- expect success,
--     re-select via the anon key confirms the write landed.
--   check B: PATCH signal_log.reference_price (still NOT in any grant for
--     this role) on the same row -- expect permission-denied, unchanged
--     on re-select. Confirms the widening added exactly four columns and
--     nothing else.
--   Then: re-run scripts/audit-signal-log-splits.mjs --write once (after
--   this migration is applied) as a completeness check -- it should still
--   report zero corrupt rows (2026-09-15's dry run already established
--   that), confirming the --write path itself works end-to-end even
--   though there's nothing for it to correct today.
