-- Phase 9 §2.7 (2026-09-15): "GitHub is unreliable" has been an
-- impression since §2.4's 2026-09-14 investigation (log-signals-edge
-- delivered all six firings 2h51m-4h55m late; log-signals-warrior
-- delivered 2 of ~32 expected). One bad Monday is not a measurement.
-- This table turns it into one: a row per firing of every scheduled
-- workflow, including firings that correctly did nothing, so delivery
-- rate is computable instead of guessed.
--
-- DECLARED vs ACTUAL is the whole point. declared_cron is which cron
-- entry github.event.schedule says triggered this run (only meaningful
-- when trigger_type='schedule' -- workflow_dispatch has no cron to compare
-- against). actual_fired_at is captured by the FIRST step in each job,
-- before checkout, before anything that could add its own delay --
-- as close to "GitHub actually started the container" as a step
-- running inside that container can get.
--
-- DROPPED FIRINGS ARE NOT ROWS HERE, BY DEFINITION: a firing GitHub
-- never delivers never runs this step, so it can't log anything. That
-- absence is the signal, not something this table records directly --
-- comparing the declared cron's expected fire times against the rows
-- that exist is how a dropped firing gets inferred, the same
-- absence-vs-zero discipline this project applies everywhere else
-- (scan_runs' market-closed marker, signal_log's three-state ret
-- columns). A query, not a column.
--
-- is_noop / noop_reason are filled by a SECOND step, late in the job
-- (if: always(), so it runs even if the main step failed), reading
-- WORKFLOW_IS_NOOP / WORKFLOW_NOOP_REASON env vars that
-- scripts/lib/workflow-instrumentation.mjs's reportNoop() writes at the
-- exact point each script already self-diagnoses a no-op (found once,
-- console-only, per §2.4; now also persisted). Unset (false/null) is the
-- correct default for a run that actually did its job -- backup-tables
-- and build-float-table have no no-op concept at all and always report
-- real work.
create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_name text not null,
  trigger_type text not null check (trigger_type in ('schedule', 'workflow_dispatch')),
  declared_cron text,
  actual_fired_at timestamptz not null,
  run_url text,
  completed_at timestamptz,
  job_status text,
  is_noop boolean not null default false,
  noop_reason text,
  created_at timestamptz not null default now()
);

create index if not exists workflow_runs_name_time_idx
  on workflow_runs (workflow_name, actual_fired_at);

-- RLS: anon insert + update + select. There is no financial data here,
-- only operational metadata about whether a cron fired, and the whole
-- mechanism only works if the workflow (running under the public anon
-- key, same as every other scheduled job in this repo) can write both
-- the early "fired" row and the later "outcome" update itself.
--
-- BUT UPDATE IS NARROWED TO THE OUTCOME COLUMNS (2026-10-09, before this
-- file was first applied). A table-wide update policy alone would let
-- anything holding the public anon key rewrite actual_fired_at and
-- declared_cron -- the very fields this table exists to measure. An audit
-- log the audited process can rewrite is a weak audit log. Same shape as
-- db/005 / db/019 / db/021: RLS controls WHICH ROWS (the policy below
-- stays using (true)), a column-level GRANT controls WHICH COLUMNS, and
-- REVOKE comes before the narrowing GRANT so a table-wide default grant
-- can't survive underneath it. workflow_name, trigger_type,
-- declared_cron, actual_fired_at and run_url are therefore write-once at
-- insert -- which is what makes the delivery-delay measurement
-- trustworthy. The late "outcome" step PATCHes exactly the four granted
-- columns and nothing else.
--
-- trigger_type, not trigger: trigger is a (non-reserved) Postgres keyword;
-- it works unquoted but reads like DDL when scanning the schema.
--
-- INSERT IS NARROWED TOO, so created_at is always the SERVER's clock.
-- actual_fired_at is self-reported by the audited process and has to be
-- (the workflow is the only thing that knows when it fired). created_at,
-- set by default now() because anon can't supply it, is the only
-- independent corroboration this table will ever have: if the two diverge
-- by more than a few seconds, something is wrong. Column-level insert
-- privilege means an omitted column falls back to its default -- created_at
-- is "not null default now()", so it can never silently become NULL (and
-- if the default were ever dropped, not null makes the insert fail loudly
-- rather than store an absence). anon may insert exactly workflow_name,
-- trigger_type, declared_cron, actual_fired_at, run_url -- the workflows'
-- insert payload, verbatim. id, is_noop and created_at take defaults;
-- the outcome columns arrive later by PATCH.
--
-- VERIFICATION PLAN (run after applying, as anon via the REST API). Same
-- shape as db/019's check B: every refusal is proven BY RE-SELECT, even on
-- a clean 4xx -- a column-grant refusal is a different code path from
-- RLS, and a status code alone has proven nothing in this project more
-- than once. Every check that should fail must be attempted.
--   A. INSERT {workflow_name:'db023-verify', trigger_type:
--      'workflow_dispatch', actual_fired_at:<T>}. Re-select: row exists,
--      created_at within seconds of real now.
--   B. PATCH that row {actual_fired_at:<T - 1 day>}. Expect 42501.
--      Re-select: actual_fired_at still <T>.
--   C. ADVERSARIAL MIXED PATCH: {completed_at, job_status, is_noop,
--      noop_reason, actual_fired_at} in ONE body. Expect 42501 for the
--      WHOLE statement. Re-select: all five unchanged -- including the
--      four permitted columns. A partial application (four landed,
--      actual_fired_at didn't) is a FAIL, and is exactly what a
--      passing-looking test would hide.
--   D. INSERT {workflow_name:'db023-verify', trigger_type:
--      'workflow_dispatch', actual_fired_at:<T>, created_at:
--      '2020-01-01T00:00:00Z'}. Expect 42501. Re-select: no db023-verify
--      row with created_at in 2020.
--   E. PATCH the A row with ONLY the four outcome columns. Re-select: all
--      four changed -- the two-phase write the workflows depend on still
--      works.
--
-- THE db023-verify ROW STAYS (anon has no delete path, by design). It
-- would sit in the delay statistics, so EVERY query computing cron delay
-- from this table filters it:  where workflow_name <> 'db023-verify'
-- Roman can remove it from the SQL editor whenever he likes:
--   delete from workflow_runs where workflow_name = 'db023-verify';
alter table workflow_runs enable row level security;

drop policy if exists "anon insert" on workflow_runs;
create policy "anon insert" on workflow_runs for insert to anon with check (true);

drop policy if exists "anon update" on workflow_runs;
create policy "anon update" on workflow_runs for update to anon using (true) with check (true);

revoke update on workflow_runs from anon;
grant update (completed_at, job_status, is_noop, noop_reason) on workflow_runs to anon;

revoke insert on workflow_runs from anon;
grant insert (workflow_name, trigger_type, declared_cron, actual_fired_at, run_url) on workflow_runs to anon;

drop policy if exists "anon select" on workflow_runs;
create policy "anon select" on workflow_runs for select to anon using (true);
