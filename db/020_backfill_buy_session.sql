-- Phase 9 §1.3 -- one-time DATA UPDATE (not DDL), backfilling buy_session
-- on every existing trades_v2 row from buy_date + buy_time using the SAME
-- four-value classification core/clock.js's classifySession() implements
-- in JS (used by app.js for every buy going forward, from this same
-- commit). The two must produce identical answers on every row; if they
-- ever disagree, one of them is wrong and the verification query at the
-- bottom of this file is what catches it -- not a code read, not an
-- assumption.
--
-- Time windows (Pacific, minutes since midnight), mirrored exactly from
-- classifySession():
--   REGULAR:      390-780   (6:30am-1:00pm PT)
--   PRE_MARKET:    60-390   (1:00am-6:30am PT)
--   AFTER_HOURS:  780-1020  (1:00pm-5:00pm PT)
--   CLOSED:       everything else, and any weekend or holiday regardless
--                 of time -- the holiday list below is copy-identical to
--                 core/clock.js's HOLIDAYS set.
--
-- extract(dow from date) returns 0=Sunday..6=Saturday in Postgres, same
-- encoding as JS's Date.getDay() -- no off-by-one to reconcile between
-- the two implementations.
--
-- ROWS SKIPPED: buy_time is null for zero of the 45 existing trades_v2
-- rows as of this migration, but the WHERE clause still excludes null
-- buy_time on principle -- an unknown time backfills to unknown session,
-- never a guess.
with classified as (
  select
    id,
    case
      when extract(dow from buy_date) in (0, 6) then 'CLOSED'
      when buy_date in (
        '2024-01-01','2024-01-15','2024-02-19','2024-03-29','2024-05-27',
        '2024-06-19','2024-07-04','2024-09-02','2024-11-28','2024-12-25',
        '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26',
        '2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
        '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
        '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'
      ) then 'CLOSED'
      when mins >= 390 and mins < 780 then 'REGULAR'
      when mins >= 60 and mins < 390 then 'PRE_MARKET'
      when mins >= 780 and mins < 1020 then 'AFTER_HOURS'
      else 'CLOSED'
    end as session
  from (
    select id, buy_date,
      (split_part(buy_time, ':', 1)::int * 60 + split_part(buy_time, ':', 2)::int) as mins
    from trades_v2
    where buy_time is not null
  ) with_minutes
)
update trades_v2 t
set buy_session = c.session
from classified c
where t.id = c.id;

-- VERIFICATION (run immediately after, both required by phase-9-entry-
-- exit-spec.md §6 test 5 -- a re-select from the database, not a row
-- count from this statement's own output):
--
--   select buy_session, count(*) from trades_v2 group by 1;
--     -- expect >= 2 distinct non-null values (currently: REGULAR 34,
--     -- AFTER_HOURS 11, confirmed against live data before this file was
--     -- written -- see phase-9-entry-exit-spec.md session notes).
--
--   select ticker, buy_time, buy_session from trades_v2
--     where ticker in ('TENX','KEEL','NEOG');
--     -- expect AFTER_HOURS for all three (TENX 16:25, KEEL 14:06,
--     -- NEOG 14:12 -- all inside the 780-1020 window).
