-- db/036 (2026-11-02): verdict_provenance becomes NOT NULL. DRAFT, for Roman.
--
-- APPLY ONLY AFTER: db/035 is applied, the build that writes
-- verdict_provenance is live (sw.js edge2-<its stamp> served), and one real
-- sale recorded on it has been re-selected showing verdict_provenance =
-- 'not_recorded' and a signal_before_sale object.
--
-- WHY A SECOND STEP: between db/035 and the deploy, a phone still running
-- the previous (cached) build could record a sale without naming the new
-- columns, leaving verdict_provenance NULL. That build computed the verdict
-- the old way, so the same rule classifies it exactly as db/035 did:
-- a stored verdict is mixed_moment, no verdict is not_recorded. Nothing
-- else may be NULL after this.

begin;

update trades_v2
   set verdict_provenance = case when unified_recommendation_at_sale is not null then 'mixed_moment' else 'not_recorded' end
 where verdict_provenance is null;
update trades_v2
   set signal_before_sale = '{"state":"NOT_RECORDED","reason":"recorded by a build before db/035"}'::jsonb
 where signal_before_sale is null;
update trades_v2
   set lock_in_profits_fired = null
 where verdict_provenance = 'not_recorded' and lock_in_profits_fired is not null;

alter table trades_v2 alter column verdict_provenance set not null;
alter table trades_v2 alter column signal_before_sale set not null;

alter table trades_v2 drop constraint if exists trades_v2_verdict_provenance_chk;
alter table trades_v2 add  constraint trades_v2_verdict_provenance_chk check (
  verdict_provenance in ('sale_moment', 'mixed_moment', 'not_recorded')
  and (verdict_provenance = 'not_recorded') = (unified_recommendation_at_sale is null)
  and (verdict_provenance <> 'not_recorded' or lock_in_profits_fired is null));

commit;

-- Verification: ONE row. Expected: null_prov 0 | null_signal 0 |
-- prov_nullable NO | signal_nullable NO | window_rows = sales recorded by
-- main's build between db/035 run 1 and the deploy of (b): 74 at the 2026-11-05 13:37Z backup (every sale
-- recorded since run 1, 11-03 15:05Z to 11-04 19:50Z), and more for each sale until (b) is live.
select
  (select count(*) from trades_v2 where verdict_provenance is null) as null_prov,
  (select count(*) from trades_v2 where signal_before_sale is null) as null_signal,
  (select is_nullable from information_schema.columns where table_name = 'trades_v2' and column_name = 'verdict_provenance') as prov_nullable,
  (select is_nullable from information_schema.columns where table_name = 'trades_v2' and column_name = 'signal_before_sale') as signal_nullable,
  (select count(*) from trades_v2 where signal_before_sale->>'reason' = 'recorded by a build before db/035') as window_rows;
