-- Phase 9 §4.2 (2026-09-16): four fields to make entry measurable, at
-- n=150, in a way n=37 (now n=46) genuinely cannot support. None of the
-- four scores anything -- they exist purely so there is something to
-- analyse once the sample is large enough, the same posture §3.1's
-- offline dataset and §2.7's scheduler instrumentation already took.
--
-- - spread_at_buy: bid/ask width at the moment of purchase (dollars, not
--   a percentage) -- the direct measure of after-hours execution cost
--   §0.4 could previously only infer from outcome, never observe
--   directly. Null whenever a live quote wasn't available or came back
--   implausible (ask < bid, or either side <= 0) -- core/market-data.js's
--   own HOTFIX comment on getLivePrice already documents that this
--   account's snapshot bid/ask (latestQuote.bp/.ap) has come back
--   zero/garbage for thin after-hours tickers before; a wrong spread is
--   worse than a missing one, so confirmAddPortfolio nulls rather than
--   stores anything that fails a basic sanity check.
-- - minutes_from_open: signed integer, PT wall-clock minutes since the
--   6:30am PT / 9:30am ET regular open (the same tMin/390 reference
--   classifySession itself uses) -- negative before the open (pre-
--   market), 0 at the open, and > 390 once past the normal close (after-
--   hours). Does not special-case early-close days (EARLY_CLOSES,
--   core/clock.js) -- this is a clock-time measurement, not a session
--   classification; buy_session already carries that separately.
-- - bars_since_signal: minutes elapsed between the most recent screener
--   scan (state.lastScanTime) and the buy action, treating each minute
--   as one bar -- "how stale the signal was when acted on." Null for any
--   "Own Decision" buy with no signals-tab entry behind it at all (there
--   is no signal to be stale relative to).
-- - entry_vs_signal_price_pct: slippage from the signal's last-seen price
--   to the actual fill price, as a percentage -- currently invisible.
--   Null under the same no-signal condition as bars_since_signal.
--
-- Lives on BOTH portfolio and trades_v2, same reason engine_source does
-- (db/011): a position can sit open across a reload before it sells, and
-- trades_v2 is insert-only at sale time (db/002) -- carrying these
-- forward from the portfolio row at sale is the only way they survive
-- into the closed-trade record. Capturing only at sell time would work
-- for a same-session buy-then-sell and silently lose the data for
-- anything that outlives a reload in between, the exact intermittent-
-- defect shape db/011's own header already warned against for
-- engine_source.
--
-- All four nullable, no default, no CHECK constraint -- three-state by
-- construction (a real number, or null meaning "not measured this time,"
-- never a sentinel value standing in for either). None of the four
-- scores anything in calcUnifiedRecommendation or scoreStock, and
-- nothing in this migration should be read as a step toward that -- see
-- §4.3's explicit no-retuning decision.
--
-- No new grants needed for either table. portfolio has no RLS at all
-- (NOTE_portfolio_rls_not_applied.sql) -- anon already has full CRUD.
-- trades_v2's anon INSERT (db/002) is a plain, un-narrowed table-level
-- policy, unlike outcome_filler's deliberately column-scoped UPDATE
-- grants (db/019/021/022) -- a new nullable column is automatically
-- covered by an existing table-level INSERT the same way it would be by
-- table-level UPDATE, no separate grant statement required.
alter table portfolio add column if not exists spread_at_buy numeric;
alter table portfolio add column if not exists minutes_from_open numeric;
alter table portfolio add column if not exists bars_since_signal numeric;
alter table portfolio add column if not exists entry_vs_signal_price_pct numeric;

alter table trades_v2 add column if not exists spread_at_buy numeric;
alter table trades_v2 add column if not exists minutes_from_open numeric;
alter table trades_v2 add column if not exists bars_since_signal numeric;
alter table trades_v2 add column if not exists entry_vs_signal_price_pct numeric;

-- VERIFICATION PLAN (the standing acceptance test, restated so it isn't
-- skipped a fifth time -- see this file's own header in the calling
-- instruction: engine_source, universe_rank, request_count, and the
-- signal_snapshot trio each shipped once without a real round-trip check
-- and each turned out to have a real gap that only a re-select caught):
--   1. Apply this migration.
--   2. Add a REAL position to the portfolio through the app (not a
--      synthetic insert) -- ideally during AFTER_HOURS or PRE_MARKET so
--      §4.1's warning path is exercised in the same pass.
--   3. Re-select that row from `portfolio` via the anon key directly
--      (not through app state) and confirm all four columns are
--      populated (spread_at_buy may legitimately be null if no valid
--      quote was available -- confirm THAT reads as null, not 0 or a
--      garbage number, by checking the raw quote separately).
--   4. Mark it sold; re-select the resulting `trades_v2` row and confirm
--      the same four values carried forward unchanged from the
--      portfolio row (not recomputed at sale time -- these describe the
--      BUY, not the sale).
