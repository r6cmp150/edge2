begin;

-- GUARD (2026-11-02): every sale from this build writes not_recorded, and the
-- CHECK below requires lock_in_profits_fired IS NULL on those rows. If the
-- live column were NOT NULL, that CHECK could never be satisfied and every
-- sale write would fail. db/002 created it nullable and no migration changed
-- that, but the repo is not the live database: refuse to proceed otherwise.
do $$
begin
  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'trades_v2' and column_name = 'lock_in_profits_fired') is distinct from 'YES' then
    raise exception 'db/035 ABORTED, nothing changed: trades_v2.lock_in_profits_fired is not nullable live, so the not_recorded CHECK would block every sale';
  end if;
end $$;

alter table trades_v2 add column if not exists verdict_provenance text;
alter table trades_v2 add column if not exists signal_before_sale jsonb;

-- The backfill: the rule, applied to every existing row.
update trades_v2
   set verdict_provenance = case when unified_recommendation_at_sale is not null then 'mixed_moment' else 'not_recorded' end
 where verdict_provenance is null;
update trades_v2
   set signal_before_sale = '{"state":"NOT_RECORDED","reason":"predates db/035"}'::jsonb
 where signal_before_sale is null;
update trades_v2
   set lock_in_profits_fired = null
 where verdict_provenance = 'not_recorded' and lock_in_profits_fired is not null;

alter table trades_v2 drop constraint if exists trades_v2_verdict_provenance_chk;
alter table trades_v2 add  constraint trades_v2_verdict_provenance_chk check (
  verdict_provenance is null
  or (verdict_provenance in ('sale_moment', 'mixed_moment', 'not_recorded')
      and (verdict_provenance = 'not_recorded') = (unified_recommendation_at_sale is null)
      and (verdict_provenance <> 'not_recorded' or lock_in_profits_fired is null)));

alter table trades_v2 drop constraint if exists trades_v2_signal_before_sale_shape_chk;
alter table trades_v2 add  constraint trades_v2_signal_before_sale_shape_chk check (
  signal_before_sale is null
  or (signal_before_sale->>'state' = 'PREDATES_SALE' and jsonb_typeof(signal_before_sale->'scanned_at') = 'string')
  or (signal_before_sale->>'state' in ('NOT_ESTABLISHED', 'NOT_RECORDED') and jsonb_typeof(signal_before_sale->'reason') = 'string'));

alter table trades_v2 alter column lock_in_profits_fired drop default;

create function trades_v2_reject_provenance_change() returns trigger
language plpgsql as $$
declare c text;
begin
  foreach c in array tg_argv loop
    if (to_jsonb(old) -> c) is not null and (to_jsonb(old) -> c) <> 'null'::jsonb
       and (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c) then
      raise exception '%.% is write-once (db/035)', tg_table_name, c;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists trades_v2_verdict_provenance_write_once on trades_v2;
create trigger trades_v2_verdict_provenance_write_once before update on trades_v2
  for each row execute function trades_v2_reject_provenance_change('verdict_provenance', 'signal_before_sale');

-- No column grant: anon already holds table-level INSERT on trades_v2, so a
-- column-level INSERT here would grant nothing and only read like a narrowing.

comment on column trades_v2.verdict_provenance is 'Where unified_recommendation_at_sale and its factors came from: sale_moment (every input from the sale''s moment; reserved, none yet) | mixed_moment (several moments, possibly after the sale: every row before 2026-11-02 that stored one) | not_recorded (no verdict). Write-once. (db/035)';
comment on column trades_v2.signal_before_sale is 'The last scan signal that predates the sale, with its own scanned_at ({"state":"PREDATES_SALE",...}); or why none can be established ({"state":"NOT_ESTABLISHED","reason":...}); or {"state":"NOT_RECORDED","reason":...} for a row the mechanism predates. Write-once. (db/035)';

commit;
