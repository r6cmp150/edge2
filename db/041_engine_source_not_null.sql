-- db/041 (2026-11-05): engine_source is never NULL. Run 1 of 2. Paste whole; one transaction. Run after db/040.
--
-- WHY: two trades_v2 rows have engine_source NULL: EGHT (bought 2026-09-04) and CMPX (2026-09-02), both created
-- 2026-09-09 within three minutes, a hand re-entry that skipped the field. No migration ever said NULL was allowed
-- there. They are EDGE by elimination, not assumption: Warrior has never been traded (no trades_v2 row says
-- WARRIOR), and the app already reads a missing engine as EDGE, so writing EDGE makes the record say what the app
-- believes. NOT NULL then stops a future row that every per-engine figure would silently drop or miscount.
--
-- portfolio too: a sale copies its engine from the position, and positions load only from portfolio. With
-- trades_v2 NOT NULL and portfolio still allowing NULL, a NULL position would make recording its sale FAIL,
-- which is a gate on recording (spec §7.7). portfolio has no NULL rows, so it needs no backfill.
--
-- GUARDS: aborts, changing nothing, unless trades_v2's NULL rows are exactly those two, portfolio has none, no
-- trades_v2 row is WARRIOR, and both CHECKs are db/012's as live on 2026-11-05.
-- Tested before sending: reconstructed live schema in PGlite, after db/040, run 1 then run 2.
begin;

do $$
declare
  nulls text;
  n bigint;
  def text;
begin
  select string_agg(ticker || ' ' || buy_date::text, ', ' order by ticker) into nulls from trades_v2 where engine_source is null;
  if (nulls is distinct from 'CMPX 2026-09-02, EGHT 2026-09-04') is not false then
    raise exception 'db/041 ABORTED, nothing changed: trades_v2 rows with no engine are [%], not exactly CMPX 2026-09-02 and EGHT 2026-09-04', coalesce(nulls, 'none');
  end if;
  select count(*) into n from portfolio where engine_source is null;
  if (n > 0) is not false then raise exception 'db/041 ABORTED, nothing changed: % portfolio rows have no engine; this plan assumed none', n; end if;
  select count(*) into n from trades_v2 where engine_source = 'WARRIOR';
  if (n > 0) is not false then raise exception 'db/041 ABORTED, nothing changed: % trades_v2 rows are WARRIOR, so "EDGE by elimination" no longer holds', n; end if;
  for def in select pg_get_constraintdef(oid) from pg_constraint
              where conname in ('trades_v2_engine_source_check', 'portfolio_engine_source_check') loop
    if (def is distinct from $c$CHECK ((engine_source = ANY (ARRAY['EDGE'::text, 'WARRIOR'::text])))$c$) is not false then
      raise exception 'db/041 ABORTED, nothing changed: an engine_source CHECK is not db/012''s: %', def;
    end if;
  end loop;
  if ((select count(*) from pg_constraint where conname in ('trades_v2_engine_source_check', 'portfolio_engine_source_check')) <> 2) is not false then
    raise exception 'db/041 ABORTED, nothing changed: expected both engine_source CHECKs';
  end if;
end $$;

update trades_v2 set engine_source = 'EDGE' where engine_source is null; -- exactly the two rows the guard named
alter table trades_v2 alter column engine_source set not null;
alter table portfolio alter column engine_source set not null;
comment on column trades_v2.engine_source is 'Which engine the trade was taken under. NOT NULL since db/041; EGHT and CMPX (re-entered 2026-09-09 without it) were set to EDGE by elimination: no Warrior trade existed.';

commit;
