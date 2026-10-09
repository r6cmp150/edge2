-- CORRECTION 2026-10-09: scan 3da6957d is not a scan -- label it FORCED_TEST.
--
-- Warrior scan 3da6957d-84fa-4472-9385-10679dc4e979 was run by hand on
-- Saturday 2026-10-03 at 7:28pm PT with --session=OPEN --write. Its stored
-- session='OPEN' came from the override, not from detection (getMarketStatus,
-- replayed at that instant, returns CLOSED). Its 24 signal_log rows' tiers
-- were computed under a forced open-market rule set on stale Saturday data.
--
-- Not relabelled CLOSED: that would make the label truthful while leaving the
-- tiers artifacts, and put them in phase-8's outside-regular bucket as if they
-- were a real closed-market scan. FORCED_TEST belongs to neither bucket, by
-- construction -- phase-8 rule 1 now defines both buckets as explicit
-- equalities and fails loudly on any unrecognized value (rewritten before
-- this file was written, so the third value can't fall into a negation).
--
-- No reader of the stored session label exists in code today (checked
-- 2026-10-09: the only scan_runs read outside the loggers is the scan gate,
-- on started_at). The loggers can no longer write a forced session at all
-- (scripts/lib/test-override-guard.mjs refuses --write with any override).
--
-- One atomic DO statement (the 29-row correction's lesson): widen the CHECK
-- to admit FORCED_TEST, then update exactly this one row, guarded on its
-- current value. Any surprise -> exception -> nothing applied. The
-- constraint was declared inline in db/010, so its name was generated; it
-- is found by definition, and the block requires exactly one match.
-- Re-selects after it are read-only. Run as ONE paste in the SQL editor.

do $$
declare
  cons text[];
  n int;
begin
  select array_agg(conname) into cons
    from pg_constraint
   where conrelid = 'public.scan_runs'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%session%';
  if coalesce(array_length(cons, 1), 0) <> 1 then
    raise exception 'expected exactly 1 CHECK constraint on scan_runs.session, found % (%) -- nothing applied', coalesce(array_length(cons, 1), 0), cons;
  end if;
  execute format('alter table public.scan_runs drop constraint %I', cons[1]);
  alter table public.scan_runs add constraint scan_runs_session_check
    check (session in ('OPEN', 'PRE', 'AH', 'CLOSED', 'FORCED_TEST'));

  update public.scan_runs
     set session = 'FORCED_TEST'
   where id = '3da6957d-84fa-4472-9385-10679dc4e979'
     and session = 'OPEN'
     and engine_source = 'WARRIOR'
     and scan_date = '2026-10-03';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'expected 1 scan_runs row to change, got % -- nothing applied', n;
  end if;
end $$;

select id, engine_source, scan_date, started_at, session
  from scan_runs
 where id = '3da6957d-84fa-4472-9385-10679dc4e979';

select r.session, count(*) as signal_log_rows
  from signal_log s
  join scan_runs r on r.id = s.scan_session
 where s.scan_session = '3da6957d-84fa-4472-9385-10679dc4e979'
 group by r.session;
