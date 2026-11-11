-- SUPABASE WILL SAY "Failed to run sql query" FOR A PASS. This file ends by raising an error ON PURPOSE, so
-- that everything it tried is rolled back. The result is the "RESULT:" line inside that error message: read it,
-- not the red label.
-- db/042 run 2 of 2: behaviour, after run 1. Writes nothing. Each row probe copies an existing row with the
-- execution mode changed: a refused combination stops at the CHECK (23514); an accepted one collides with the
-- key it copied (23505). The last trades_v2 probe drops both new fields, as the deployed app's insert does today,
-- and must be accepted (the DEFAULT fills not_known). Then settings' rule, the log table's privileges, and the
-- state of every existing row. Ends in a red error ON PURPOSE. Expected:
-- "db/042 run 2 RESULT: PASS | existing rows not not_known: 0 | refused 5 of 5: ... | passed 6 of 6: ... |
--  settings: ok | log privileges: ok | wrong: none."
do $$
declare
  probes constant jsonb := jsonb_build_array(
    -- [table, execution_mode (null = omit both fields), execution_mode_source, expected, label]
    jsonb_build_array('trades_v2', 'BOGUS', null, 'check', 'trades_v2: an unknown mode'),
    jsonb_build_array('trades_v2', 'live', null, 'check', 'trades_v2: live with no source'),
    jsonb_build_array('trades_v2', 'paper', 'guessed_from_prices', 'check', 'trades_v2: paper from an unlisted source'),
    jsonb_build_array('portfolio', 'live', null, 'check', 'portfolio: live with no source'),
    jsonb_build_array('portfolio', 'paper', 'declared_by_roman', 'check', 'portfolio: a declaration with no date'),
    jsonb_build_array('trades_v2', 'paper', 'recorded_at_trade', 'key', 'trades_v2: paper, recorded at the trade'),
    jsonb_build_array('trades_v2', 'live', 'derived_from_robinhood_export_2026-11-12', 'key', 'trades_v2: live, from an export'),
    jsonb_build_array('trades_v2', 'not_known', 'derived_from_robinhood_export_2026-11-12', 'key', 'trades_v2: not_known, an ambiguous export match'),
    jsonb_build_array('trades_v2', 'not_known', null, 'key', 'trades_v2: not_known, never established'),
    jsonb_build_array('portfolio', 'paper', 'declared_by_roman_2026-11-11', 'key', 'portfolio: paper, declared'),
    jsonb_build_array('trades_v2', null, null, 'key', 'trades_v2: neither field, as the deployed app writes'));
  p jsonb;
  src jsonb;
  outcome text;
  refused text := ''; passed text := ''; wrong text := '';
  nr int := 0; np int := 0;
  not_unknown bigint;
  settings_result text := '';
  log_result text := '';
begin
  select (select count(*) from trades_v2 where execution_mode <> 'not_known' or execution_mode_source is not null)
       + (select count(*) from portfolio where execution_mode <> 'not_known' or execution_mode_source is not null) into not_unknown;
  for p in select * from jsonb_array_elements(probes) loop
    execute format('select to_jsonb(r) from %I r limit 1', p ->> 0) into src;
    if (src is null) is not false then wrong := wrong || format(' [%s: no row to copy, NOT TESTED]', p ->> 4); continue; end if;
    src := case when jsonb_typeof(p -> 1) = 'null' then src - 'execution_mode' - 'execution_mode_source'
                else jsonb_set(jsonb_set(src, '{execution_mode}', p -> 1), '{execution_mode_source}', p -> 2) end;
    begin
      if jsonb_typeof(p -> 1) = 'null' then
        -- omit the two fields entirely, the way an insert that doesn't name them does
        execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)',
          p ->> 0,
          (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(src) k),
          (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(src) k),
          p ->> 0) using src;
      else
        execute format('insert into %I select (jsonb_populate_record(null::%I, $1)).*', p ->> 0, p ->> 0) using src;
      end if;
      outcome := 'INSERTED';
    exception
      when not_null_violation then outcome := 'not_null';
      when check_violation then outcome := 'check';
      when unique_violation then outcome := 'key';
      when others then outcome := 'other: ' || sqlstate || ' ' || sqlerrm;
    end;
    if outcome = p ->> 3 and outcome = 'key' then np := np + 1; passed := passed || ' ' || (p ->> 4) || ';';
    elsif outcome = p ->> 3 then nr := nr + 1; refused := refused || ' ' || (p ->> 4) || ' (' || outcome || ');';
    else wrong := wrong || format(' [%s: expected %s, got %s]', p ->> 4, p ->> 3, outcome);
    end if;
  end loop;

  -- settings: a mode needs its instant; an unknown mode is refused; unset is allowed.
  begin update settings set execution_mode = 'paper', execution_mode_set_at = null; settings_result := settings_result || ' paper without an instant ACCEPTED;';
  exception when check_violation then null; end;
  begin update settings set execution_mode = 'BOGUS', execution_mode_set_at = now(); settings_result := settings_result || ' an unknown mode ACCEPTED;';
  exception when check_violation then null; end;
  begin update settings set execution_mode = 'live', execution_mode_set_at = now();
  exception when others then settings_result := settings_result || ' live with an instant REFUSED: ' || sqlerrm || ';'; end;
  if (select execution_mode from settings limit 1) is distinct from 'live' then settings_result := settings_result || ' the accepted update did not hold;'; end if;

  -- the log: anon may insert and read, never change or remove; authenticated holds nothing.
  if not has_table_privilege('anon', 'execution_mode_changes', 'INSERT') then log_result := log_result || ' anon cannot INSERT;'; end if;
  if not has_table_privilege('anon', 'execution_mode_changes', 'SELECT') then log_result := log_result || ' anon cannot SELECT;'; end if;
  if has_table_privilege('anon', 'execution_mode_changes', 'UPDATE') then log_result := log_result || ' anon can UPDATE;'; end if;
  if has_table_privilege('anon', 'execution_mode_changes', 'DELETE') then log_result := log_result || ' anon can DELETE;'; end if;
  if has_table_privilege('anon', 'execution_mode_changes', 'TRUNCATE') then log_result := log_result || ' anon can TRUNCATE;'; end if;
  if has_table_privilege('authenticated', 'execution_mode_changes', 'SELECT,INSERT,UPDATE,DELETE') then log_result := log_result || ' authenticated holds a privilege;'; end if;
  if (select relrowsecurity from pg_class where oid = 'public.execution_mode_changes'::regclass) is not true then log_result := log_result || ' RLS is off;'; end if;

  raise exception 'db/042 run 2 RESULT: % | existing rows not not_known: % | refused % of 5:% | passed % of 6:% | settings: % | log privileges: % | wrong:%. This message is raised on purpose so everything rolls back: nothing was written.',
    case when wrong = '' and nr = 5 and np = 6 and not_unknown = 0 and settings_result = '' and log_result = '' then 'PASS' else 'FAIL' end,
    not_unknown, nr, refused, np, passed,
    case when settings_result = '' then 'ok' else settings_result end,
    case when log_result = '' then 'ok' else log_result end,
    case when wrong = '' then ' none' else wrong end;
end $$;
