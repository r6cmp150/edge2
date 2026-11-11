-- db/042 ROLLBACK: the undo for db/042. Puts the schema back exactly as it was before db/042.
-- IDEMPOTENT: every step is "if exists", so it can be run whether or not db/042 ever applied, or twice; on a database
-- db/042 never touched it changes nothing.
-- GUARDED (three-state: it proceeds only on a definite "nothing would be lost"): it aborts, changing nothing, if any
-- trade or position holds a mode other than not_known or any source, if settings holds a mode, or if the change log
-- has a row. AVAILABLE ONLY UNTIL THE FIRST MODE IS RECORDED, BY DESIGN: from then on these columns are the only record
-- of whether a trade happened, and they are not dropped silently.
-- Checked in the schema harness: db/042, then this, gives back the same columns, constraints, tables and grants; run
-- on an unchanged database, or twice, it changes nothing.
begin;

do $$
declare
  n bigint;
begin
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trades_v2' and column_name = 'execution_mode')) is not false then
    execute $q$select count(*) from trades_v2 where execution_mode <> 'not_known' or execution_mode_source is not null$q$ into n;
    if (n > 0) is not false then raise exception 'db/042 ROLLBACK ABORTED, nothing changed: % trades_v2 rows carry a recorded or derived mode', n; end if;
  end if;
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'portfolio' and column_name = 'execution_mode')) is not false then
    execute $q$select count(*) from portfolio where execution_mode <> 'not_known' or execution_mode_source is not null$q$ into n;
    if (n > 0) is not false then raise exception 'db/042 ROLLBACK ABORTED, nothing changed: % portfolio rows carry a recorded or derived mode', n; end if;
  end if;
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'settings' and column_name = 'execution_mode')) is not false then
    execute $q$select count(*) from settings where execution_mode is not null$q$ into n;
    if (n > 0) is not false then raise exception 'db/042 ROLLBACK ABORTED, nothing changed: settings holds a mode'; end if;
  end if;
  if (to_regclass('public.execution_mode_changes') is not null) is not false then
    execute $q$select count(*) from execution_mode_changes$q$ into n;
    if (n > 0) is not false then raise exception 'db/042 ROLLBACK ABORTED, nothing changed: the change log has % rows', n; end if;
  end if;
end $$;

drop table if exists execution_mode_changes;
alter table settings drop constraint if exists settings_execution_mode_chk;
alter table settings drop column if exists execution_mode_set_at, drop column if exists execution_mode;
alter table portfolio drop constraint if exists portfolio_execution_mode_chk;
alter table portfolio drop column if exists execution_mode_source, drop column if exists execution_mode;
alter table trades_v2 drop constraint if exists trades_v2_execution_mode_chk;
alter table trades_v2 drop column if exists execution_mode_source, drop column if exists execution_mode;

commit;
