-- SUPABASE WILL SAY "Failed to run sql query" FOR A PASS. This file ends by raising an error ON PURPOSE, so
-- that everything it tried is rolled back. The result is the "RESULT:" line inside that error message: read it,
-- not the red label. (Read three times as a failure: db/035, db/040, db/037.)
-- db/037 run 2 of 2 (rewritten 2026-11-06): every privilege, every role, every EDGE table, by behaviour.
-- Ends in a red error ON PURPOSE; everything rolls back. Each probe runs as the role in its own block and undoes
-- itself, so a privilege wrongly allowed can't change what the next probe sees. Expected:
-- "db/037 run 2 RESULT: PASS | 288 table probes, 288 as expected | 18 column probes, 18 as expected | column grants:
--  30 of 30 present, 13 of 13 revoked absent, 0 others | not tested: none | wrong: none."
-- Column grants are also checked in the catalog, one (table, column, grantee, privilege) at a time: the intended 30
-- present, the 13 that db/037 revokes absent, and no other column grant for these roles on these tables.
--
-- What each probe does (privilege checks happen before any row is touched):
--   SELECT, INSERT, UPDATE   name EVERY column, so only a table-level grant passes (a column grant can't stand in)
--   DELETE                   delete ... where false
--   TRUNCATE, TRIGGER, MAINTAIN   truncate / create trigger / reindex, undone by raising inside the probe
--   REFERENCES               read from the catalog: a foreign key needs schema CREATE or a temp table, and a temp
--                            table can't reference a permanent one, so no role here can exercise it
-- Refused means 42501 "permission denied for table"; a 42501 with any other message is reported as wrong, since it
-- would hide which privilege was tested (measured in the harness: every refusal there carries that message). A row-level-security refusal (42501 "row-level security") or any other
-- error after the privilege check means the privilege was there. A role this editor can't assume is NOT TESTED,
-- and the result is then INCOMPLETE, never PASS.
do $$
declare
  target constant jsonb := jsonb_build_object(
    'analysis_periods', '{"anon":["SELECT","INSERT"]}'::jsonb, 'db_meta', '{}'::jsonb,
    'portfolio', '{"anon":["SELECT","INSERT","UPDATE","DELETE"]}'::jsonb, 'rating_snapshots', '{"anon":["SELECT","INSERT"]}'::jsonb,
    'scan_runs', '{"anon":["SELECT","INSERT"]}'::jsonb, 'settings', '{"anon":["SELECT","UPDATE"]}'::jsonb,
    'setup_triggers', '{"anon":["SELECT","INSERT"]}'::jsonb, 'signal_log', '{"anon":["SELECT","INSERT"],"outcome_filler":["SELECT"]}'::jsonb,
    'signal_snapshot_at_buy', '{"anon":["SELECT","INSERT"]}'::jsonb, 'trades', '{"anon":["SELECT"]}'::jsonb,
    'trades_v2', '{"anon":["SELECT","INSERT"],"outcome_filler":["SELECT"]}'::jsonb, 'workflow_runs', '{"anon":["SELECT"]}'::jsonb);
  -- column-level: [table, role, privilege, column, expected]; one granted column each way and one not granted
  col_probes constant jsonb := jsonb_build_array(
    jsonb_build_array('workflow_runs', 'anon', 'INSERT', 'workflow_name', true), jsonb_build_array('workflow_runs', 'anon', 'INSERT', 'actual_fired_at', true),
    jsonb_build_array('workflow_runs', 'anon', 'INSERT', 'declared_cron', true), jsonb_build_array('workflow_runs', 'anon', 'INSERT', 'run_url', true),
    jsonb_build_array('workflow_runs', 'anon', 'INSERT', 'trigger_type', true), jsonb_build_array('workflow_runs', 'anon', 'INSERT', 'completed_at', false),
    jsonb_build_array('workflow_runs', 'anon', 'UPDATE', 'completed_at', true), jsonb_build_array('workflow_runs', 'anon', 'UPDATE', 'is_noop', true),
    jsonb_build_array('workflow_runs', 'anon', 'UPDATE', 'job_status', true), jsonb_build_array('workflow_runs', 'anon', 'UPDATE', 'noop_reason', true),
    jsonb_build_array('workflow_runs', 'anon', 'UPDATE', 'workflow_name', false),
    jsonb_build_array('signal_log', 'outcome_filler', 'UPDATE', 'ret_5m', true), jsonb_build_array('signal_log', 'outcome_filler', 'UPDATE', 'taken_resolution', true),
    jsonb_build_array('signal_log', 'outcome_filler', 'UPDATE', 'symbol', false), jsonb_build_array('trades_v2', 'outcome_filler', 'UPDATE', 'price_at_plus1_day', true),
    jsonb_build_array('trades_v2', 'outcome_filler', 'UPDATE', 'sell_price', false),
    jsonb_build_array('signal_log', 'anon', 'UPDATE', 'ret_5m', false), jsonb_build_array('trades_v2', 'anon', 'UPDATE', 'price_at_plus1_day', false));
  privs constant text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  roles constant text[] := array['anon', 'authenticated', 'outcome_filler'];
  t text; r text; p text; cols text; defs text; stmt text; outcome text; expected boolean;
  c jsonb;
  n_table int := 0; ok_table int := 0; n_col int := 0; ok_col int := 0;
  wrong text := ''; untested text := '';
  keep_cols constant text[] := array[
    'signal_log.matched_trade_id outcome_filler UPDATE',
    'signal_log.outcomes_filled_at outcome_filler UPDATE',
    'signal_log.ret_15m outcome_filler UPDATE',
    'signal_log.ret_1d outcome_filler UPDATE',
    'signal_log.ret_1d_split_in_window outcome_filler UPDATE',
    'signal_log.ret_30m outcome_filler UPDATE',
    'signal_log.ret_3d outcome_filler UPDATE',
    'signal_log.ret_3d_split_in_window outcome_filler UPDATE',
    'signal_log.ret_5d outcome_filler UPDATE',
    'signal_log.ret_5d_split_in_window outcome_filler UPDATE',
    'signal_log.ret_5m outcome_filler UPDATE',
    'signal_log.ret_close outcome_filler UPDATE',
    'signal_log.ret_close_split_in_window outcome_filler UPDATE',
    'signal_log.taken_resolution outcome_filler UPDATE',
    'trades_v2.best_exit_date outcome_filler UPDATE',
    'trades_v2.best_exit_price outcome_filler UPDATE',
    'trades_v2.best_exit_timing outcome_filler UPDATE',
    'trades_v2.price_at_plus1_day outcome_filler UPDATE',
    'trades_v2.price_at_plus2_days outcome_filler UPDATE',
    'trades_v2.price_at_plus5_days outcome_filler UPDATE',
    'trades_v2.sell_timing_resolved outcome_filler UPDATE',
    'workflow_runs.actual_fired_at anon INSERT',
    'workflow_runs.completed_at anon UPDATE',
    'workflow_runs.declared_cron anon INSERT',
    'workflow_runs.is_noop anon UPDATE',
    'workflow_runs.job_status anon UPDATE',
    'workflow_runs.noop_reason anon UPDATE',
    'workflow_runs.run_url anon INSERT',
    'workflow_runs.trigger_type anon INSERT',
    'workflow_runs.workflow_name anon INSERT'];
  gone_cols constant text[] := array[
    'portfolio.bars_as_of_at_buy anon INSERT',
    'portfolio.bars_as_of_at_buy anon UPDATE',
    'portfolio.code_version anon INSERT',
    'scan_runs.code_version anon INSERT',
    'scan_runs.prefilter_rejections anon INSERT',
    'scan_runs.prefilter_rule anon INSERT',
    'scan_runs.trigger_type anon INSERT',
    'signal_log.bars_as_of anon INSERT',
    'signal_log.code_version anon INSERT',
    'trades_v2.bars_as_of_at_buy anon INSERT',
    'trades_v2.code_version anon INSERT',
    'trades_v2.position_id anon INSERT',
    'trades_v2.sale_code_version anon INSERT'];
  live_cols text[];
  n_present int; n_absent int; n_other int;
begin
  -- the column grants, one tuple at a time
  select coalesce(array_agg(distinct c.relname || '.' || at.attname || ' ' || pg_get_userbyid(a.grantee) || ' ' || a.privilege_type), '{}') into live_cols
    from pg_class c join pg_attribute at on at.attrelid = c.oid, aclexplode(at.attacl) a
   where c.relnamespace = 'public'::regnamespace and c.relname = any(array['analysis_periods', 'db_meta', 'portfolio', 'rating_snapshots', 'scan_runs', 'settings', 'setup_triggers', 'signal_log', 'signal_snapshot_at_buy', 'trades', 'trades_v2', 'workflow_runs'])
     and pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'outcome_filler');
  select count(*) into n_present from unnest(keep_cols) k where k = any(live_cols);
  select count(*) into n_absent from unnest(gone_cols) k where not (k = any(live_cols));
  select count(*) into n_other from unnest(live_cols) l where not (l = any(keep_cols)) and not (l = any(gone_cols));
  wrong := wrong || coalesce((select string_agg(format(' [column grant missing: %s]', k), '') from unnest(keep_cols) k where not (k = any(live_cols))), '')
                 || coalesce((select string_agg(format(' [column grant not revoked: %s]', k), '') from unnest(gone_cols) k where k = any(live_cols)), '')
                 || coalesce((select string_agg(format(' [column grant nobody intended: %s]', l), '') from unnest(live_cols) l where not (l = any(keep_cols)) and not (l = any(gone_cols))), '');

  foreach r in array roles loop
    if (not pg_has_role(current_user, r, 'SET')) is not false then untested := untested || ' ' || r; end if;
  end loop;
  for t in select jsonb_object_keys(target) order by 1 loop
    select string_agg(quote_ident(attname), ', ' order by attnum), string_agg('default', ', ') into cols, defs
      from pg_attribute where attrelid = ('public.' || t)::regclass and attnum > 0 and not attisdropped;
    foreach r in array roles loop
      foreach p in array privs loop
        expected := coalesce((target -> t -> r) ? p, false);
        n_table := n_table + 1;
        if (p = 'REFERENCES') is not false then
          outcome := case when has_table_privilege(r, 'public.' || t, 'REFERENCES') then 'allowed' else 'refused' end || ' (catalog)';
        elsif (position(r in untested) > 0) is not false then
          outcome := 'NOT TESTED (cannot assume ' || r || ')';
        else
          stmt := case p
            when 'SELECT' then format('select %s from public.%I where false', cols, t)
            when 'INSERT' then format('insert into public.%I (%s) values (%s)', t, cols, defs)
            when 'UPDATE' then format('update public.%I set (%s) = row(%s) where false', t, cols, defs)
            when 'DELETE' then format('delete from public.%I where false', t)
            when 'TRUNCATE' then format('truncate public.%I', t)
            when 'TRIGGER' then format('create trigger db037_probe before insert on public.%I for each row execute function reject_code_version_change()', t)
            when 'MAINTAIN' then format('reindex table public.%I', t) end;
          begin
            execute format('set local role %I', r);
            execute stmt;
            raise exception 'db037-probe-allowed';
          exception when others then
            outcome := case when sqlerrm = 'db037-probe-allowed' then 'allowed'
                            when sqlstate = '42501' and sqlerrm like '%row-level security%' then 'allowed (stopped by RLS)'
                            when sqlstate = '42501' and sqlerrm like 'permission denied for table%' then 'refused'
                            when sqlstate = '42501' then 'refused for another reason: ' || sqlerrm
                            else 'allowed (then ' || sqlstate || ')' end;
          end;
        end if;
        if (outcome like 'NOT TESTED%') is not false then
          null;
        elsif (outcome like 'refused for another reason%') is not false then
          wrong := wrong || format(' [%s %s %s: %s]', t, r, p, outcome);
        elsif ((outcome like 'allowed%') = expected) is not false then
          ok_table := ok_table + 1;
        else
          wrong := wrong || format(' [%s %s %s: expected %s, %s]', t, r, p, case when expected then 'allowed' else 'refused' end, outcome);
        end if;
      end loop;
    end loop;
  end loop;
  for c in select * from jsonb_array_elements(col_probes) loop
    n_col := n_col + 1;
    if (position(c ->> 1 in untested) > 0) is not false then continue; end if;
    stmt := case c ->> 2
      when 'INSERT' then format('insert into public.%I (%I) values (default)', c ->> 0, c ->> 3)
      else format('update public.%I set %I = default where false', c ->> 0, c ->> 3) end;
    begin
      execute format('set local role %I', c ->> 1);
      execute stmt;
      raise exception 'db037-probe-allowed';
    exception when others then
      outcome := case when sqlerrm = 'db037-probe-allowed' then 'allowed'
                      when sqlstate = '42501' and sqlerrm like '%row-level security%' then 'allowed (stopped by RLS)'
                      when sqlstate = '42501' and sqlerrm like 'permission denied for table%' then 'refused'
                            when sqlstate = '42501' then 'refused for another reason: ' || sqlerrm
                      else 'allowed (then ' || sqlstate || ')' end;
    end;
    if (outcome like 'refused for another reason%') is not false then wrong := wrong || format(' [%s %s %s(%s): %s]', c ->> 0, c ->> 1, c ->> 2, c ->> 3, outcome);
    elsif ((outcome like 'allowed%') = (c ->> 4)::boolean) is not false then ok_col := ok_col + 1;
    else wrong := wrong || format(' [%s %s %s(%s): expected %s, %s]', c ->> 0, c ->> 1, c ->> 2, c ->> 3, case when (c ->> 4)::boolean then 'allowed' else 'refused' end, outcome);
    end if;
  end loop;
  raise exception 'db/037 run 2 RESULT: % | % table probes, % as expected | % column probes, % as expected | column grants: % of 30 present, % of 13 revoked absent, % others | not tested:% | wrong:%. This message is raised on purpose so everything rolls back.',
    case when untested <> '' then 'INCOMPLETE' when wrong = '' and ok_table = 288 and ok_col = 18 and n_present = 30 and n_absent = 13 and n_other = 0 then 'PASS' else 'FAIL' end,
    n_table, ok_table, n_col, ok_col, n_present, n_absent, n_other, case when untested = '' then ' none' else untested end, case when wrong = '' then ' none' else wrong end;
end $$;
