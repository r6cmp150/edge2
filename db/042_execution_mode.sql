-- db/042 (2026-11-11): whether a trade happened. Run 1 of 2. Paste whole; one transaction. Independent of
-- db/038, db/039 and db/041; tested after db/040.
--
-- WHY: nothing in the record says whether a trade was placed at the broker. Roman paper-traded for part of the
-- book (his statement, 2026-11-11: "some real, some paper, not sure which"), and trades_v2 reads exactly like a
-- book of real executions. So every trade carries an execution mode, three states:
--   live       placed at the broker
--   paper      recorded in EDGE only
--   not_known  not recorded at the trade, and not since established
-- and where the mode came from:
--   recorded_at_trade                          the app wrote it at the moment of the trade (Settings toggle)
--   derived_from_robinhood_export_YYYY-MM-DD   matched (or not) against a broker export of that date
--   declared_by_roman_YYYY-MM-DD               his testimony, labelled as such
-- live and paper always name a source; not_known may (an export that matched ambiguously) or may not.
--
-- EXISTING ROWS become not_known with no source, by the column DEFAULT. That default is the true value for a row
-- nobody recorded a mode for, never paper or live, and it keeps the deployed app's writes working until the app
-- that sends the mode explicitly ships (main stays deployable). Rows move off not_known only by the export,
-- labelled as derived, never by inference from price behaviour.
--
-- settings.execution_mode is the toggle: NULL until Roman sets it (the form will refuse to record while unset),
-- with the instant it was last set. execution_mode_changes logs every change, insert-only for the app.
--
-- GUARDS: aborts, changing nothing, unless none of these columns or the log table exist yet, and settings has
-- exactly one row. Tested before sending: the reconstructed live schema in PGlite, after db/040, run 1 then run 2.
begin;

do $$
declare
  n bigint;
  present text;
begin
  select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name) into present
    from information_schema.columns
   where table_schema = 'public'
     and ((table_name in ('trades_v2', 'portfolio') and column_name in ('execution_mode', 'execution_mode_source'))
       or (table_name = 'settings' and column_name in ('execution_mode', 'execution_mode_set_at')));
  if (present is not null) is not false then
    raise exception 'db/042 ABORTED, nothing changed: already present: %', present;
  end if;
  if (to_regclass('public.execution_mode_changes') is not null) is not false then
    raise exception 'db/042 ABORTED, nothing changed: table execution_mode_changes already exists';
  end if;
  select count(*) into n from settings;
  if (n <> 1) is not false then raise exception 'db/042 ABORTED, nothing changed: settings has % rows; this plan assumes exactly one', n; end if;
end $$;

alter table trades_v2
  add column execution_mode text not null default 'not_known',
  add column execution_mode_source text;
alter table portfolio
  add column execution_mode text not null default 'not_known',
  add column execution_mode_source text;

alter table trades_v2 add constraint trades_v2_execution_mode_chk check (
  execution_mode in ('live', 'paper', 'not_known')
  and (execution_mode = 'not_known' or execution_mode_source is not null)
  and (execution_mode_source is null
       or execution_mode_source = 'recorded_at_trade'
       or execution_mode_source ~ '^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or execution_mode_source ~ '^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$'));
alter table portfolio add constraint portfolio_execution_mode_chk check (
  execution_mode in ('live', 'paper', 'not_known')
  and (execution_mode = 'not_known' or execution_mode_source is not null)
  and (execution_mode_source is null
       or execution_mode_source = 'recorded_at_trade'
       or execution_mode_source ~ '^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or execution_mode_source ~ '^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$'));

alter table settings
  add column execution_mode text,
  add column execution_mode_set_at timestamptz;
alter table settings add constraint settings_execution_mode_chk check (
  (execution_mode is null and execution_mode_set_at is null)
  or (execution_mode in ('live', 'paper') and execution_mode_set_at is not null));

create table execution_mode_changes (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null,               -- the phone's instant of the change
  recorded_at timestamptz not null default now(),
  from_mode text check (from_mode in ('live', 'paper')),  -- NULL: the first time it was set
  to_mode text not null check (to_mode in ('live', 'paper'))
);
alter table execution_mode_changes enable row level security;
revoke all on execution_mode_changes from anon, authenticated;
grant select, insert on execution_mode_changes to anon;
create policy "anon insert" on execution_mode_changes for insert to anon with check (true);
create policy "anon select" on execution_mode_changes for select to anon using (true);

comment on column trades_v2.execution_mode is 'Whether the trade was placed at the broker: live | paper | not_known (db/042). Never set from price behaviour. A not_known row created BEFORE db/042 was applied is a trade nobody recorded a mode for; one created AFTER it is a client that did not send one (a stale phone, a missed path, a bug), a defect counted daily and expected to be zero. The two are told apart by created_at against db/042''s apply moment: derivable, not a missing state, so no fourth value.';
comment on column trades_v2.execution_mode_source is 'Where execution_mode came from: recorded_at_trade | derived_from_robinhood_export_<date> | declared_by_roman_<date>; NULL with not_known = never established (db/042).';
comment on column portfolio.execution_mode is 'As trades_v2.execution_mode, recorded at the buy and carried to the sale (db/042). A not_known row created after db/042 was applied is a client that did not send one: a defect, told apart by created_at.';
comment on column settings.execution_mode is 'The toggle the app records each trade under: live | paper; NULL = not set, and the app refuses to record a trade (db/042).';
comment on table execution_mode_changes is 'Every change of settings.execution_mode, insert-only for the app (db/042).';

commit;
