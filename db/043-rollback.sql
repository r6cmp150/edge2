-- db/043 ROLLBACK: the undo for db/043. Puts trades_v2_execution_mode_chk back exactly as db/042 left it.
-- IDEMPOTENT: on a database where the constraint is already db/042's, it changes nothing, so it can be run whether
-- or not db/043 ever applied, or twice.
-- GUARDED (three-state: it proceeds only on a definite "nothing would be lost"): it aborts, changing nothing, if any
-- trade carries copied_from_position (db/042's constraint would refuse that row), or if the constraint is neither
-- db/042's nor db/043's exact text. AVAILABLE ONLY UNTIL THE FIRST SALE COPIES A MODE, BY DESIGN: from then on the
-- value is part of the record, and the constraint that permits it is not narrowed silently.
-- Checked in the schema harness: db/043, then this, gives back the same constraint text; run twice, or on a
-- database db/043 never touched, it changes nothing.
begin;

do $$
declare
  n bigint;
  def text;
  applied_042 constant text := $d$CHECK (((execution_mode = ANY (ARRAY['live'::text, 'paper'::text, 'not_known'::text])) AND ((execution_mode = 'not_known'::text) OR (execution_mode_source IS NOT NULL)) AND ((execution_mode_source IS NULL) OR (execution_mode_source = 'recorded_at_trade'::text) OR (execution_mode_source ~ '^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text) OR (execution_mode_source ~ '^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text))))$d$;
  applied_043 constant text := replace(applied_042, $r$(execution_mode_source = 'recorded_at_trade'::text)$r$,
    $r$(execution_mode_source = 'recorded_at_trade'::text) OR (execution_mode_source = 'copied_from_position'::text)$r$);
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.trades_v2'::regclass and conname = 'trades_v2_execution_mode_chk';
  if (def <> applied_042 and def <> applied_043) is not false then
    raise exception 'db/043 ROLLBACK ABORTED, nothing changed: trades_v2_execution_mode_chk is neither db/042''s nor db/043''s. Found: %', coalesce(def, 'NO SUCH CONSTRAINT');
  end if;
  select count(*) into n from trades_v2 where execution_mode_source = 'copied_from_position';
  if (n > 0) is not false then
    raise exception 'db/043 ROLLBACK ABORTED, nothing changed: % trades_v2 rows carry copied_from_position', n;
  end if;
end $$;

alter table trades_v2 drop constraint trades_v2_execution_mode_chk;
alter table trades_v2 add constraint trades_v2_execution_mode_chk check (
  execution_mode in ('live', 'paper', 'not_known')
  and (execution_mode = 'not_known' or execution_mode_source is not null)
  and (execution_mode_source is null
       or execution_mode_source = 'recorded_at_trade'
       or execution_mode_source ~ '^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or execution_mode_source ~ '^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$'));

comment on column trades_v2.execution_mode_source is 'Where execution_mode came from: recorded_at_trade | derived_from_robinhood_export_<date> | declared_by_roman_<date>; NULL with not_known = never established (db/042).';

commit;
