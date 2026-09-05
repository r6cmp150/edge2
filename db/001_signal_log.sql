-- signal_log: every signal SHOWN by either engine, taken or not.
--
-- Dedup key is (signal_date, symbol, engine_source, TIER) -- not just
-- (signal_date, symbol, engine_source) (2026-09-05, corrected before this
-- ever ran). Locking UPDATE out of this table's RLS (see below) means a
-- plain date+symbol+engine key makes tier transitions unrecoverable:
-- whichever tier a symbol is FIRST seen at that day survives forever
-- under `on conflict do nothing`, and that's disproportionately likely to
-- be the least-informative one -- a symbol BLOCKED at 6:30 because a
-- float fetch hadn't resolved yet, then QUALIFIED at 10:00 once it did,
-- would be permanently recorded as BLOCKED, losing exactly the tier that
-- would have led to a trade. Including tier in the key turns that lossy
-- overwrite into an additional TRUE row instead: a symbol that reaches
-- two tiers in one day gets two rows, each real, each with its own
-- first_shown_at. Dedup still collapses repeat scans WITHIN a tier (the
-- common case -- Warrior/EDGE re-scan through the session), no UPDATE is
-- needed anywhere, and analysis takes the best/last tier per symbol-day
-- rather than assuming one row means one opportunity -- record more,
-- filter later, the same rule that's paid off everywhere else here.
--
-- tier is a COLUMN, not a write-time filter: QUALIFIED/NEAR_MISS/BLOCKED
-- for Warrior, EDGE's equivalent label for EDGE. Recording every tier
-- that renders a card, rather than filtering to QUALIFIED-only at write
-- time, keeps the "qualified-only" vs. "everything shown" question
-- answerable later instead of foreclosing it permanently -- Roman can act
-- on a NEAR_MISS or a BLOCKED card just as easily as a QUALIFIED one, and
-- a picking-vs-engine comparison that has no signal row for those trades
-- is broken exactly where it matters most.
--
-- KNOWN SAMPLING LIMITATION, documented here rather than discovered at
-- the 60-day review: this table is written CLIENT-SIDE, only when the app
-- is open and a scan actually renders. It records signals only on days/
-- times Roman has the app open -- which correlates with his own
-- attention and probably with his trading activity. The "control group"
-- this table provides is therefore biased toward days he was already
-- engaged, not a true unbiased sample of every morning's opportunity set.
-- The fix is a server-side scheduled logger (the gate is already
-- runnable from Node -- Alpaca secrets are in Actions, the float table
-- is in the repo, news comes from Alpaca) -- a real follow-on, not part
-- of this phase. Shipping the client-side log first is still the right
-- call: it's most of the value, and it's what's buildable today.
-- NO taken/trade_id columns here (2026-09-05, caught before this table
-- existed): both would be written AFTER insert -- taken flips true and
-- trade_id fills in only once Roman actually buys -- which is an UPDATE,
-- and updates are blocked for every role including anon. As designed
-- those two columns would have been permanently unwritable, silently.
-- The relationship already exists on the other side: trades carries
-- signal_log_id (nullable, for "Own Decision" trades and pre-log
-- backfill that have no signal to point to). "Was this signal taken" is
-- derived by joining from trades on signal_log_id, not stored twice --
-- one source of truth for the link, no new RLS surface on the public
-- anon key, and no denormalised flag that can drift from trades the way
-- the localStorage-versus-Supabase sold-history split (the other half of
-- this phase) already showed drift looks like in this app.
create table if not exists signal_log (
  id uuid primary key default gen_random_uuid(),
  signal_date date not null,
  symbol text not null,
  engine_source text not null check (engine_source in ('EDGE', 'WARRIOR')),
  tier text not null,
  first_shown_at timestamptz not null,
  scan_session text,
  build_version text,
  signal_snapshot jsonb not null,
  reference_price numeric not null,
  ret_5m numeric,
  ret_15m numeric,
  ret_30m numeric,
  ret_close numeric,
  ret_1d numeric,
  ret_3d numeric,
  ret_5d numeric,
  outcomes_filled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (signal_date, symbol, engine_source, tier)
);

create index if not exists signal_log_engine_date_idx on signal_log (engine_source, signal_date);
create index if not exists signal_log_pending_outcomes_idx on signal_log (signal_date)
  where ret_5m is null or ret_15m is null or ret_30m is null or ret_close is null
     or ret_1d is null or ret_3d is null or ret_5d is null;

-- RLS: fail-closed by default. anon gets insert+select only -- a
-- permissive update policy would let anyone who loads the site, using
-- the necessarily-public anon key, rewrite outcome columns and corrupt
-- the exact measurement this table exists to produce (strictly worse
-- than an outsider merely adding noise rows via insert). No update
-- policy exists yet, so updates are blocked for EVERY role, anon
-- included, until a specific, narrowly-scoped update policy is added
-- once the outcome-filling job's own credential is settled -- not
-- service_role, which would bypass RLS entirely for a script that only
-- ever needs to touch this one table's outcome columns.
alter table signal_log enable row level security;

drop policy if exists "anon insert" on signal_log;
create policy "anon insert" on signal_log for insert to anon with check (true);

drop policy if exists "anon select" on signal_log;
create policy "anon select" on signal_log for select to anon using (true);
