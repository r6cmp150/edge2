-- db/043 (2026-11-11): a sale's execution mode is copied from its position, and says so. Run 1 of 2. Paste whole;
-- one transaction. After db/042; independent of db/036, db/039 and db/041.
--
-- WHY: a round trip either happened with real money or it did not, so a sale inherits its position's execution
-- mode (the reviewer's ruling, 2026-11-11). Nobody recorded that mode at the sale: it was carried from the portfolio
-- row, which is deleted at the sale. db/042's CHECK on trades_v2 allows three sources (recorded_at_trade,
-- derived_from_robinhood_export_<date>, declared_by_roman_<date>), so the app could not say "copied" and the sale
-- would be refused (SALE_FAILED). Writing recorded_at_trade instead would be a false provenance.
-- A DESIGN MISS IN db/042, recorded as one: its CHECK enumerated the sources for the buy and the later
-- reconciliation, and the sale needed a fourth. Nothing in the repo tied a CHECK's value list to the values the app
-- writes; the enumerated-value guard (tests/enumerated-values.test.js) is the fix for that class.
--
-- WHAT: trades_v2_execution_mode_chk is replaced by the same constraint with exactly ONE more source:
--   copied_from_position   the sale carried its position's mode (any of live / paper / not_known)
-- Nothing else is widened, and portfolio's constraint is untouched (a position's mode is never copied).
--
-- GUARDS (three-state: proceeds only on a definite agreement with the live schema): aborts, changing nothing, unless
-- trades_v2 has exactly one CHECK naming execution_mode_source and its definition is EXACTLY the text the 2026-11-11
-- capture read from the live database (db/042 as applied). Already applied: aborts and says so.
-- Every existing row satisfies the new constraint (it only adds a value), so it validates without touching data.
-- Tested before sending: the 2026-11-11 capture rebuilt in PGlite, run 1 then run 2, the rollback, every guard.
begin;

do $$
declare
  n int;
  def text;
  applied_042 constant text := $d$CHECK (((execution_mode = ANY (ARRAY['live'::text, 'paper'::text, 'not_known'::text])) AND ((execution_mode = 'not_known'::text) OR (execution_mode_source IS NOT NULL)) AND ((execution_mode_source IS NULL) OR (execution_mode_source = 'recorded_at_trade'::text) OR (execution_mode_source ~ '^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text) OR (execution_mode_source ~ '^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text))))$d$;
begin
  select count(*) into n from pg_constraint
   where conrelid = 'public.trades_v2'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%execution_mode_source%';
  if (n <> 1) is not false then
    raise exception 'db/043 ABORTED, nothing changed: trades_v2 has % CHECKs naming execution_mode_source; this plan expects exactly one (db/042''s)', n;
  end if;
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.trades_v2'::regclass and conname = 'trades_v2_execution_mode_chk';
  if (def is null) is not false then
    raise exception 'db/043 ABORTED, nothing changed: trades_v2 has no constraint named trades_v2_execution_mode_chk';
  end if;
  if (def like '%copied_from_position%') is not false then
    raise exception 'db/043 ABORTED, nothing changed: trades_v2_execution_mode_chk already allows copied_from_position (db/043 is applied)';
  end if;
  if (def <> applied_042) is not false then
    raise exception 'db/043 ABORTED, nothing changed: trades_v2_execution_mode_chk is not db/042 as captured on 2026-11-11. Found: %', coalesce(def, 'NO SUCH CONSTRAINT');
  end if;
end $$;

alter table trades_v2 drop constraint trades_v2_execution_mode_chk;
alter table trades_v2 add constraint trades_v2_execution_mode_chk check (
  execution_mode in ('live', 'paper', 'not_known')
  and (execution_mode = 'not_known' or execution_mode_source is not null)
  and (execution_mode_source is null
       or execution_mode_source = 'recorded_at_trade'
       or execution_mode_source = 'copied_from_position'
       or execution_mode_source ~ '^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or execution_mode_source ~ '^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$'));

-- The result, checked before commit: db/042's exact text with the one source added and nothing else. The rollback
-- recognises this same text; if the server spells it any other way this raises and the transaction changes nothing.
do $$
declare
  def text;
  applied_043 constant text := replace(
    $d$CHECK (((execution_mode = ANY (ARRAY['live'::text, 'paper'::text, 'not_known'::text])) AND ((execution_mode = 'not_known'::text) OR (execution_mode_source IS NOT NULL)) AND ((execution_mode_source IS NULL) OR (execution_mode_source = 'recorded_at_trade'::text) OR (execution_mode_source ~ '^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text) OR (execution_mode_source ~ '^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text))))$d$,
    $r$(execution_mode_source = 'recorded_at_trade'::text)$r$,
    $r$(execution_mode_source = 'recorded_at_trade'::text) OR (execution_mode_source = 'copied_from_position'::text)$r$);
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.trades_v2'::regclass and conname = 'trades_v2_execution_mode_chk';
  if (def <> applied_043) is not false then
    raise exception 'db/043 ABORTED, nothing changed: the new constraint reads back as %, not the expected text', coalesce(def, 'NO SUCH CONSTRAINT');
  end if;
end $$;

comment on column trades_v2.execution_mode_source is 'Where execution_mode came from: recorded_at_trade | copied_from_position (the sale carried its position''s mode, db/043) | derived_from_robinhood_export_<date> | declared_by_roman_<date>; NULL with not_known = never established (db/042).';

commit;
