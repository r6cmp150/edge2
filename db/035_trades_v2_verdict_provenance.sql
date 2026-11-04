-- db/035 (2026-11-02): where each stored at-sale verdict came from, and the
-- last signal that predates the sale. DRAFT, for Roman to apply.
--
-- WHY: unified_recommendation_at_sale and its factors (and the peak-risk
-- score) were computed at RECORDING time from inputs of several moments:
-- the sale's price and date, but rsi = the BUY's RSI (the card passes live
-- RSI, so a stored label can never equal what the card showed), prevRSI and
-- peak/momentum from whichever Portfolio renders happened, the macro
-- condition of the recording session, and the latest scan at recording,
-- which for a sale recorded after the fact can be a scan taken AFTER the
-- sale: post-sale data inside the record of the sale. "RSI declining from
-- peak (92 -> 92)", -30, appears in stored LOCK IN PROFITS verdicts. Those
-- inputs were never captured, so the rows can't be recomputed. They are
-- MARKED, not fixed. From this change the app stops computing an at-sale
-- verdict at all (phase-10 appendix, "Decided: the at-sale verdict").
--
-- WHAT:
--   verdict_provenance  text, three states, write-once:
--     'sale_moment'   every input from the sale's own moment. RESERVED: the
--                     app can't produce one yet (the sale's time isn't
--                     recorded, and prevRSI/peak/momentum are render state).
--     'mixed_moment'  inputs from several moments, possibly after the sale.
--                     Every existing row that stored a verdict.
--     'not_recorded'  no verdict stored. Existing rows without one, and
--                     every new sale from this change.
--   CHECK: not_recorded <=> unified_recommendation_at_sale IS NULL, so the
--   label and its provenance can't disagree.
--   signal_before_sale  jsonb, write-once, THREE STATES, each a value:
--       {"state":"PREDATES_SALE","scanned_at":<iso>, ...the signal...}
--       {"state":"NOT_ESTABLISHED","reason":<text>}   looked, couldn't establish one
--       {"state":"NOT_RECORDED","reason":<text>}      the mechanism didn't exist
--     Every existing row gets NOT_RECORDED ("predates db/035"). NULL is
--     allowed only until db/036 (the cached-build window), never after.
--   lock_in_profits_fired: DROP its `default false` (a writer that omits it
--     would store "LOCK IN PROFITS never fired", which nobody computed;
--     db/008 did the same for trailing_stop_triggered), set it NULL on every
--     not_recorded row (a stored false there is a claim about no verdict;
--     0 rows on 2026-11-02, pinned d6e277d and live), and the CHECK keeps it
--     NULL on not_recorded rows from now on.
--
-- TWO STEPS, because of the cached app: an insert naming a column that
-- doesn't exist fails, and an insert by the PREVIOUS build (still cached on
-- a phone for minutes after a deploy) doesn't name these columns.
--   db/035 (this file), BEFORE the deploy: columns nullable, backfill,
--     checks, write-once, grants.
--   db/036, AFTER the deploy is live and one real sale has been
--     re-selected: classifies any row the old build wrote in between by the
--     same rule, then makes verdict_provenance NOT NULL.
--
-- WRITE-ONCE: a trigger rejects any change to either column once it holds a
-- value. NULL -> value is allowed (it's the first write; db/036 needs it).
-- Its function is NEW and trades_v2-only, created with plain CREATE
-- FUNCTION (not OR REPLACE): if that name already exists live, this file
-- errors and the whole transaction rolls back, so it can never rewrite
-- another table's write-once behaviour or message. The shared function
-- reject_code_version_change (db/028; db/030 and db/032 reuse it) is not
-- touched.
-- PRIVILEGES (probed live as anon, 2026-11-02, scripts/probe-anon-
-- privileges.mjs): anon holds INSERT and UPDATE on every trades_v2 column
-- and DELETE on the table (Supabase's default grant; nothing narrowed it).
-- The GRANTs are no barrier; RLS is (repo: anon policies for INSERT and
-- SELECT only, db/002), plus this trigger on these two columns. The RLS
-- policies must be confirmed LIVE before this is applied (read-only query
-- in the review).
-- CONFIRMED LIVE (2026-11-02, db/035-preflight.sql): trades_v2 has RLS on,
-- anon policies INSERT and SELECT only, no UPDATE/DELETE policy reaching anon.
-- NO COLUMN GRANT IN THIS FILE, deliberately. A column-level grant adds
-- nothing while the table-level grant exists (has_column_privilege counts
-- both), and earlier migrations' column grants (db/028, db/031, db/033 on
-- portfolio, scan_runs, signal_log, trades_v2) are redundant for that
-- reason: they read like narrowing and are not. The real narrowing is
-- column grants WITH the table-level grant revoked, as workflow_runs has
-- (db/023); that is the end state the auth cutover (step 4) aims for.

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

-- Verification, part 1: ONE query, ONE row. Expected:
--   mixed = with_verdict | not_recorded = total - with_verdict | null_prov 0 |
--   null_signal 0 | signal_not_recorded = total | lock_claims_left 0 |
--   fn_users 1 | sale_moment 0 | checks 2 | trigger 1 | lock_default null |
--   anon_insert true true
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
  has_column_privilege('anon', 'public.trades_v2', 'signal_before_sale', 'INSERT') as anon_insert_sig;

-- Verification, part 2: a REAL insert AS anon, through RLS, rolled back.
-- has_column_privilege above does not consult RLS (db/034's lesson: that is
-- how 72 snapshots were lost). Run as ONE block. Expected: "INSERT 0 1",
-- then ROLLBACK, and afterwards part 1's total is unchanged. An error here
-- (42501, or 23514) means the app's sale write would fail.
begin;
set local role anon;
insert into trades_v2 (ticker, buy_date, sell_date, shares, buy_price, sell_price, position_id,
                       verdict_provenance, unified_recommendation_at_sale, lock_in_profits_fired, signal_before_sale)
values ('DB035', '2026-11-02', '2026-11-02', 1, 1, 1, 'db035-verify-rolled-back',
        'not_recorded', null, null, '{"state":"NOT_ESTABLISHED","reason":"db/035 verification, rolled back"}');
rollback;

-- Verification, part 3: the checks refuse what they must. Each of these, run
-- on its own, must FAIL with 23514 (check violation); none writes a row.
--   begin; set local role anon; insert into trades_v2 (ticker,buy_date,sell_date,shares,buy_price,sell_price,verdict_provenance) values ('DB035','2026-11-02','2026-11-02',1,1,1,'guessed'); rollback;
--   begin; set local role anon; insert into trades_v2 (ticker,buy_date,sell_date,shares,buy_price,sell_price,verdict_provenance,unified_recommendation_at_sale) values ('DB035','2026-11-02','2026-11-02',1,1,1,'not_recorded','HOLD'); rollback;
--   begin; set local role anon; insert into trades_v2 (ticker,buy_date,sell_date,shares,buy_price,sell_price,verdict_provenance,signal_before_sale) values ('DB035','2026-11-02','2026-11-02',1,1,1,'not_recorded','{"state":"PREDATES_SALE"}'); rollback;
--   begin; set local role anon; insert into trades_v2 (ticker,buy_date,sell_date,shares,buy_price,sell_price,verdict_provenance,lock_in_profits_fired) values ('DB035','2026-11-02','2026-11-02',1,1,1,'not_recorded',false); rollback;
