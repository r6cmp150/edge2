-- setup_triggers: one row per real Warrior setup trigger EVENT, superseding
-- signal_log.armed_setup_id (added in db/010 hours earlier, dropped here in
-- the same day it was added, before any real row ever used it).
--
-- Why armed_setup_id couldn't work: signal_log's own dedup key is
-- (signal_date, symbol, engine_source, tier). The replay window setup
-- detection uses is cumulative from pre-market open (evaluateSetupsBatch,
-- engines/warrior/setups.js), so a symbol QUALIFIED at the first scan of the
-- day with nothing yet triggered, then triggering later while still
-- QUALIFIED, would have its later, truer signal_log insert collide on the
-- existing key and be silently discarded -- signal_log is insert-only for
-- anon, on_conflict do nothing. armed_setup_id would record only the FIRST
-- sighting, which is systematically the sighting least likely to have a
-- trigger yet. The measurement could only drift pessimistic, and it would
-- do so silently: weeks of accumulated nulls reading as "Warrior's setups
-- rarely fire" when what actually happened is "we looked too early and
-- signal_log's own key refused to let us look again."
--
-- Fixes this by recording every trigger as its own row instead of folding
-- it into signal_log at all. signal_log's schema, dedup key, and posture
-- are completely unchanged -- tier counts can't double-count because
-- nothing about how tier rows get written changes.
--
-- Two different facts, both kept, not collapsed into one timestamp:
-- triggered_at is when the bar actually fired (a fact about the market,
-- copied from the setup's own triggerTime); scan_session is which run
-- observed it (a fact about us, via the FK to scan_runs). The gap between
-- scan_runs.started_at and triggered_at is observation lag -- recorded as
-- data specifically so "is three scans a day enough coverage" becomes a
-- query instead of a guess.
--
-- LOAD-BEARING, stated explicitly rather than left implicit: triggered_at
-- is last.triggerTime (setups.js:657) -- a BAR timestamp fixed at the
-- moment the classifier fired, not a computed value or a wall-clock read
-- taken at observation time. That's what makes it stable across repeated
-- sightings of the same event: two different scans observing the same
-- still-active trigger both report the identical triggerTime, because
-- both are reading the same historical bar, not re-deriving "when did
-- this happen" from whatever's true at the moment each scan runs. The
-- whole dedup design below depends on that stability -- if triggerTime
-- were ever changed to something computed relative to "now" (elapsed
-- time, a re-scored confidence window, anything derived rather than
-- read), the same real trigger would carry a different value on every
-- sighting, the unique key would never collide, and every re-observation
-- of one event would silently become a new row instead of a duplicate.
-- Check this assumption still holds before changing how setups.js
-- computes triggerTime, not after.
--
-- Dedup key (signal_date, symbol, engine_source, setup_id, triggered_at)
-- gets the re-arm behavior right for free, not via special-casing: the
-- SAME trigger observed by two different scans carries the identical
-- triggered_at (setups.js's detectSetupsForCandidate reports the same
-- trigger's own original timestamp every time it's still the most recent
-- one), so a later scan's insert collides and is discarded -- correct, it's
-- the same event. A genuine re-arm (price retraced past rearmDistancePct
-- and re-triggered) produces a NEW triggered_at, which is a different key,
-- so it gets its own row -- also correct, it's a different event.
create table if not exists setup_triggers (
  id uuid primary key default gen_random_uuid(),
  signal_date date not null,
  symbol text not null,
  engine_source text not null check (engine_source in ('EDGE', 'WARRIOR')),
  setup_id text not null,
  triggered_at timestamptz not null,
  scan_session text not null references scan_runs(id),
  created_at timestamptz not null default now(),
  unique (signal_date, symbol, engine_source, setup_id, triggered_at)
);

create index if not exists setup_triggers_engine_date_idx on setup_triggers (engine_source, signal_date);
create index if not exists setup_triggers_scan_session_idx on setup_triggers (scan_session);

-- RLS: same fail-closed shape as signal_log/scan_runs -- anon insert+select
-- only. No update, no delete, for any role. A trigger event is a fact
-- about the past the moment it's recorded; nothing ever needs to change it.
alter table setup_triggers enable row level security;

drop policy if exists "anon insert" on setup_triggers;
create policy "anon insert" on setup_triggers for insert to anon with check (true);

drop policy if exists "anon select" on setup_triggers;
create policy "anon select" on setup_triggers for select to anon using (true);

-- Drop armed_setup_id from signal_log -- superseded by this table before any
-- real row ever used it (confirmed live: the column holds exactly 33 nulls,
-- all from tonight's write-mechanics verification run, none from a session
-- where a real trigger could have populated it anyway, since that run
-- landed in AH session where setup detection never runs at all). Leaving
-- both would mean two sources for the same fact, one of them known to be
-- biased toward null and also the more convenient flat column -- exactly
-- the shape that produces a wrong number in a report with nobody able to
-- say why it disagrees with the other table.
alter table signal_log drop column if exists armed_setup_id;

-- VERIFICATION PLAN (same shape as every other RLS/dedup pass this
-- project): insert a disposable setup_triggers row via the anon key,
-- confirm it reads back; insert a second row with the SAME
-- (signal_date, symbol, engine_source, setup_id, triggered_at), confirm
-- on_conflict do nothing produces zero new rows rather than an error;
-- insert a third row with the same key except a different triggered_at,
-- confirm it lands as a genuinely new row (the re-arm case); attempt an
-- UPDATE and a DELETE on a dummy row -- expect both blocked, confirmed by
-- re-select, not status code.
