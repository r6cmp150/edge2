-- One-shot migration of all rows currently in `trades` into trades_v2.
-- Deliberately phrased as "all rows," not a specific count -- an earlier
-- draft said "24 existing rows," which was already stale by the time RLS
-- verification testing added and removed rows against the live table
-- (37 at last check). The query itself is unaffected either way -- it
-- selects whatever's actually there -- but a stale count in a comment
-- meant to describe the acceptance test is a bug waiting to confuse
-- whoever reads it during the diff.
-- Guarded against a double run (see the WHERE NOT EXISTS on the final
-- SELECT below) -- running this a second time inserts nothing rather
-- than duplicating every row, since this is executed by hand in a web
-- SQL editor with no other signal that it already succeeded. Verify via
-- the Claude Report diff described alongside this file, then stop
-- writing to `trades`.
--
-- RUN THIS FIRST (read-only pre-flight): trades_v2 declares buy_date,
-- sell_date, shares, buy_price and sell_price NOT NULL. If any existing
-- `trades` row is null in one of those, the insert below aborts --
-- cleanly (one statement, all-or-nothing, no partial state), but
-- confusingly if you don't already know why. Check first:
--
--   select count(*) filter (where buy_date is null) as null_buy_date,
--          count(*) filter (where sell_date is null) as null_sell_date,
--          count(*) filter (where shares is null) as null_shares,
--          count(*) filter (where buy_price is null) as null_buy_price,
--          count(*) filter (where sell_price is null) as null_sell_price
--   from trades;
--
-- All zeros means the migration will land. Anything non-zero, stop and
-- report back before running the insert -- we'd decide whether to relax
-- the constraint or fix the row.
--
-- Every column with no source in `trades` and NO DEFAULT on trades_v2 is
-- left NULL by omission (peak_price, the ATR pair, capped_by_at_buy,
-- threshold_at_buy, target_drift_pct, rsi_suspended_at_gain_pct,
-- signals_fired_at_buy, news_at_buy, and the four flattened near-miss
-- columns) -- see db/002_trades_v2.sql's migration note: these were
-- never captured for any pre-migration row and cannot be recovered.
--
-- trailing_stop_triggered is NOT in that list, and an earlier version of
-- this comment wrongly included it -- caught 2026-09-05, empirically,
-- after cutover, not by re-reading this file. trades_v2 declares it
-- `boolean default false`; since this INSERT never lists the column,
-- omitting it applies that DEFAULT instead of leaving it null. Every
-- migrated row got a confirmed-false value for a field that was actually
-- never captured -- see db/008_fix_trailing_stop_triggered_default.sql
-- for the correction (reset to null, drop the default). Checked the rest
-- of the "column carries a DEFAULT" family against this same failure
-- mode (catalyst_setup, sub10_adjustment, momentum_protection,
-- lock_in_profits_fired, sell_timing_resolved): trailing_stop_triggered
-- is the only one of those six this INSERT omits, so it's the only one
-- affected.
--
-- top_exit_factors_at_sale / top_hold_factors_at_sale /
-- top_peak_risk_factors_at_sale are text[] in trades_v2 but may be jsonb
-- or a native array in the old `trades` table (created outside this
-- repo, actual type unconfirmed). to_jsonb(...) is applied before
-- jsonb_array_elements_text(...) so the cast works either way: to_jsonb
-- on an already-jsonb value is a no-op, and to_jsonb on a native array
-- produces the equivalent jsonb array. Each is wrapped in a null guard --
-- some pre-migration trades predate the unified-recommendation fields
-- entirely, so a NULL source column is plausible, not hypothetical, and
-- to_jsonb(NULL) yields the jsonb scalar 'null', which
-- jsonb_array_elements_text rejects ("cannot extract elements from a
-- scalar") rather than treating as empty.
--
-- engine_source: Warrior did not exist for any pre-migration trade, so
-- the only engine that could have produced a signal is EDGE. Rows sold
-- as "App Signal" get engine_source = 'EDGE'; rows sold as "Own Decision"
-- get NULL (no engine signal was involved -- NULL is the schema's honest
-- value for that case, not a third enum entry). signal_log_id is left
-- NULL for every migrated row -- the signal log did not exist yet
-- either. Flag if the App Signal -> EDGE default is wrong before running.
--
-- TWO TYPE MISMATCHES FOUND AT RUN TIME (2026-09-05), both real, both
-- fixed here and in 002 -- neither was caught by the column-count check,
-- because counting columns proves the lists line up, not that the types
-- on either side agree:
--
--   groq_at_purchase -- `trades` stores TEXT ("REACH TARGET: 12% likely"),
--     a sentence, not a number. 002 had declared it numeric, typed from
--     the field name rather than from the data. Postgres refused the
--     insert (42804). Fixed by correcting 002's column to text, NOT by
--     casting -- a cast here would have failed outright, and any cast
--     that did succeed would have destroyed the sentence.
--   best_exit_date -- `trades` stores TEXT, trades_v2 declares date, and
--     the stored values are clean ISO dates ('2026-08-17'), so date is
--     the correct target type and the old text column was the mistake.
--     Cast explicitly below. nullif(...,'') guards the empty string,
--     which would raise on ::date while NULL passes through fine.
--
-- Everything else lines up: the ~20 integer->numeric widenings are
-- implicit and lossless, and the three ARRAY columns are already native
-- arrays, so the to_jsonb round-trip below is a no-op on them.
insert into trades_v2 (
  engine_source, ticker, company, buy_date, buy_time, buy_day_of_week,
  buy_session, sell_date, sell_time, sell_day_of_week, shares, buy_price,
  sell_price, pnl_dollars, pnl_pct, signal_score, signal_label,
  rsi_at_buy, volume_ratio_at_buy, risk_score, duration_classification,
  price_tier, macro_condition, catalyst_setup, sub10_adjustment,
  groq_at_purchase, price_momentum_pts, vol_spike_pts, rsi_pts, ma_pts,
  vol_build_pts, mean_reversion_pts, cons_up_days, cons_up_pts,
  rel_strength_pts, macro_adjustment_pts, ma_pct_at_buy, raw_score_at_buy,
  distance_from_target, momentum_protection, source,
  unified_recommendation_at_sale, unified_composite_at_sale,
  top_exit_factors_at_sale, top_hold_factors_at_sale,
  full_ure_factors_at_sale, lock_in_profits_fired, peak_risk_score_at_sale,
  peak_rsi_during_hold, top_peak_risk_factors_at_sale,
  full_peak_risk_factors_at_sale, sell_timing_resolved, best_exit_price,
  best_exit_date, best_exit_timing, price_at_plus5_days, created_at
)
select
  case when source = 'App Signal' then 'EDGE' else null end,
  ticker, company, buy_date, buy_time, buy_day_of_week, buy_session,
  sell_date, sell_time, sell_day_of_week, shares, buy_price, sell_price,
  pnl_dollars, pnl_pct, signal_score, signal_label, rsi_at_buy,
  volume_ratio_at_buy, risk_score, duration_classification, price_tier,
  macro_condition, catalyst_setup, sub10_adjustment, groq_at_purchase,
  price_momentum_pts, vol_spike_pts, rsi_pts, ma_pts, vol_build_pts,
  mean_reversion_pts, cons_up_days, cons_up_pts, rel_strength_pts,
  macro_adjustment_pts, ma_pct_at_buy, raw_score_at_buy,
  distance_from_target, momentum_protection, source,
  unified_recommendation_at_sale, unified_composite_at_sale,
  case when top_exit_factors_at_sale is null then null
       else array(select jsonb_array_elements_text(to_jsonb(top_exit_factors_at_sale))) end,
  case when top_hold_factors_at_sale is null then null
       else array(select jsonb_array_elements_text(to_jsonb(top_hold_factors_at_sale))) end,
  full_ure_factors_at_sale, lock_in_profits_fired, peak_risk_score_at_sale,
  peak_rsi_during_hold,
  case when top_peak_risk_factors_at_sale is null then null
       else array(select jsonb_array_elements_text(to_jsonb(top_peak_risk_factors_at_sale))) end,
  full_peak_risk_factors_at_sale, sell_timing_resolved, best_exit_price,
  nullif(best_exit_date, '')::date,
  best_exit_timing, price_at_plus5_days, created_at
from trades
where not exists (select 1 from trades_v2 limit 1);
