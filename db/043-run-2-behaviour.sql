-- SUPABASE WILL SAY "Failed to run sql query" FOR A PASS. This file ends by raising an error ON PURPOSE, so
-- that everything it tried is rolled back. The result is the "RESULT:" line inside that error message: read it,
-- not the red label.
-- db/043 run 2 of 2: behaviour, after run 1. Writes nothing. Each row probe copies an existing row with the
-- execution mode changed: a refused combination stops at the CHECK (23514); an accepted one collides with the key
-- it copied (23505). The new source must pass on trades_v2 with every mode; a lookalike, an unlisted source and
-- portfolio (never widened) must still be refused; every source db/042 allowed must still pass, and so must the
-- deployed app's insert, which names neither field. Ends in a red error ON PURPOSE. Expected:
-- "db/043 run 2 RESULT: PASS | rows already copied: 0 | refused 5 of 5: ... | passed 8 of 8: ... | wrong: none."
do $$
declare
  probes constant jsonb := jsonb_build_array(
    -- [table, execution_mode (null = omit both fields), execution_mode_source, expected, label]
    jsonb_build_array('trades_v2', 'paper', 'copied_from_positions', 'check', 'trades_v2: a lookalike of the new source'),
    jsonb_build_array('trades_v2', 'paper', 'copied', 'check', 'trades_v2: a prefix of the new source'),
    jsonb_build_array('trades_v2', 'paper', 'guessed_from_prices', 'check', 'trades_v2: paper from an unlisted source'),
    jsonb_build_array('trades_v2', 'live', null, 'check', 'trades_v2: live with no source'),
    jsonb_build_array('portfolio', 'paper', 'copied_from_position', 'check', 'portfolio: the new source (not widened)'),
    jsonb_build_array('trades_v2', 'live', 'copied_from_position', 'key', 'trades_v2: live, copied from the position'),
    jsonb_build_array('trades_v2', 'paper', 'copied_from_position', 'key', 'trades_v2: paper, copied from the position'),
    jsonb_build_array('trades_v2', 'not_known', 'copied_from_position', 'key', 'trades_v2: not_known, copied from the position'),
    jsonb_build_array('trades_v2', 'paper', 'recorded_at_trade', 'key', 'trades_v2: paper, recorded at the trade'),
    jsonb_build_array('trades_v2', 'live', 'derived_from_robinhood_export_2026-11-12', 'key', 'trades_v2: live, from an export'),
    jsonb_build_array('trades_v2', 'paper', 'declared_by_roman_2026-11-11', 'key', 'trades_v2: paper, declared'),
    jsonb_build_array('trades_v2', 'not_known', null, 'key', 'trades_v2: not_known, never established'),
    jsonb_build_array('trades_v2', null, null, 'key', 'trades_v2: neither field, as the deployed app writes'));
  p jsonb;
  src jsonb;
  outcome text;
  refused text := ''; passed text := ''; wrong text := '';
  nr int := 0; np int := 0;
  copied bigint;
begin
  select count(*) into copied from trades_v2 where execution_mode_source = 'copied_from_position';
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

  raise exception 'db/043 run 2 RESULT: % | rows already copied: % | refused % of 5:% | passed % of 8:% | wrong:%. This message is raised on purpose so everything rolls back: nothing was written.',
    case when wrong = '' and nr = 5 and np = 8 and copied = 0 then 'PASS' else 'FAIL' end,
    copied, nr, refused, np, passed,
    case when wrong = '' then ' none' else wrong end;
end $$;
