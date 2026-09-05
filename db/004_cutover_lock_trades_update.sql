-- DO NOT RUN THIS YET. (A real comment, not a substitute for real SQL --
-- see the revision note below for why that distinction matters here.)
--
-- CUTOVER: lock `trades` down to SELECT ONLY for anon -- no insert, no
-- update, no delete (delete has been blocked by absence since 005; no
-- delete policy has ever existed). Run this at the same moment app.js
-- stops writing to `trades` and starts writing to trades_v2. Not before.
--
-- REVISED 2026-09-05 (third revision, and the one that mattered): the
-- previous version of this file had its two DDL statements COMMENTED
-- OUT -- the entire file was comments, no executable SQL. Running it
-- would report "Success. No rows returned" and change nothing: a false
-- confirmation that the lock had landed while `trades` stayed fully
-- writable. That's a worse defect than the two it was also carrying,
-- both caught in the same review:
--   (a) it only ever planned to drop UPDATE. The "anon insert" policy
--       005 created was never touched -- INSERT would have stayed open
--       on `trades` forever after cutover, which is the exact silent-
--       divergence risk this file exists to close.
--   (b) its own closing line claimed "nothing writes to it going
--       forward" -- a stronger state than insert+select-only (all the
--       two statements would have produced even if they HAD been real)
--       actually provides.
-- All three are fixed below: real, uncommented SQL; INSERT dropped
-- alongside UPDATE; and the target end state stated above is exactly
-- what these statements produce, not a stronger claim than that.
--
-- SEQUENCING, unchanged from every prior revision: run this only once
-- app.js has stopped calling writeTradeToSupabase and
-- writeSellTimingToSupabase against `trades` (the trades_v2 repoint
-- commit disables writeSellTimingToSupabase outright rather than
-- repointing it -- see that commit for why). Locking INSERT or UPDATE
-- while the app still calls either would make the write fail silently --
-- PostgREST returns 200 with an empty body on an RLS-filtered write --
-- with nothing anywhere to explain why.
drop policy if exists "anon insert" on trades;
revoke insert on trades from anon;

drop policy if exists "anon update sell timing" on trades;
revoke update (
  sell_timing_resolved, best_exit_price, best_exit_date,
  best_exit_timing, price_at_plus5_days
) on trades from anon;

-- Revoking the underlying grant as well as dropping the policy is 005's
-- own precedent, not new caution invented here: with RLS on and no
-- policy, the operation is already blocked, but revoking the grant turns
-- the refusal into a named permission error ("permission denied for
-- table trades") instead of a bare RLS policy violation -- the same
-- distinction 005's own verification demonstrated live (2026-09-04:
-- attempting to update sell_price under the narrowed column grant
-- returned 401 naming the missing GRANT, not a filtered no-op). Defense
-- in depth, and it costs nothing here.
--
-- VERIFICATION PLAN (same shape as 005/006/007 -- verified by doing,
-- not by status code, and not by "Success. No rows returned" either):
--   1. Attempt an anon INSERT into `trades` -- expect rejection naming
--      the missing grant, not a filtered no-op.
--   2. Attempt an anon UPDATE of one of the 5 sell-timing columns on an
--      existing row -- expect the same named-grant rejection, confirmed
--      via a follow-up SELECT showing the row unchanged.
--   3. Attempt an anon SELECT against `trades` -- expect it still works,
--      confirmed by real rows coming back.
--   4. Attempt an anon DELETE -- expect it blocked (already true since
--      005; re-confirmed here so the end state is fully verified in one
--      pass, not assumed carried over).
