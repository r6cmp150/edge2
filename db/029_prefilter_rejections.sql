-- db/029 (2026-10-21): log the EDGE pre-filter's rejections.
--
-- WHY: the EDGE logger's pre-filter (scripts/log-signals-edge.mjs, copying
-- app.js runScreener) keeps $1-$20 symbols with >= min volume traded SO FAR
-- TODAY. Everything it rejects leaves no row: a 07:28 PT scan rejected
-- 228 of 239 (Actions run 39617114090), and db/014's prefiltered_count
-- says only HOW MANY. Because the volume test is cumulative, the pool
-- changes with the clock, which confounds the phase-10 §3.4 entry-time
-- finding (phase-10 §7.3). A missing row is indistinguishable from a true
-- negative, so the filter's own selectivity is currently unmeasurable.
--
-- SEMANTICS, FIXED HERE SO NOBODY RE-DERIVES THEM:
--   prefilter_rejections = jsonb array, one element per rejected symbol in
--     THIS scan:
--       {"symbol": "ABCD", "price": 0.87, "volume": 41200,
--        "failed": ["price_below_min", "volume_below_min"]}
--     price  = getLivePrice(snapshot) at the moment of rejection (the value
--              the filter tested), NULL if the snapshot had none.
--     volume = snapshot.dailyBar.v at that moment: cumulative volume so far
--              today, the value the filter tested.
--     failed = EVERY test the symbol failed, not just the first:
--              price_below_min | price_above_max | volume_below_min |
--              no_snapshot. Listing all of them matters: "rejected for
--              volume" and "rejected for price and volume" answer the §7.3
--              confound differently.
--   The scan timestamp is the scan_runs row's own started_at. The rejections
--   are per scan, so a symbol rejected at 07:28 and accepted at 10:00 shows
--   both facts.
--   NULL = a scan before this column existed. [] = a scan that rejected
--   nothing: a real, recorded zero, not a missing value.
--
-- NOT a fourth signal_log tier: signal_log's unique key (signal_date,
-- symbol, engine_source, tier) would keep only the FIRST rejection per
-- symbol per day, discarding the per-scan picture this exists for, and
-- every signal_log reader assumes a scored snapshot. No bars, news or score
-- are stored: zero extra requests, a few hundred bytes per symbol. Forward
-- returns for a sample of rejects are fetched later, off the scan path.
--
-- ORDER: apply before the logger change that writes it. The logger's
-- assertColumnsExist check would otherwise abort the whole run, so no
-- signals at all would be logged that day.

-- GRANTS: same as db/028. Granted to anon explicitly (additive; a no-op
-- where table-level INSERT exists), verified with has_column_privilege.
-- No trigger: this column is written once, by the scan_runs INSERT, and
-- nothing updates scan_runs rows.
--
-- SHAPE CHECK: an array or NULL. Element shape is the logger's contract
-- (asserted in its own code before insert), not checked per element here.
--
-- Independent of db/028: either can be applied first. db/028 first is the
-- documented order.

begin;

alter table scan_runs add column if not exists prefilter_rejections jsonb;

alter table scan_runs drop constraint if exists scan_runs_prefilter_rejections_shape_chk;
alter table scan_runs add  constraint scan_runs_prefilter_rejections_shape_chk
  check (prefilter_rejections is null or jsonb_typeof(prefilter_rejections) = 'array');

grant insert (prefilter_rejections) on scan_runs to anon;

comment on column scan_runs.prefilter_rejections is 'EDGE pre-filter rejections for THIS scan: [{symbol, price, volume (cumulative so far today), failed: [price_below_min|price_above_max|volume_below_min|no_snapshot]}]. [] = rejected nothing. NULL = before db/029. (db/029)';

commit;

-- Verification: ONE query, ONE row. Expected:
--   columns 1 | constraints 1 | anon_can_insert true | populated 0
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'scan_runs'
      and column_name = 'prefilter_rejections' and data_type = 'jsonb' and is_nullable = 'YES') as columns,
  (select count(*) from pg_constraint where conname = 'scan_runs_prefilter_rejections_shape_chk') as constraints,
  has_column_privilege('anon', 'public.scan_runs', 'prefilter_rejections', 'INSERT') as anon_can_insert,
  (select count(*) from scan_runs where prefilter_rejections is not null) as populated;
