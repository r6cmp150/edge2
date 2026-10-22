-- db/031 (2026-10-22): the as-of date of the price history each signal was
-- scored on.
--
-- WHY: 30 of 676 logged EDGE snapshots (4.4%) were scored on daily-bar
-- histories 4+ weekdays stale; AREN was scored from 2026-09-15 to 10-14 on
-- bars ending 2026-08-28. Nothing marked it, so each was a score presented
-- as current, computed on month-old data, and it sits in the dataset every
-- analysis this week has used. The date is known at scoring time, so
-- recording it is cheap, and it makes a stale-bar signal identifiable
-- instead of invisible (phase-10 spec §7.6, ahead of the step 1f gate).
--
-- SEMANTICS:
--   signal_log.bars_as_of      = date of the newest daily bar in the history
--                                the signal was scored on (today's partial
--                                bar, or an earlier day's).
--   portfolio.bars_as_of_at_buy / trades_v2.bars_as_of_at_buy
--                              = the same date for the signal a position was
--                                bought on, carried from buy to sale.
--   NULL = not recorded (before db/031, or no signal at buy, e.g. Warrior).
--
-- BACKFILL, signal_log only, and EXACT: each row's own stored
-- signal_snapshot.bars gives its newest bar date, taken as the MAXIMUM bar
-- date, not the last array element. core/clock.js barsFreshness() doesn't
-- trust array order, and the backfill must derive the same value the code
-- maintains from here on. That's a stored fact
-- read back, not a guess. Rows without stored bars stay NULL. Trades have
-- no stored bars, so they are not backfilled.
--
-- No CHECK, no trigger: a date column written at insert. portfolio's
-- update path resends the value it read back (core/store.js maps it both
-- ways), so a background save never nulls it.
--
-- ORDER: apply BEFORE the logger change that writes bars_as_of
-- (assertColumnsExist lists signal_log's columns and aborts on a missing
-- one) and before the app writes bars_as_of_at_buy.

begin;

alter table signal_log add column if not exists bars_as_of date;
alter table portfolio  add column if not exists bars_as_of_at_buy date;
alter table trades_v2  add column if not exists bars_as_of_at_buy date;

grant insert (bars_as_of) on signal_log to anon;
grant insert (bars_as_of_at_buy) on portfolio to anon;
grant update (bars_as_of_at_buy) on portfolio to anon;
grant insert (bars_as_of_at_buy) on trades_v2 to anon;

update signal_log
   set bars_as_of = (select max(left(b ->> 't', 10)::date)
                       from jsonb_array_elements(signal_snapshot -> 'bars') b)
 where bars_as_of is null
   and jsonb_typeof(signal_snapshot -> 'bars') = 'array'
   and jsonb_array_length(signal_snapshot -> 'bars') > 0;

comment on column signal_log.bars_as_of     is 'Date of the newest daily bar in the history this signal was scored on. Backfilled exactly from signal_snapshot.bars where present. NULL = unknown. (db/031)';
comment on column portfolio.bars_as_of_at_buy is 'bars_as_of of the signal this position was bought on. NULL = not recorded. (db/031)';
comment on column trades_v2.bars_as_of_at_buy is 'bars_as_of of the signal this trade was bought on, carried from the position. NULL = not recorded. (db/031)';

commit;

-- Verification: ONE query, ONE row. Expected:
--   columns 3 | anon_can_write true | backfilled > 0 | stale_4plus_weekdays: a count
--   stale_4plus_weekdays counts WEEKDAYS (holidays ignored) between the newest
--   bar and the signal date, at 4 or more. It is NOT the finding's definition
--   (32 signals at more than one TRADING day), and it is NOT expected to equal
--   32; it's a coarse sanity count and nothing more. The trading-day figure
--   comes from tests/bars-freshness.test.js on the pinned backup.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and ((table_name = 'signal_log' and column_name = 'bars_as_of')
        or (table_name in ('portfolio', 'trades_v2') and column_name = 'bars_as_of_at_buy'))
      and data_type = 'date' and is_nullable = 'YES') as columns,
  (    has_column_privilege('anon', 'public.signal_log', 'bars_as_of', 'INSERT')
   and has_column_privilege('anon', 'public.portfolio', 'bars_as_of_at_buy', 'INSERT')
   and has_column_privilege('anon', 'public.portfolio', 'bars_as_of_at_buy', 'UPDATE')
   and has_column_privilege('anon', 'public.trades_v2', 'bars_as_of_at_buy', 'INSERT')) as anon_can_write,
  (select count(*) from signal_log where bars_as_of is not null) as backfilled,
  (select count(*) from signal_log
    where engine_source = 'EDGE' and bars_as_of is not null and signal_date <= '2026-10-21'
      and (select count(*) from generate_series(bars_as_of + 1, signal_date, interval '1 day') g
            where extract(isodow from g) < 6) >= 4) as stale_4plus_weekdays;
