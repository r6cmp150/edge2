-- db/data-2026-11-20-six-positions-declared-paper.sql -- a DATA correction, not a migration: six portfolio rows from
-- 2026-11-02 recorded execution_mode 'not_known' (bought before EDGE recorded the flag). Roman, 2026-11-20: "These were
-- all paper trades so they are not in robin hood." They become 'paper', with that answer as their recorded source in
-- the shape db/042 already accepts for exactly this: execution_mode_source 'declared_by_roman_2026-11-20'. Never
-- silently: a value corrected without its source is what db/044 removed.
-- ONE TRANSACTION. It changes the six rows in exactly three columns (execution_mode, execution_mode_source, updated_at)
-- and nothing else, or it changes nothing:
--   GUARD (before any write): the six position_ids exist, and all six are 'not_known' with no source, bought 2026-11-02.
--     buy_date holds a CALENDAR DATE stored at 00:00 UTC (all 46 rows in the 2026-11-19 backup), so it is read in UTC:
--     read in Pacific time it is the day before (the schema harness caught exactly that). Otherwise: ABORTED.
--   CHECK (after the write, inside the transaction): all six read back 'paper' / 'declared_by_roman_2026-11-20'; every
--     OTHER portfolio row is byte-identical to before (as jsonb); on the six, every column but those three is identical.
--     Otherwise: ROLLED BACK.
--   The last statement shows the six rows as they now stand: send that table back.
-- The six (the 2026-11-18 list; the 2026-11-19 14:48Z backup has exactly these six not_known, and no others):
--   CLRO 1793633798712, KORU 1793633909422, AAOX 1793633954632, PCT 1793633983466, AXTX 1793634490939,
--   XTIA 1793637556143.
begin;
do $$
declare
  ids constant text[] := array['1793633798712', '1793633909422', '1793633954632', '1793633983466', '1793634490939', '1793637556143'];
  n int;
  others_before text;
  six_before text;
begin
  select count(*) into n from portfolio where position_id = any(ids);
  if n <> 6 then raise exception 'ABORTED, nothing changed: % of the 6 position_ids are in portfolio (sold or never there?)', n; end if;
  select count(*) into n from portfolio where position_id = any(ids)
    and execution_mode = 'not_known' and execution_mode_source is null
    and (buy_date at time zone 'UTC')::date = date '2026-11-02';
  if n <> 6 then raise exception 'ABORTED, nothing changed: only % of the 6 are not_known, unsourced and bought 2026-11-02 (already corrected?)', n; end if;

  select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.position_id), '')) into others_before
    from portfolio p where not (p.position_id = any(ids));
  select md5(string_agg((to_jsonb(p) - 'execution_mode' - 'execution_mode_source' - 'updated_at')::text, '|' order by p.position_id)) into six_before
    from portfolio p where p.position_id = any(ids);

  update portfolio
     set execution_mode = 'paper', execution_mode_source = 'declared_by_roman_2026-11-20', updated_at = now()
   where position_id = any(ids);

  select count(*) into n from portfolio where position_id = any(ids)
    and execution_mode = 'paper' and execution_mode_source = 'declared_by_roman_2026-11-20';
  if n <> 6 then raise exception 'ROLLED BACK: % of the 6 read back paper / declared_by_roman_2026-11-20', n; end if;
  if (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.position_id), '')) from portfolio p where not (p.position_id = any(ids))) <> others_before
    then raise exception 'ROLLED BACK: a row other than the six changed'; end if;
  if (select md5(string_agg((to_jsonb(p) - 'execution_mode' - 'execution_mode_source' - 'updated_at')::text, '|' order by p.position_id)) from portfolio p where p.position_id = any(ids)) <> six_before
    then raise exception 'ROLLED BACK: on the six, a column other than the three changed'; end if;
end $$;
commit;
select position_id, ticker, (buy_date at time zone 'UTC')::date as buy_date, execution_mode, execution_mode_source, updated_at
  from portfolio
 where position_id in ('1793633798712', '1793633909422', '1793633954632', '1793633983466', '1793634490939', '1793637556143')
 order by ticker;
