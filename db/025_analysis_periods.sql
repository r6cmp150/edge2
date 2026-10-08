-- analysis_periods: markers, not resets. Roman's literal ask was "reset
-- the counter" after an app change, so a before/after comparison isn't
-- 46 trades of history averaged into one number forever. A RESET -- an
-- UPDATE or DELETE against trade history, or a mutable "period start"
-- field on trades_v2 itself -- was rejected: it's destructive (a mis-tap
-- loses the ability to ever recompute the old grouping), and it can't
-- self-correct (an outcome column that fills in days after a sale, e.g.
-- price_at_plus1_day/price_at_plus2_days, would silently stay attributed
-- to whatever period was "current" at UPDATE time instead of the period
-- the trade actually belongs to).
--
-- A period here is just a NAMED START POINT. Nothing about trades_v2 or
-- signal_log changes. Analytics membership is computed by filtering
-- trades by date against these rows, every time it's displayed -- so a
-- past period's stats recompute correctly as later outcome data arrives,
-- and inserting a bad row (wrong date, typo in the name) costs nothing
-- to work around: insert a correction row, don't touch this one. Same
-- insert-only, append-the-truth posture as setup_triggers (db/013) and
-- for the identical reason -- this table is itself part of the
-- measurement, and a value that can be edited after the fact is a value
-- that can't be trusted when the measurement later says something
-- inconvenient.
--
-- started_at is a TIMESTAMPTZ, not a date -- a period can start mid-
-- session, and trade attribution (app.js, Analytics tab) compares it at
-- PT calendar-day granularity against trades_v2.buy_date (itself a plain
-- date, no time-of-day) via ptDateStr(getPT(...)), not a raw instant
-- comparison -- see CLAUDE.md's getPT()/.toISOString() rule for why a PT-
-- derived Date is only safe for that kind of same-coordinate-system
-- comparison, never mixed with a raw UTC instant compare.
--
-- NO end_at COLUMN, BY DESIGN (explicit instruction): a period's end is
-- derived at query time -- the next period's started_at (ordered by
-- started_at), or "now" for the newest row. Storing both start and a
-- separately-maintained end is exactly the two-fields-that-can-disagree
-- shape this project keeps finding and fixing elsewhere (db/013's own
-- header has the same argument about triggered_at vs a recomputed
-- value). One column, one source of truth; the boundary is a query, not
-- data.
--
-- change_description is NOT NULL with a non-empty check, not just a UI
-- convention -- Roman's own framing ("a period labelled only by its date
-- is worthless in two months") is the reason this column exists at all;
-- a constraint that silently accepted an empty string would let that
-- exact failure back in through any caller that isn't the one screen
-- enforcing it today.
create table if not exists analysis_periods (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  change_description text not null check (length(trim(change_description)) > 0),
  started_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Ordered-by-start-date is the only access pattern (derive current/next
-- boundaries, build the trends table newest-first) -- one index, no
-- per-column indexes nothing queries by alone.
create index if not exists analysis_periods_started_at_idx
  on analysis_periods (started_at);

-- RLS: same fail-closed shape as setup_triggers (db/013) and signal_log
-- -- anon insert + select only. No update, no delete, for any role. A
-- period, once started, is a fact about when a change shipped; nothing
-- ever needs to change it, and the only way to fix a bad row is to add
-- a correcting one, same discipline as every other append-only table in
-- this project.
alter table analysis_periods enable row level security;

drop policy if exists "anon insert" on analysis_periods;
create policy "anon insert" on analysis_periods for insert to anon with check (true);

drop policy if exists "anon select" on analysis_periods;
create policy "anon select" on analysis_periods for select to anon using (true);

-- VERIFICATION PLAN (same shape as db/013's own, and every RLS/append-
-- only migration before it): insert a disposable period row via the
-- anon key, confirm it reads back; attempt an UPDATE and a DELETE on
-- that dummy row -- expect both blocked, confirmed by re-select, not
-- status code; insert a second row with an EARLIER started_at than the
-- first and confirm a started_at-ordered select returns it first,
-- proving the "next period's started_at, or now" end-derivation has a
-- real ordering to work from before any app code depends on it.
