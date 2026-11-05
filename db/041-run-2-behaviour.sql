-- db/041 run 2 of 2: behaviour, after run 1. Writes nothing: each probe copies an existing row with engine_source
-- changed. NOT NULL and the CHECK are evaluated before the primary key, so a refused value stops at 23502
-- (not_null_violation) or 23514 (check_violation), and an accepted one collides with the key it copied (23505).
-- Ends in a red error ON PURPOSE. Expected:
-- "db/041 run 2 RESULT: PASS | no engine left: 0 | refused 4 of 4: ... | passed 2 of 2: ... | wrong: none."
do $$
declare
  probes constant jsonb := jsonb_build_array(
    -- [table, value (null = the column NULL), expected outcome, label]
    jsonb_build_array('trades_v2', null, 'not_null', 'trades_v2: no engine'),
    jsonb_build_array('portfolio', null, 'not_null', 'portfolio: no engine'),
    jsonb_build_array('trades_v2', 'BOGUS', 'check', 'trades_v2: an unknown engine'),
    jsonb_build_array('portfolio', 'BOGUS', 'check', 'portfolio: an unknown engine'),
    jsonb_build_array('trades_v2', 'EDGE', 'key', 'trades_v2: EDGE'),
    jsonb_build_array('portfolio', 'WARRIOR', 'key', 'portfolio: WARRIOR'));
  p jsonb;
  src jsonb;
  outcome text;
  refused text := ''; passed text := ''; wrong text := '';
  nr int := 0; np int := 0;
  left_over bigint;
begin
  select (select count(*) from trades_v2 where engine_source is null) + (select count(*) from portfolio where engine_source is null) into left_over;
  for p in select * from jsonb_array_elements(probes) loop
    execute format('select to_jsonb(r) from %I r limit 1', p ->> 0) into src;
    if src is null then wrong := wrong || format(' [%s: no row to copy, NOT TESTED]', p ->> 3); continue; end if;
    src := case when jsonb_typeof(p -> 1) = 'null' then src - 'engine_source' else jsonb_set(src, '{engine_source}', p -> 1) end;
    begin
      execute format('insert into %I select (jsonb_populate_record(null::%I, $1)).*', p ->> 0, p ->> 0) using src;
      outcome := 'INSERTED';
    exception
      when not_null_violation then outcome := 'not_null';
      when check_violation then outcome := 'check';
      when unique_violation then outcome := 'key';
      when others then outcome := 'other: ' || sqlstate || ' ' || sqlerrm;
    end;
    if outcome = p ->> 2 and outcome = 'key' then np := np + 1; passed := passed || ' ' || (p ->> 3) || ';';
    elsif outcome = p ->> 2 then nr := nr + 1; refused := refused || ' ' || (p ->> 3) || ' (' || outcome || ');';
    else wrong := wrong || format(' [%s: expected %s, got %s]', p ->> 3, p ->> 2, outcome);
    end if;
  end loop;
  raise exception 'db/041 run 2 RESULT: % | no engine left: % | refused % of 4:% | passed % of 2:% | wrong:%. This message is raised on purpose so everything rolls back: nothing was written.',
    case when wrong = '' and nr = 4 and np = 2 and left_over = 0 then 'PASS' else 'FAIL' end, left_over, nr, refused, np, passed, case when wrong = '' then ' none' else wrong end;
end $$;
