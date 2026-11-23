-- db/data-2026-11-23-delete-all-open-positions.sql -- a DATA change, not a migration: every open position deleted.
-- Roman, 2026-11-23: "The 48 stocks that I have in my portfolio now are incorrect ... I think we should wipe those".
-- He chose a permanent delete over marking. The live table held 46 rows when exported (48 was the count on the night of
-- 11-17; two were sold since).
-- THE RECORD, COMMITTED BEFORE THIS FILE WAS GENERATED: data/exports/portfolio-2026-11-23-before-delete.json (8fcf7ab),
-- all 46 rows, every column, sha256 954e2bd9af4369bf01e020cf51e55290030d50d9f0c5a26e5a54fe2f01add229.
-- WHAT THIS DOES: deletes those 46 rows from portfolio, and nothing else, in ONE TRANSACTION.
--   GUARD (before any write): portfolio holds exactly 46 rows, and they are exactly the 46 position_ids exported.
--     A row added or removed since the export: ABORTED, nothing changed.
--   It records, before the delete, a fingerprint (row count and an md5 of every row) of EVERY OTHER table in the public
--   schema -- trades_v2 above all, which holds the 586-trade sample.
--   CHECK (after the delete, inside the transaction): exactly 46 rows deleted; portfolio empty; every other table's
--   fingerprint unchanged. Otherwise: ROLLED BACK, nothing changed.
--   The last statement lists what was deleted: all 46 tickers with their cost. That output is itself a record.
-- It does not touch trades_v2: sales already recorded stay exactly as they are.
begin;
drop table if exists deleted_positions; -- a temp table from an earlier run in the same session
create temp table deleted_positions on commit preserve rows as
  select position_id, ticker, (buy_date at time zone 'UTC')::date as buy_date, shares, buy_price,
         round((shares * buy_price)::numeric, 2) as cost, execution_mode
    from portfolio;
do $$
declare
  ids constant text[] := array[
    '1793633798712', '1793633909422', '1793633954632', '1793633983466', '1793634490939', '1793637556143',
    '1794850256174', '1794859198892', '1794927627880', '1794927797667', '1794927950738', '1794927984410',
    '1794928003612', '1794928022197', '1794928043924', '1794929711737', '1794931600204', '1794931618363',
    '1794931669819', '1794934941348', '1794935104122', '1794935183068', '1794937594272', '1794937605000',
    '1794937663154', '1794937681363', '1794937697613', '1794937730945', '1794939326233', '1794939338327',
    '1794939347729', '1794939361264', '1794939370828', '1794939384685', '1794939400226', '1794939411442',
    '1794939420946', '1794939436860', '1794939447053', '1794939459565', '1794939471523', '1794939488912',
    '1794939499873', '1794943269150', '1794943281220', '1794943428975'
  ];
  n int;
  t record;
  fp_before jsonb := '{}'::jsonb;
  fp text;
begin
  select count(*) into n from portfolio;
  if n <> 46 then raise exception 'ABORTED, nothing changed: portfolio holds % rows; the export holds 46 (a row was added or removed since 2026-11-23T20:42Z)', n; end if;
  select count(*) into n from portfolio where position_id = any(ids);
  if n <> 46 then raise exception 'ABORTED, nothing changed: only % of the 46 exported position_ids are in portfolio', n; end if;

  for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'portfolio' order by tablename loop
    execute format('select count(*)::text || '':'' || coalesce(md5(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text)), '''') from public.%I x', t.tablename) into fp;
    fp_before := fp_before || jsonb_build_object(t.tablename, fp);
  end loop;

  delete from portfolio where position_id = any(ids);
  get diagnostics n = row_count;
  if n <> 46 then raise exception 'ROLLED BACK: % rows deleted, expected 46', n; end if;
  if exists (select 1 from portfolio) then raise exception 'ROLLED BACK: portfolio is not empty after the delete'; end if;

  for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'portfolio' order by tablename loop
    execute format('select count(*)::text || '':'' || coalesce(md5(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text)), '''') from public.%I x', t.tablename) into fp;
    if fp is distinct from fp_before->>t.tablename then raise exception 'ROLLED BACK: table % changed during the delete', t.tablename; end if;
  end loop;
end $$;
commit;
select ticker, position_id, buy_date, shares, buy_price, cost, execution_mode,
       (select count(*) from deleted_positions) as positions_deleted,
       (select sum(cost) from deleted_positions) as total_cost
  from deleted_positions
 order by ticker, position_id;
