-- RUN 2026-09-05. Drops the permissive UPDATE surface on `trades` --
-- the "anon update sell timing" policy from 005, plus the column-level
-- grant that scoped it to the 5 sell-timing columns.
--
-- JUSTIFICATION CHANGED from every earlier draft of this file, worth
-- recording precisely: the original plan was to close this at the same
-- moment app.js stopped calling writeSellTimingToSupabase against
-- `trades` -- i.e. tied to the app repointing to trades_v2. That still
-- happened (the cutover commit disables writeSellTimingToSupabase
-- outright), but the REASON to close this now is simpler and stronger:
-- with that function disabled, this grant has ZERO legitimate callers
-- left, anywhere, permanently (its replacement is the deferred outcome-
-- filling job, which will get its own scoped credential, not this one).
-- A privilege with no remaining user is pure exposure and nothing else --
-- it goes now, not at some later "cutover moment," because there isn't
-- one left to wait for.
--
-- Historical `trades` data stays readable (no select policy touched).
drop policy if exists "anon update sell timing" on trades;
revoke update (
  sell_timing_resolved, best_exit_price, best_exit_date,
  best_exit_timing, price_at_plus5_days
) on trades from anon;

-- VERIFICATION (by re-selecting, not by status code):
--   1. Attempt an anon UPDATE of sell_timing_resolved on a real existing
--      `trades` row -- expect rejection naming the missing grant
--      (permission denied for table trades), not a filtered no-op.
--   2. Re-select that same row and confirm sell_timing_resolved is
--      unchanged from before the attempt.
--   3. Attempt an anon SELECT against `trades` -- expect it still works,
--      confirmed by real rows coming back.
