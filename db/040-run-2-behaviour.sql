-- SUPABASE WILL SAY "Failed to run sql query" FOR A PASS. This file ends by raising an error ON PURPOSE, so
-- that everything it tried is rolled back. The result is the "RESULT:" line inside that error message: read it,
-- not the red label. (Read three times as a failure: db/035, db/040, db/037.)
-- db/040 run 2 of 2: behaviour, after run 1. Writes nothing: every probe copies an existing row with one column
-- changed. A CHECK is evaluated before the primary key, so a refused value stops at 23514 (check_violation),
-- and a value the CHECKs accept goes on to collide with the key it copied (23505): that collision is the proof
-- it passed. Ends in a red error ON PURPOSE. Expected:
-- "db/040 run 2 RESULT: PASS | refused 16 of 16: ... | passed the checks 9 of 9: ... | wrong: none."
do $$
declare
  probes constant jsonb := jsonb_build_array(
    -- [table, column, value (JSON; null = the column NULL), should the CHECK refuse it?, label]
    jsonb_build_array('trades_v2', 'signal_before_sale', '{"state":"PREDATES_SALE"}'::jsonb, true, 'PREDATES_SALE without scanned_at'),
    jsonb_build_array('trades_v2', 'signal_before_sale', '{"state":"PREDATES_SALE","scanned_at":1}'::jsonb, true, 'scanned_at not a string'),
    jsonb_build_array('trades_v2', 'signal_before_sale', '{"state":"NOT_RECORDED"}'::jsonb, true, 'NOT_RECORDED without reason'),
    jsonb_build_array('trades_v2', 'signal_before_sale', '{"state":"NOT_ESTABLISHED"}'::jsonb, true, 'NOT_ESTABLISHED without reason'),
    jsonb_build_array('trades_v2', 'signal_before_sale', '{}'::jsonb, true, 'signal: empty object'),
    jsonb_build_array('trades_v2', 'signal_before_sale', '"PREDATES_SALE"'::jsonb, true, 'signal: a bare string'),
    jsonb_build_array('trades_v2', 'code_version', '{}'::jsonb, true, 'trades_v2.code_version: empty'),
    jsonb_build_array('trades_v2', 'code_version', '{"app":"x"}'::jsonb, true, 'trades_v2.code_version: no scoring'),
    jsonb_build_array('trades_v2', 'code_version', '{"scoring":2}'::jsonb, true, 'trades_v2.code_version: no app'),
    jsonb_build_array('trades_v2', 'sale_code_version', '{}'::jsonb, true, 'sale_code_version: empty'),
    jsonb_build_array('portfolio', 'code_version', '{}'::jsonb, true, 'portfolio.code_version: empty'),
    jsonb_build_array('scan_runs', 'code_version', '{}'::jsonb, true, 'scan_runs.code_version: empty'),
    jsonb_build_array('signal_log', 'code_version', '{}'::jsonb, true, 'signal_log.code_version: empty'),
    jsonb_build_array('scan_runs', 'prefilter_rule', '{}'::jsonb, true, 'prefilter_rule: empty'),
    jsonb_build_array('trades_v2', 'order_type', '"bogus"'::jsonb, true, 'order_type: not one of the five'),
    jsonb_build_array('portfolio', 'exit_rule_id', '"bogus"'::jsonb, true, 'exit_rule_id: not one of the two'),
    jsonb_build_array('trades_v2', 'signal_before_sale', '{"state":"PREDATES_SALE","scanned_at":"2026-11-05T14:00:00Z"}'::jsonb, false, 'PREDATES_SALE with scanned_at'),
    jsonb_build_array('trades_v2', 'signal_before_sale', '{"state":"NOT_RECORDED","reason":"x"}'::jsonb, false, 'NOT_RECORDED with reason'),
    jsonb_build_array('trades_v2', 'signal_before_sale', null, false, 'signal: NULL'),
    jsonb_build_array('trades_v2', 'code_version', '{"app":"x","scoring":2}'::jsonb, false, 'code_version without scoring_hash'),
    jsonb_build_array('trades_v2', 'code_version', '{"app":"x","scoring":2,"scoring_hash":"h"}'::jsonb, false, 'code_version with scoring_hash'),
    jsonb_build_array('signal_log', 'code_version', '{"app":"x","scoring":2,"scoring_hash":"h"}'::jsonb, false, 'signal_log.code_version, full'),
    jsonb_build_array('scan_runs', 'prefilter_rule', '{"rule":"x"}'::jsonb, false, 'prefilter_rule with rule'),
    jsonb_build_array('trades_v2', 'order_type', null, false, 'order_type NULL (legacy)'),
    jsonb_build_array('portfolio', 'exit_rule_id', null, false, 'exit_rule_id NULL (EDGE)'));
  p jsonb;
  src jsonb;
  refused text := ''; passed text := ''; wrong text := '';
  nr int := 0; np int := 0;
  outcome text;
begin
  for p in select * from jsonb_array_elements(probes) loop
    execute format('select to_jsonb(r) from %I r limit 1', p ->> 0) into src;
    if src is null then
      wrong := wrong || format(' [%s: no row in %s to copy, NOT TESTED]', p ->> 4, p ->> 0);
      continue;
    end if;
    src := case when jsonb_typeof(p -> 2) = 'null' or p -> 2 is null then src - (p ->> 1) else jsonb_set(src, array[p ->> 1], p -> 2) end;
    begin
      execute format('insert into %I select (jsonb_populate_record(null::%I, $1)).*', p ->> 0, p ->> 0) using src;
      outcome := 'INSERTED';
    exception
      when check_violation then outcome := 'check';
      when unique_violation then outcome := 'key';
      when others then outcome := 'other: ' || sqlstate || ' ' || sqlerrm;
    end;
    if (p ->> 3)::boolean and outcome = 'check' then nr := nr + 1; refused := refused || ' ' || (p ->> 4) || ';';
    elsif not (p ->> 3)::boolean and outcome = 'key' then np := np + 1; passed := passed || ' ' || (p ->> 4) || ';';
    else wrong := wrong || format(' [%s: expected %s, got %s]', p ->> 4, case when (p ->> 3)::boolean then 'check_violation' else 'to pass the checks' end, outcome);
    end if;
  end loop;
  raise exception 'db/040 run 2 RESULT: % | refused % of 16:% | passed the checks % of 9:% | wrong:%. This message is raised on purpose so everything rolls back: nothing was written.',
    case when wrong = '' and nr = 16 and np = 9 then 'PASS' else 'FAIL' end, nr, refused, np, passed, case when wrong = '' then ' none' else wrong end;
end $$;
