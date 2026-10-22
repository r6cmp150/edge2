-- db/030 (2026-10-22): which kind of trigger started each logger scan.
--
-- WHY: a hand-dispatched scan is indistinguishable in scan_runs and
-- signal_log from a scheduled one. The only place the distinction existed
-- was workflow_runs.trigger_type, so every delivery-rate, scans-per-day and
-- time-of-day analysis silently included dispatched runs unless someone
-- remembered a session id. Found on 2026-10-22: a dispatch sent after the
-- close wrote a real after-hours scan (scan_runs 02ea89f6-..., 27 signal_log
-- rows). Those rows are honest (a real AH scan, labelled AH), and they need
-- no FORCED_TEST-style marker. But they must be EXCLUDABLE BY CONSTRUCTION.
--
-- SEMANTICS:
--   trigger_type = github.event_name of the run that wrote the row
--                  ('schedule', 'workflow_dispatch', ...), or 'local' when
--                  the logger ran outside GitHub Actions. Written once, at
--                  insert, by the logger.
--   NULL         = a scan recorded before this column existed. Not
--                  backfilled: scan_runs has no run id to join
--                  workflow_runs on, and a time-window join is a guess.
--                  Known dispatched scans before db/030: 179f9c12-6646-...
--                  (2026-10-22 16:57 UTC, regular session) and 02ea89f6-c321-...
--                  (2026-10-22 22:17 UTC, after hours).
--
-- NO CHECK on the values, deliberately, as in db/023: an unexpected trigger
-- name (a future repository_dispatch) must never make a scan's insert fail.
-- The observer must not break the observed.
--
-- Write-once, like code_version (db/028): the same trigger function, on its
-- own trigger.
--
-- ORDER: apply this BEFORE the logger change that writes trigger_type. The
-- logger's assertColumnsExist reads the scan_runs row's keys and would abort
-- the whole run on a missing column.

begin;

alter table scan_runs add column if not exists trigger_type text;

drop trigger if exists scan_runs_trigger_type_write_once on scan_runs;
create trigger scan_runs_trigger_type_write_once before update on scan_runs
  for each row execute function reject_code_version_change('trigger_type');

grant insert (trigger_type) on scan_runs to anon;

comment on column scan_runs.trigger_type is 'github.event_name of the run that wrote this scan (schedule, workflow_dispatch, ...), or local outside Actions. Write-once (trigger). NULL = before db/030. No CHECK on values, by design. (db/030)';

commit;

-- Verification: ONE query, ONE row. Expected:
--   columns 1 | triggers 1 | anon_can_insert true | populated 0
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'scan_runs'
      and column_name = 'trigger_type' and data_type = 'text' and is_nullable = 'YES') as columns,
  (select count(*) from pg_trigger where tgname = 'scan_runs_trigger_type_write_once' and not tgisinternal) as triggers,
  has_column_privilege('anon', 'public.scan_runs', 'trigger_type', 'INSERT') as anon_can_insert,
  (select count(*) from scan_runs where trigger_type is not null) as populated;
