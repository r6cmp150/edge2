-- db/033 (2026-10-27): the signal each EDGE position was bought on.
-- APPLIED 2026-10-27, verified (all twelve values as expected; portfolio.
-- position_id is text, so the key types match). Phase-10 spec §5, "Store
-- EDGE's full signal object at buy".
--
-- WHY: no EDGE trade can be re-scored for anything bar-derived, because the
-- inputs were never kept (signal_snapshot NULL on all 292 EDGE trades). Every
-- new entry idea would otherwise need a fresh two-month wait instead of a
-- re-run over history.
--
-- WHY A TABLE, NOT portfolio/trades_v2.signal_snapshot: a median EDGE snapshot
-- is 13.7 KB (91% bars) against a 2.8 KB trades_v2 row, and four app reads
-- take trades_v2 with select('*'). On the row, it would add about 150 KB a
-- day (11.2 trades/day) to every Sold-tab load, which no screen displays.
--
-- SEMANTICS, three distinct states:
--   row, snapshot set             = the signal acted on (exactly what was on screen)
--   row, snapshot NULL + absent_reason ('no_signal') = known: no signal behind it
--   no row                        = not captured (before db/033, or the write failed)
-- Write-once by privilege: anon may INSERT and SELECT, never UPDATE or DELETE.
--
-- trades_v2.position_id (added here, found 2026-10-27): trades_v2 had NO
-- position_id column, so a snapshot keyed on position_id could never be
-- joined to its trade once the portfolio row is deleted at the sale. The
-- table would have been write-only. The app writes the position's id at
-- sale from now on. Existing rows: NULL, never guessed. Their link was not
-- recorded, and reconstructing it from ticker + buy_date is exactly the
-- kind of match that the 9 resurrected pairs (one position, two sales)
-- make ambiguous. One position sells once (no partial sales exist), so a
-- UNIQUE index on the non-NULL values makes "one position recorded as two
-- sales" impossible at the database, not just prevented in the client.
--
-- ORDER: apply BEFORE the app writes either.

begin;

create table if not exists signal_snapshot_at_buy (
  position_id   text primary key,
  engine_source text not null,
  captured_at   timestamptz not null default now(),
  code_version  jsonb,
  bars_as_of    date,
  snapshot      jsonb,
  absent_reason text,
  constraint signal_snapshot_at_buy_one_state_chk check (
    (snapshot is not null and absent_reason is null and jsonb_typeof(snapshot) = 'object')
    or (snapshot is null and absent_reason is not null)
  )
);

revoke all on signal_snapshot_at_buy from anon;
grant insert, select on signal_snapshot_at_buy to anon;

comment on table signal_snapshot_at_buy is 'The signal object a position was bought on, captured at the click (or order placement). One row per position_id, never updated. No row = not captured. (db/033)';
comment on column signal_snapshot_at_buy.snapshot is 'Deep copy of the on-screen signal: full scoreStock output incl. bars, thresholdAtBuy, buildVersion, barsAsOf. Same shape as signal_log.signal_snapshot. NULL only with absent_reason.';
comment on column signal_snapshot_at_buy.absent_reason is 'Why there is no snapshot: no_signal (Own Decision buy, or a ticker no longer in the scan). NULL when snapshot is set.';

alter table trades_v2 add column if not exists position_id text;
create unique index if not exists trades_v2_position_id_once on trades_v2 (position_id) where position_id is not null;
grant insert (position_id) on trades_v2 to anon;
comment on column trades_v2.position_id is 'portfolio.position_id of the position this trade closed: the join key to signal_snapshot_at_buy. Unique: one position, one sale. NULL = not recorded (every row before db/033). (db/033)';

commit;

-- Verification: ONE query, ONE row. Expected:
--   table_exists true | anon_insert true | anon_select true | anon_update false | anon_delete false | one_state_check 1 | rows 0
--   | trades_position_id true | position_id_unique 1 | anon_insert_position_id true | trades_with_position_id 0
--   | portfolio_position_id_type text   (if it's not text, STOP: the key types must match before anything is written)
select
  to_regclass('public.signal_snapshot_at_buy') is not null as table_exists,
  has_table_privilege('anon', 'public.signal_snapshot_at_buy', 'INSERT') as anon_insert,
  has_table_privilege('anon', 'public.signal_snapshot_at_buy', 'SELECT') as anon_select,
  has_table_privilege('anon', 'public.signal_snapshot_at_buy', 'UPDATE') as anon_update,
  has_table_privilege('anon', 'public.signal_snapshot_at_buy', 'DELETE') as anon_delete,
  (select count(*) from pg_constraint where conname = 'signal_snapshot_at_buy_one_state_chk') as one_state_check,
  (select count(*) from signal_snapshot_at_buy) as rows,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trades_v2'
          and column_name = 'position_id' and data_type = 'text' and is_nullable = 'YES') as trades_position_id,
  (select count(*) from pg_indexes where indexname = 'trades_v2_position_id_once') as position_id_unique,
  has_column_privilege('anon', 'public.trades_v2', 'position_id', 'INSERT') as anon_insert_position_id,
  (select count(*) from trades_v2 where position_id is not null) as trades_with_position_id,
  (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'portfolio'
          and column_name = 'position_id') as portfolio_position_id_type;
