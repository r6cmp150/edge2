-- Enable RLS on `trades` NOW, not at cutover -- closes the anon-DELETE
-- hole immediately (RLS off means default grants give anon full CRUD,
-- confirmed via the relrowsecurity sweep, 2026-09-04) without waiting
-- for trades_v2 to ship. Policies match exactly what app.js currently
-- does against this table (enumerated by call site, not assumed):
--
--   INSERT -- writeTradeToSupabase, app.js:4654
--   UPDATE -- writeSellTimingToSupabase, app.js:1239 (5 columns only --
--            sell_timing_resolved, best_exit_price, best_exit_date,
--            best_exit_timing, price_at_plus5_days)
--   SELECT -- loadSoldFromSupabase (5216) + report/export reads
--            (5579, 6480, 6816, 7205)
--   DELETE -- no call site anywhere. Blocked by absence.
--
-- THE UPDATE POLICY IS DELIBERATELY NARROWER THAN "UPDATE, matching
-- current usage" would naively suggest. Row-level security controls
-- which ROWS a statement can touch, not which COLUMNS -- a plain
-- `for update to anon using (true) with check (true)` would let anyone
-- holding the anon key rewrite sell_price, pnl_dollars, or any other
-- column on a completed trade, which is exactly the corruption risk this
-- whole investigation started from (the same reasoning that kept
-- trades_v2 at insert+select only). writeSellTimingToSupabase only ever
-- needs 5 columns, so the RLS policy is paired with a column-level GRANT
-- restricting anon's UPDATE privilege to exactly those 5 -- the
-- "narrowly scoped" mechanism, actually applied this time instead of
-- deferred.
--
-- SEQUENCING: this is the INTERIM state, live for as long as app.js
-- still writes to `trades` (i.e. until Phase 7 cutover to trades_v2).
-- At cutover, db/004 drops the update policy and revokes the column
-- grant -- RLS itself is already enabled by this file and does not need
-- to be touched again.
alter table trades enable row level security;

drop policy if exists "anon insert" on trades;
create policy "anon insert" on trades for insert to anon with check (true);

drop policy if exists "anon select" on trades;
create policy "anon select" on trades for select to anon using (true);

drop policy if exists "anon update sell timing" on trades;
create policy "anon update sell timing" on trades for update to anon
  using (true) with check (true);

revoke update on trades from anon;
grant update (
  sell_timing_resolved, best_exit_price, best_exit_date,
  best_exit_timing, price_at_plus5_days
) on trades to anon;

-- VERIFICATION PLAN (run after this file, before moving to the next
-- table): insert a disposable dummy row via the anon key, confirm it
-- reads back, attempt to update one of the 5 sell-timing columns
-- (expect success, confirmed by a follow-up select showing the new
-- value -- not just a 200 status, per the earlier signal_log lesson),
-- attempt to update sell_price on the SAME dummy row (expect the column-
-- level grant to reject it outright, a different failure mode than an
-- RLS-filtered no-op), attempt a delete (expect it blocked, confirmed by
-- a follow-up select showing the row still exists), then remove the
-- dummy row via the SQL editor (no delete policy exists to do it via the
-- anon key, matching the signal_log cleanup precedent).
