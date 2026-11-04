-- db/035 run 2 of 5: read-only. Revised 2026-11-05: three columns on the NULL rows recorded since run 1.
select
  (select count(*) from trades_v2) as total,
  (select count(*) from trades_v2 where unified_recommendation_at_sale is not null) as with_verdict,
  (select count(*) from trades_v2 where verdict_provenance = 'mixed_moment') as mixed,
  (select count(*) from trades_v2 where verdict_provenance = 'not_recorded') as not_recorded,
  (select count(*) from trades_v2 where verdict_provenance = 'sale_moment') as sale_moment,
  (select count(*) from trades_v2 where verdict_provenance is null) as null_prov,
  (select count(*) from trades_v2 where signal_before_sale is null) as null_signal,
  (select count(*) from trades_v2 where signal_before_sale->>'state' = 'NOT_RECORDED') as signal_not_recorded,
  (select count(*) from trades_v2 where verdict_provenance = 'not_recorded' and lock_in_profits_fired is not null) as lock_claims_left,
  (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'trades_v2_reject_provenance_change') as fn_users,
  (select count(*) from pg_constraint where conrelid = 'public.trades_v2'::regclass
     and conname in ('trades_v2_verdict_provenance_chk', 'trades_v2_signal_before_sale_shape_chk')) as checks,
  (select count(*) from pg_trigger where tgrelid = 'public.trades_v2'::regclass and tgname = 'trades_v2_verdict_provenance_write_once') as trigger,
  (select column_default from information_schema.columns where table_name = 'trades_v2' and column_name = 'lock_in_profits_fired') as lock_default,
  (select is_nullable from information_schema.columns where table_name = 'trades_v2' and column_name = 'lock_in_profits_fired') as lock_nullable,
  has_column_privilege('anon', 'public.trades_v2', 'verdict_provenance', 'INSERT') as anon_insert_prov,
  has_column_privilege('anon', 'public.trades_v2', 'signal_before_sale', 'INSERT') as anon_insert_sig,
  -- Main's build doesn't write the two columns ((b) does, and is gated on this), so every sale recorded
  -- after run 1 has NULL in both. Pass: every NULL row is newer than every backfilled one, and each
  -- carries a verdict, so it is the same mixed_moment kind run 1 backfilled.
  (select max(created_at) from trades_v2 where verdict_provenance is not null) as last_backfilled_at,
  (select min(created_at) from trades_v2 where verdict_provenance is null) as first_null_at,
  (select count(*) from trades_v2 where verdict_provenance is null and unified_recommendation_at_sale is null) as null_without_verdict;
