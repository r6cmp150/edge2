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
-- when trigger='schedule' -- workflow_dispatch has no cron to compare
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
  trigger text not null check (trigger in ('schedule', 'workflow_dispatch')),
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

-- RLS: anon insert + update + select. Not the fail-closed posture
-- trades_v2/signal_log use -- there is no financial data here, only
-- operational metadata about whether a cron fired, and the whole
-- mechanism only works if the workflow (running under the public anon
-- key, same as every other scheduled job in this repo) can write both
-- the early "fired" row and the later "outcome" update itself.
alter table workflow_runs enable row level security;

drop policy if exists "anon insert" on workflow_runs;
create policy "anon insert" on workflow_runs for insert to anon with check (true);

drop policy if exists "anon update" on workflow_runs;
create policy "anon update" on workflow_runs for update to anon using (true) with check (true);

drop policy if exists "anon select" on workflow_runs;
create policy "anon select" on workflow_runs for select to anon using (true);
