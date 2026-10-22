-- db/028 (2026-10-21): which code recorded this row.
--
-- WHY: the fourth time "which code produced this row" has cost an
-- analysis (phase-10 spec §7.6 step 1d):
--   1. scoreAtBuy changed meaning across the normalisation boundary, and
--      nothing on a row said which side it was on.
--   2. signal_log rows from before and after a scoring change pool unless
--      something separates them (phase-10 step 2).
--   3. "Which code recorded this trade": the stock-modal fix (phase-10
--      §7.5) wrote off stored cons_up/rel_strength fields, and the only
--      cutoff available was the ORDER date, a proxy that a tab left open
--      across the deploy breaks.
--   4. The column that was supposed to answer this already exists on
--      signal_log and scan_runs (build_version, db/001, db/010) and
--      identifies nothing. It is filled from app.js's VERSION constant,
--      which nobody bumps: 588 EDGE rows from 2026-09-16 to 2026-10-20 all
--      say v2.18.0, across 17 commits to app.js / core/edge-scoring.js.
--
-- SEMANTICS, FIXED HERE SO NOBODY RE-DERIVES THEM:
--   code_version = {"app": "<stamp>", "scoring": <int>, "scoring_hash": "<hex>"}
--     written ONCE, by the code that records the row, at the moment it
--     records it.
--   app          = the ?v= stamp of the app.js the recording code actually
--     ran. Browser: read from the loaded <script src="app.js?v=...">, so a
--     tab left open across a deploy reports the OLD stamp it is really
--     running. Cron scripts: the same stamp read from index.html at their
--     own checkout. Never a hand-maintained constant.
--   scoring      = SCORING_VERSION, an integer: orderable, so it is what
--     queries join and filter on ("rows scored under version >= 3").
--   scoring_hash = hex hash of the scoring formula's source, which
--     tests/score-components.test.js pins to SCORING_VERSION. It's
--     tamper-evident: the formula can't change without the integer
--     changing, and a row's hash says which source actually scored it.
--     The integer answers "which version", the hash answers "is that really
--     the code".
--   NULL = recorded before this column existed, or by code that predates
--     it. Never backfilled: no stored fact says which code wrote an old
--     row, and a guessed version is a value nobody observed.
--
-- WHICH MOMENT, PER TABLE:
--   portfolio.code_version      = the BUY recording (insertPositionToSupabase).
--   trades_v2.code_version      = copied from the position at sale: the BUY's
--     recording version, which identifies the stored score, components and
--     signal fields.
--   trades_v2.sale_code_version = the code that ran the SALE
--     (confirmMarkSold), which produced unified_recommendation_at_sale, the
--     full URE factors and every other sale-time field. Two columns, because
--     filing sale-time values under the buy's version would be a wrong label
--     on a value.
--   signal_log.code_version     = the scan that logged the row.
--   scan_runs.code_version      = the same scan (one row per logger run).
--
-- signal_log.build_version and scan_runs.build_version are left in place
-- and documented as uninformative after 2026-09-15. Nothing reads them;
-- nothing writes them once the logger switches to code_version.
--
-- WRITE-ONCE IS ENFORCED, NOT COMMENTED: a trigger rejects any UPDATE that
-- changes these columns, NULL -> value included, so they can't be
-- backfilled or rewritten. Rows that never had a value stay NULL. Updates
-- that leave the column unchanged (the outcome filler's column-scoped
-- updates, the app's position updates) pass through untouched.
--
-- GRANTS: the repo shows column-level INSERT grants only on workflow_runs
-- (db/023). INSERT on these four tables has never been narrowed, so anon
-- holds it at table level. The live database is not the repo, so this
-- file grants the new columns to anon explicitly anyway. A column-level
-- grant is additive, and a no-op where the table-level privilege exists.
-- The verification checks the result with has_column_privilege, Postgres's
-- own answer over table- and column-level grants together. The real-write
-- proof comes at deploy: the first real logger run and the first real
-- add/sale write code_version through the real code paths, and those rows
-- are re-selected. A synthetic anon test row isn't used here, because anon
-- has no delete path and it would stay in trades_v2/signal_log, which are
-- analysis data, forever. No UPDATE grant is added: the app writes
-- code_version only on insert.
--
-- SHAPE CHECK: app string, scoring number, scoring_hash string when
-- present. A malformed value is refused rather than stored, because a
-- version nobody can parse is a wrong label too.
--
-- ORDER OF OPERATIONS: apply this file BEFORE deploying code that writes
-- code_version. An insert naming a column that doesn't exist fails, and for
-- portfolio that is the add-position path.

begin;

alter table portfolio  add column if not exists code_version jsonb;
alter table trades_v2  add column if not exists code_version jsonb;
alter table trades_v2  add column if not exists sale_code_version jsonb;
alter table signal_log add column if not exists code_version jsonb;
alter table scan_runs  add column if not exists code_version jsonb;

alter table portfolio  drop constraint if exists portfolio_code_version_shape_chk;
alter table portfolio  add  constraint portfolio_code_version_shape_chk check (code_version is null or (
  jsonb_typeof(code_version->'app') = 'string' and jsonb_typeof(code_version->'scoring') = 'number'
  and (not (code_version ? 'scoring_hash') or jsonb_typeof(code_version->'scoring_hash') = 'string')));
alter table trades_v2  drop constraint if exists trades_v2_code_version_shape_chk;
alter table trades_v2  add  constraint trades_v2_code_version_shape_chk check (code_version is null or (
  jsonb_typeof(code_version->'app') = 'string' and jsonb_typeof(code_version->'scoring') = 'number'
  and (not (code_version ? 'scoring_hash') or jsonb_typeof(code_version->'scoring_hash') = 'string')));
alter table trades_v2  drop constraint if exists trades_v2_sale_code_version_shape_chk;
alter table trades_v2  add  constraint trades_v2_sale_code_version_shape_chk check (sale_code_version is null or (
  jsonb_typeof(sale_code_version->'app') = 'string' and jsonb_typeof(sale_code_version->'scoring') = 'number'
  and (not (sale_code_version ? 'scoring_hash') or jsonb_typeof(sale_code_version->'scoring_hash') = 'string')));
alter table signal_log drop constraint if exists signal_log_code_version_shape_chk;
alter table signal_log add  constraint signal_log_code_version_shape_chk check (code_version is null or (
  jsonb_typeof(code_version->'app') = 'string' and jsonb_typeof(code_version->'scoring') = 'number'
  and (not (code_version ? 'scoring_hash') or jsonb_typeof(code_version->'scoring_hash') = 'string')));
alter table scan_runs  drop constraint if exists scan_runs_code_version_shape_chk;
alter table scan_runs  add  constraint scan_runs_code_version_shape_chk check (code_version is null or (
  jsonb_typeof(code_version->'app') = 'string' and jsonb_typeof(code_version->'scoring') = 'number'
  and (not (code_version ? 'scoring_hash') or jsonb_typeof(code_version->'scoring_hash') = 'string')));

create or replace function reject_code_version_change() returns trigger
language plpgsql as $$
declare c text;
begin
  foreach c in array tg_argv loop
    if (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c) then
      raise exception '%.% is write-once (db/028): it records which code wrote this row', tg_table_name, c;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists portfolio_code_version_write_once on portfolio;
create trigger portfolio_code_version_write_once before update on portfolio
  for each row execute function reject_code_version_change('code_version');
drop trigger if exists trades_v2_code_version_write_once on trades_v2;
create trigger trades_v2_code_version_write_once before update on trades_v2
  for each row execute function reject_code_version_change('code_version', 'sale_code_version');
drop trigger if exists signal_log_code_version_write_once on signal_log;
create trigger signal_log_code_version_write_once before update on signal_log
  for each row execute function reject_code_version_change('code_version');
drop trigger if exists scan_runs_code_version_write_once on scan_runs;
create trigger scan_runs_code_version_write_once before update on scan_runs
  for each row execute function reject_code_version_change('code_version');

grant insert (code_version) on portfolio to anon;
grant insert (code_version, sale_code_version) on trades_v2 to anon;
grant insert (code_version) on signal_log to anon;
grant insert (code_version) on scan_runs to anon;

comment on column portfolio.code_version      is 'Code that recorded the BUY: {app: app.js ?v= stamp as loaded, scoring: SCORING_VERSION int, scoring_hash: formula source hash}. Write-once (trigger). NULL = before db/028. (db/028)';
comment on column trades_v2.code_version      is 'Code that recorded the BUY, copied from the position at sale. Identifies the stored score, components and signal fields. Write-once (trigger). NULL = before db/028. (db/028)';
comment on column trades_v2.sale_code_version is 'Code that recorded the SALE: identifies unified_recommendation_at_sale, URE factors and every sale-time field. Write-once (trigger). NULL = before db/028. (db/028)';
comment on column signal_log.code_version     is 'Code of the scan that logged the row. Replaces build_version, which is uninformative after 2026-09-15. Write-once (trigger). (db/028)';
comment on column scan_runs.code_version      is 'Code of the scan. Replaces build_version, which is uninformative after 2026-09-15. Write-once (trigger). (db/028)';

commit;

-- Verification: ONE query, ONE row. Expected:
--   columns 5 | constraints 5 | triggers 4 | anon_can_insert true | populated 0
select
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and column_name in ('code_version', 'sale_code_version')
      and table_name in ('portfolio', 'trades_v2', 'signal_log', 'scan_runs')
      and data_type = 'jsonb' and is_nullable = 'YES') as columns,
  (select count(*) from pg_constraint where conname like '%code_version_shape_chk') as constraints,
  (select count(*) from pg_trigger where tgname like '%code_version_write_once' and not tgisinternal) as triggers,
  (    has_column_privilege('anon', 'public.portfolio',  'code_version',      'INSERT')
   and has_column_privilege('anon', 'public.trades_v2',  'code_version',      'INSERT')
   and has_column_privilege('anon', 'public.trades_v2',  'sale_code_version', 'INSERT')
   and has_column_privilege('anon', 'public.signal_log', 'code_version',      'INSERT')
   and has_column_privilege('anon', 'public.scan_runs',  'code_version',      'INSERT')) as anon_can_insert,
  (  (select count(*) from portfolio  where code_version is not null)
   + (select count(*) from trades_v2  where code_version is not null or sale_code_version is not null)
   + (select count(*) from signal_log where code_version is not null)
   + (select count(*) from scan_runs  where code_version is not null)) as populated;
