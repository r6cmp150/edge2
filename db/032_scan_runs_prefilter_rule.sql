-- db/032 (2026-10-22): which pre-filter rule each EDGE scan actually used.
--
-- WHY: phase-10 step 1f replaces the IEX-today volume test with a trailing
-- 20-completed-session SIP average (floor 1,000,000 shares), plus
-- listed/tradable and recency checks. If that day's trailing fetch fails,
-- the scan still runs (the observer must not break the observed) and falls
-- back to the old IEX-today rule. So two rules can produce scan_runs rows,
-- and an analysis has to know which one built each pool, by construction,
-- not by date ranges someone remembers.
--
-- SEMANTICS: prefilter_rule = jsonb describing the rule AS APPLIED, with its
-- parameters, written once at insert:
--   {"rule": "trailing_sip_avg", "lookback_sessions": 20, "min_avg_shares": 1000000,
--    "price_min": 1, "price_max": 20, "requires_listed_tradable": true,
--    "requires_through": "2026-10-22"}        <- the previous trading day it must reach
--   {"rule": "iex_today_fallback", "min_volume": 100000, "price_min": 1,
--    "price_max": 20, "reason": "<why the trailing fetch failed>"}
--   NULL = a scan before this column (implicitly the IEX-today rule, which
--          was the only one; NOT backfilled, consistent with db/028/030).
-- Parameters live in the value, so a later change to the floor is
-- distinguishable from the 1M rule.
--
-- No CHECK on the shape beyond "an object with a rule": an unexpected
-- shape must never block a scan's insert.
--
-- WRITE-ONCE, CONSOLIDATED: this third write-once column on scan_runs
-- replaces the two per-column triggers (db/028's code_version, db/030's
-- trigger_type) with ONE trigger covering all three, the shape trades_v2
-- has had since db/028. (Roman asked for this condition to be written into
-- db/030's header as a trip-wire; it wasn't. It's written here instead.)
-- TRIP-WIRE from now on: a new write-once column on any table EXTENDS that
-- table's single write-once trigger; it never adds a second one.
--
-- ORDER: apply BEFORE the logger writes it (assertColumnsExist aborts on a
-- missing column).

begin;

alter table scan_runs add column if not exists prefilter_rule jsonb;

alter table scan_runs drop constraint if exists scan_runs_prefilter_rule_shape_chk;
alter table scan_runs add  constraint scan_runs_prefilter_rule_shape_chk
  check (prefilter_rule is null or (jsonb_typeof(prefilter_rule) = 'object' and jsonb_typeof(prefilter_rule -> 'rule') = 'string'));

drop trigger if exists scan_runs_code_version_write_once on scan_runs;
drop trigger if exists scan_runs_trigger_type_write_once on scan_runs;
drop trigger if exists scan_runs_prefilter_rule_write_once on scan_runs;
drop trigger if exists scan_runs_write_once on scan_runs;
create trigger scan_runs_write_once before update on scan_runs
  for each row execute function reject_code_version_change('code_version', 'trigger_type', 'prefilter_rule');

grant insert (prefilter_rule) on scan_runs to anon;

comment on column scan_runs.prefilter_rule is 'The EDGE pre-filter rule this scan applied, with its parameters: {rule: trailing_sip_avg | iex_today_fallback, ...}. Write-once. NULL = before db/032 (the IEX-today rule). (db/032)';

commit;

-- Verification: ONE query, ONE row. Expected:
--   columns 1 | constraints 1 | write_once_triggers 1 | covers_all_three true | anon_can_insert true | populated 0
--   (write_once_triggers counts every non-internal trigger on scan_runs that uses the
--    write-once function: exactly 1 means the two old ones are gone)
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'scan_runs'
      and column_name = 'prefilter_rule' and data_type = 'jsonb' and is_nullable = 'YES') as columns,
  (select count(*) from pg_constraint where conname = 'scan_runs_prefilter_rule_shape_chk') as constraints,
  (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.scan_runs'::regclass and not t.tgisinternal
      and p.proname = 'reject_code_version_change') as write_once_triggers,
  (select pg_get_triggerdef(oid) like '%''code_version'', ''trigger_type'', ''prefilter_rule''%'
     from pg_trigger where tgname = 'scan_runs_write_once' and not tgisinternal) as covers_all_three,
  has_column_privilege('anon', 'public.scan_runs', 'prefilter_rule', 'INSERT') as anon_can_insert,
  (select count(*) from scan_runs where prefilter_rule is not null) as populated;
