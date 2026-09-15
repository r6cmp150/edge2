-- Phase 9 §1.2 -- widens the EXISTING outcome_filler role (created in
-- db/017) with UPDATE on trades_v2's five sell-timing columns. Does NOT
-- create a second role -- db/017's own header already anticipated this
-- exact file ("pass 2 ... will widen this SAME role"), and this follows
-- that plan rather than inventing a new one.
--
-- SCOPE: exactly the five columns writeSellTimingToSupabase used to write
-- against the old `trades` table (db/005's own enumeration), now against
-- trades_v2: sell_timing_resolved, best_exit_price, best_exit_date,
-- best_exit_timing, price_at_plus5_days. Nothing else -- outcome_filler
-- still cannot touch ticker, buy_price, pnl_dollars, or any other column
-- on a completed trade. Same column-narrowed-GRANT-plus-RLS-policy shape
-- as db/005 and db/017's own signal_log grant, for the same reason: RLS
-- controls which ROWS, not which COLUMNS, so the column list on the GRANT
-- is the only thing standing between "can resolve sell timing" and "can
-- rewrite any trade."
--
-- REVOKE BEFORE THE NARROWING GRANT, as in db/005: outcome_filler
-- currently has no UPDATE at all on trades_v2 (db/017 gave it SELECT
-- only), so this revoke is a no-op today -- it's here so this file stays
-- correct if that ever changes, and to match the established pattern
-- rather than silently depending on today's starting state.
revoke update on trades_v2 from outcome_filler;
grant update (
  sell_timing_resolved, best_exit_price, best_exit_date,
  best_exit_timing, price_at_plus5_days
) on trades_v2 to outcome_filler;

drop policy if exists "outcome filler update" on trades_v2;
create policy "outcome filler update" on trades_v2
  for update to outcome_filler using (true) with check (true);

-- VERIFICATION PLAN (run after this file, before dispatching
-- fill-outcomes.mjs --write against trades_v2):
--   check A: PATCH trades_v2.sell_timing_resolved on a real row (filtered
--     by id) via the outcome_filler JWT -- expect success, re-select via
--     the anon key confirms the write landed. This is CHECK E from
--     db/017's own verification plan, now flipped: that check proved
--     "SELECT yes, UPDATE no" on trades_v2; this one proves the widened
--     grant actually opened exactly the five columns it was meant to.
--   check B: PATCH trades_v2.buy_price (NOT in the widened grant) on the
--     same row via the outcome_filler JWT -- expect permission-denied,
--     re-select confirms unchanged. Sharpest version of the boundary this
--     grant creates: real UPDATE access on five columns, zero on every
--     other column, not just "this table" vs "that table."
--   Both checks use a REAL existing row id and re-select the result from
--   the database afterward -- never a status code alone. PostgREST
--   returns 200 with an empty body on an RLS-filtered update, which is
--   exactly how this class of bug has hidden four times already in this
--   project (phase-9-entry-exit-spec.md §6's own framing).
