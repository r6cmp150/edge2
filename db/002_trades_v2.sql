-- trades_v2: the redesigned closed-trade record, Phase 7.
--
-- LIFECYCLE (resolved 2026-09-04, after investigating two things the
-- original proposal got wrong or left unchecked):
--
-- 1. confirmAddPortfolio does NOT write to trades. It writes to the
--    SEPARATE `portfolio` table via savePositionToSupabase (upsert on
--    position_id) -- core/store.js:219-223. Open positions live in
--    `portfolio` only. My earlier statement that confirmAddPortfolio
--    needed INSERT on trades_v2 was wrong; there is no portfolio-to-
--    trades write path to reconcile with insert-only RLS.
-- 2. trades DOES currently have a real UPDATE-after-insert pathway:
--    writeSellTimingToSupabase (app.js:1230), fired lazily when the
--    Sold tab opens, days after the sale, once next-day/+5-day bars are
--    available. It updates exactly five columns -- sell_timing_resolved,
--    best_exit_price, best_exit_date, best_exit_timing,
--    price_at_plus5_days -- matched by id (or a ticker+buy_date+sell_date
--    fallback for pre-migration rows) -- and it runs under the anon key,
--    client-side, TODAY, IN PRODUCTION. That means `trades` currently has
--    a permissive anon UPDATE policy live right now: anyone holding the
--    public anon key (which is in the client -- anyone who loads the
--    site) can rewrite a completed trade record today. Real hole, predates
--    this phase, on the table that records Roman's actual money.
--
-- These five columns are the same SHAPE of thing as signal_log's ret_5m/
-- ret_1d/etc: a value only knowable once enough time has passed after the
-- event, filled in later by re-checking market data. signal_log resolved
-- that shape by refusing anon UPDATE entirely and deferring the fill to a
-- server-side job with its own narrowly-scoped credential (not yet built).
-- trades_v2 gets the same answer: no update policy for anon, matching
-- signal_log exactly. Sell-timing resolution becomes a job to fold into
-- the same deferred outcome-filler (or a sibling script with an equally
-- narrow credential) rather than a client-side write.
--
-- SEQUENCING, explicit because getting this wrong fails silently: closing
-- the hole on the OLD `trades` table (dropping its permissive anon UPDATE
-- policy) does NOT happen in this file and must NOT happen now. app.js
-- still calls writeSellTimingToSupabase against `trades` today. Locking
-- that table's UPDATE before the app stops calling it would make the
-- write start failing silently -- PostgREST returns 200 with an empty
-- body on an RLS-filtered update, so the Sold tab would quietly stop
-- resolving best-exit data with no error anywhere to explain why. The
-- lock-down is a separate, deferred step (see db/004_cutover_lock_
-- trades_update.sql) that lands at CUTOVER, the same moment app.js stops
-- writing to `trades` and starts writing to trades_v2. One change at a
-- time; the change that closes the hole ships with the change that stops
-- using it, not before.
--
-- CONSEQUENCE, stated rather than hidden: once cutover happens, the Sold
-- tab's "best exit" / "+5 days" line stops being resolved for new trades
-- until the deferred outcome job exists -- those columns just stay null,
-- same as any other pending outcome. Same tradeoff already accepted for
-- signal_log's outcome columns: shipping the clean, correctly-scoped
-- table now is right even though the fill job is a real follow-on.
--
-- LIFECYCLE ANSWER: (a). Rows are written ONCE, at sale, via INSERT.
-- Open positions never touch this table. No UPDATE policy exists for any
-- role but the (not-yet-built) outcome job's own credential, once that's
-- scoped -- same posture as signal_log.
--
-- SCHEMA SHAPE: real columns for everything the report aggregates,
-- filters, or buckets on directly (confirmed against every current
-- generateClaudeReport() usage of these fields, not assumed) -- this
-- includes the ~13 fields that were being silently dropped on every
-- Supabase round-trip in the old `trades` table (peakPrice, the ATR
-- pair, cappedByAtBuy, thresholdAtBuy, targetDriftPct,
-- trailingStopTriggered, rsiSuspendedAtGainPct, signalsFiredAtBuy,
-- newsAtBuy, volBuildNearMiss, meanReversionNearMiss). sellWarningAtSale
-- is NOT carried forward -- app.js's own comment calls it a retired enum
-- with no live writer.
--
-- Applying that same rule caught an inconsistency in the first draft:
-- volBuildNearMiss ({consecutiveDays, volRatio}) and
-- meanReversionNearMiss ({pctBelowMA, rsi}) were left as two small jsonb
-- blobs, but the report filters BOTH nested fields of both objects by
-- exact inequality (app.js: consecutiveDays===1, volRatio>=1.0/<1.3,
-- pctBelowMA<=-4/>-8, rsi>=45/<50). That's exactly the "filtered by name"
-- test that promoted the other 13 fields to columns, so it applies here
-- too -- flattened into four real numeric columns below instead.
--
-- WHAT'S ACTUALLY LEFT IN JSONB, then -- two columns, both genuine:
-- full_ure_factors_at_sale and full_peak_risk_factors_at_sale. Both are
-- the complete, variable-length factor-detail arrays behind the "top 2"
-- summaries (computeUnifiedSaleFields's ur.factors / peakRisk.topFactors
-- -- {name, points} objects, arbitrary length depending on which pillars
-- existed and fired for that trade). The report only ever sums or
-- displays these in full (e.g. the "Raw total" line, app.js:6130) -- it
-- never filters or buckets by one named factor inside them the way it
-- does the top-2 lists or the near-miss fields. That's the honest
-- boundary: full-fidelity detail kept for display/audit stays jsonb;
-- anything the report slices by name becomes a column. The three "top 2"
-- summary lists (top_exit_factors_at_sale, top_hold_factors_at_sale,
-- top_peak_risk_factors_at_sale) are plain string arrays with no nested
-- shape and are only ever joined/displayed, never filtered by contained
-- value the way signals_fired_at_buy is -- text[], not jsonb, for the
-- same reason signals_fired_at_buy already is.
--
-- signal_log_id links a trade back to the exact signal snapshot that led
-- to it (Phase 7 item 2) -- nullable, for "Own Decision" trades and any
-- trade that predates the signal log.
--
-- engine_source is EDGE/WARRIOR only, and stays NULLABLE rather than
-- gaining a third 'OWN' value -- NULL is the honest value for "no engine
-- produced this trade." The App-Signal-vs-Own-Decision distinction
-- already exists on its own independent axis (the `source` column,
-- 'App Signal'/'Own Decision', unchanged from the old `trades` table) --
-- engine_source answers "which engine, if any" and source answers "did
-- Roman act on the app's call or his own," and collapsing the second
-- question into a fake third enum value on the first column would just
-- reintroduce the two-things-modeled-once problem this phase keeps
-- catching elsewhere.
--
-- MIGRATION NOTE ON PRE-MIGRATION ROWS (deliberately not pinned to a row
-- count -- an earlier draft said "24 existing rows," which was already
-- stale by the time RLS verification testing added and removed rows
-- against the live table): the ~13 fields listed above (now 17, counting
-- the four flattened near-miss columns) have NEVER been captured for any
-- existing `trades` row -- they were dropped before ever reaching
-- Supabase, not just before this table existed. The migration cannot
-- recover them. Every migrated row will show null on these columns;
-- every trade recorded after this migration will show real values. That
-- discontinuity should be visible in the
-- report output (e.g. "peakPrice not tracked for this data source" style
-- notes, which the report already prints in some sections for exactly
-- this reason), not silently averaged away.
create table if not exists trades_v2 (
  id uuid primary key default gen_random_uuid(),

  -- attribution (Phase 7 item 2 -- new)
  signal_log_id uuid references signal_log(id),
  engine_source text check (engine_source in ('EDGE', 'WARRIOR')),

  -- identity / dates
  ticker text not null,
  company text,
  buy_date date not null,
  buy_time text,
  buy_day_of_week text,
  buy_session text,
  sell_date date not null,
  sell_time text,
  sell_day_of_week text,

  -- economics
  shares numeric not null,
  buy_price numeric not null,
  sell_price numeric not null,
  pnl_dollars numeric,
  pnl_pct numeric,

  -- signal state at buy
  signal_score numeric,
  signal_label text,
  rsi_at_buy numeric,
  volume_ratio_at_buy numeric,
  risk_score numeric,
  duration_classification text,
  price_tier text,
  macro_condition text,
  catalyst_setup boolean default false,
  sub10_adjustment numeric default 0,
  -- text, NOT numeric: the live `trades` table stores this as a
  -- sentence ("REACH TARGET: 12% likely"), not a number. The first
  -- draft typed it from the field NAME rather than the DATA and the
  -- migration failed on it (42804). If a numeric probability is ever
  -- wanted, extract it into its own column -- do not retype this one.
  groq_at_purchase text,

  -- previously-dropped buy-time fields (new real columns, see note above)
  news_at_buy text,
  signals_fired_at_buy text[],
  vol_build_near_miss_consecutive_days numeric,
  vol_build_near_miss_vol_ratio numeric,
  mean_reversion_near_miss_pct_below_ma numeric,
  mean_reversion_near_miss_rsi numeric,
  capped_by_at_buy text,
  raw_atr_at_buy numeric,
  trimmed_atr_at_buy numeric,
  threshold_at_buy numeric,

  -- score breakdown at buy (each bucketed individually by the report --
  -- see byPts() usage -- so these stay columns, not a jsonb blob)
  price_momentum_pts numeric,
  vol_spike_pts numeric,
  rsi_pts numeric,
  ma_pts numeric,
  vol_build_pts numeric,
  mean_reversion_pts numeric,
  cons_up_days numeric,
  cons_up_pts numeric,
  rel_strength_pts numeric,
  macro_adjustment_pts numeric,
  ma_pct_at_buy numeric,
  raw_score_at_buy numeric,

  -- sale-time snapshot
  distance_from_target numeric,
  momentum_protection boolean default false,
  source text,
  unified_recommendation_at_sale text,
  unified_composite_at_sale numeric,
  top_exit_factors_at_sale text[],
  top_hold_factors_at_sale text[],
  full_ure_factors_at_sale jsonb,
  lock_in_profits_fired boolean default false,
  peak_risk_score_at_sale numeric,
  peak_rsi_during_hold numeric,
  top_peak_risk_factors_at_sale text[],
  full_peak_risk_factors_at_sale jsonb,

  -- previously-dropped sale-time / hold fields (new real columns)
  target_drift_pct numeric,
  peak_price numeric,
  peak_price_date date,
  trailing_stop_triggered boolean default false,
  rsi_suspended_at_gain_pct numeric,

  -- lazy-resolved sell-timing analysis -- pending outcome columns, no
  -- writer yet (see lifecycle/sequencing note above); nullable until the
  -- deferred outcome job exists
  sell_timing_resolved boolean default false,
  best_exit_price numeric,
  best_exit_date date,
  best_exit_timing text,
  price_at_plus5_days numeric,

  created_at timestamptz not null default now()
);

create index if not exists trades_v2_ticker_idx on trades_v2 (ticker);
create index if not exists trades_v2_sell_date_idx on trades_v2 (sell_date);
create index if not exists trades_v2_engine_source_idx on trades_v2 (engine_source);
create index if not exists trades_v2_signal_log_id_idx on trades_v2 (signal_log_id);
create index if not exists trades_v2_pending_sell_timing_idx on trades_v2 (sell_date)
  where not sell_timing_resolved;

-- RLS: same fail-closed shape as signal_log, and for the same reason --
-- anon gets insert+select only. No update policy for any role, anon
-- included, until the deferred outcome job's own narrowly-scoped
-- credential is settled. This is a deliberate improvement over the live
-- `trades` table's current permissive anon UPDATE (see sequencing note
-- above for when that gets closed on the old table), not an oversight.
alter table trades_v2 enable row level security;

drop policy if exists "anon insert" on trades_v2;
create policy "anon insert" on trades_v2 for insert to anon with check (true);

drop policy if exists "anon select" on trades_v2;
create policy "anon select" on trades_v2 for select to anon using (true);
