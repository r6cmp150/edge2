-- SUPABASE WILL SAY "Failed to run sql query" FOR A PASS. This file ends by raising an error ON PURPOSE, so
-- that everything it tried is rolled back. The result is the "RESULT:" line inside that error message: read it,
-- not the red label. (Read three times as a failure: db/035, db/040, db/037.)
-- db/038 run 2 of 2: behaviour, after run 1. Expected: an ERROR reading
-- "db/038 run 2 RESULT: PASS | revision ... | parts: ... | constraints (expected 8): ... | refused
-- (expected 3): ... | still allowed (expected 8): ...". Any WRONG entry names what failed.
do $$
declare
  refused text := '';
  allowed text := '';
  wrong text := '';
  expected_revision constant text := '2026-11-06-e';
  applied_revision text;
  parts text := '';
  missing text;
  target uuid;
  constrained text := '';
  probe record;
  g_role text; g_priv text; g_out text; g_exp boolean; g_cols text; g_defs text; g_ok int := 0;
begin
  -- WHICH COPY WAS APPLIED, read from the database. An old copy is detected here, not announced against.
  -- Each part is then checked on its own, so a failure names which of its unrelated parts is wrong.
  if to_regclass('public.macro_observations') is not null then
    applied_revision := substring(obj_description('public.macro_observations'::regclass) from 'db038_revision=([^ ]+)');
  end if;
  for missing in
    select part || ': ' || coalesce(string_agg(t || '.' || c, ', ') filter (where not present), 'OK')
      from (
        select part, t, c, exists (select 1 from information_schema.columns ic where ic.table_schema = 'public' and ic.table_name = t and ic.column_name = c) as present
          from (values
            ('macro', 'macro_observations', 'unjudged_etfs'), ('macro', 'macro_observations', 'etf_bar_dates'), ('macro', 'rating_snapshots', 'macro_path'),
            ('macro', 'rating_snapshots', 'display_threshold'), ('macro', 'rating_snapshots', 'macro_observation_id'), ('macro', 'trades_v2', 'macro_path'), ('macro', 'portfolio', 'macro_path_at_buy'),
            ('settings', 'settings', 'risk_per_trade_pct'), ('settings', 'settings', 'float_threshold_shares'), ('settings', 'settings', 'max_loss_pct'), ('settings', 'settings', 'developer_tools'),
            ('sell_filled_at', 'trades_v2', 'sell_filled_at'), ('sell_filled_at', 'trades_v2', 'sell_filled_at_source'),
            ('capture and scoring', 'rating_snapshots', 'tier'), ('capture and scoring', 'rating_snapshots', 'scoring_version'), ('capture and scoring', 'rating_snapshots', 'scoring_hash'),
            ('verdict A', 'trades_v2', 'verdict_displayed_at_sale'), ('verdict A', 'trades_v2', 'verdict_display_state')
          ) as v(part, t, c)
      ) s group by part order by part
  loop
    parts := parts || ' [' || missing || ']';
  end loop;
  if (applied_revision is distinct from expected_revision or parts ~ '\.') is not false then
    raise exception 'db/038 run 2 RESULT: FAIL | applied revision %, this check expects % | parts:%. Run the current db/038, not an earlier copy.', coalesce(applied_revision, 'none (an earlier copy, or not run)'), expected_revision, parts;
  end if;

  -- THE CONSTRAINTS, by behaviour, on a real row. Each probe undoes itself: if the update is wrongly allowed,
  -- it raises 'db038-probe-allowed' inside its own block, so the write never reaches the next probe. (Revision a's
  -- probes didn't, and a wrongly allowed write made the next one trip the write-once trigger instead.)
  select id into target from trades_v2 limit 1;
  for probe in select * from (values
      ('sell_filled_at-consistent', 'a fill stored as not_known', $p$update trades_v2 set sell_filled_at = now(), sell_filled_at_source = 'not_known' where id = $1$p$),
      ('sell_filled_at-needs-source', 'a fill time with no source', $p$update trades_v2 set sell_filled_at = now(), sell_filled_at_source = null where id = $1$p$),
      ('verdict-consistent', 'CAPTURED with nothing captured', $p$update trades_v2 set verdict_display_state = 'CAPTURED_AFTER_FILL', verdict_displayed_at_sale = null where id = $1$p$),
      ('verdict-needs-state', 'a capture with no state', $p$update trades_v2 set verdict_display_state = null, verdict_displayed_at_sale = '{"verdict":{}}'::jsonb where id = $1$p$),
      ('verdict-state', 'an unknown state', $p$update trades_v2 set verdict_display_state = 'SOMETHING' where id = $1$p$),
      ('macro-path-vocabulary', 'a macro path outside the vocabulary', $p$update trades_v2 set macro_path = 'guessed' where id = $1$p$)
    ) as v(name, what, stmt) loop
    begin
      execute probe.stmt using target;
      raise exception 'db038-probe-allowed';
    exception
      when check_violation then constrained := constrained || ' ' || probe.name;
      when others then
        wrong := wrong || case when sqlerrm = 'db038-probe-allowed' then format(' [%s: %s allowed]', probe.name, probe.what)
                               else format(' [%s: refused by something other than a CHECK: %s %s]', probe.name, sqlstate, sqlerrm) end;
    end;
  end loop;
  -- revision e: 'unclassified' is in the vocabulary of every macro path column (allowed, then undone in its block)
  begin
    update trades_v2 set macro_path = 'unclassified' where id = target;
    update rating_snapshots set macro_path = 'unclassified' where id = (select id from rating_snapshots limit 1);
    raise exception 'db038-unclassified-allowed';
  exception when others then
    if (sqlerrm = 'db038-unclassified-allowed') is not false then constrained := constrained || ' unclassified-allowed';
    else wrong := wrong || ' [unclassified refused: ' || sqlstate || ' ' || sqlerrm || ']'; end if;
  end;
  -- write-once: a real write first (the final raise rolls it back), then a change the trigger alone must refuse
  update trades_v2 set verdict_display_state = 'NOT_DISPLAYED' where id = target;
  begin update trades_v2 set verdict_display_state = 'CAPTURED_FILL_UNKNOWN', verdict_displayed_at_sale = '{}'::jsonb where id = target;
    wrong := wrong || ' [verdict-write-once: a change after a value was set allowed]';
  exception when raise_exception then constrained := constrained || ' verdict-write-once'; end; -- the trigger's own error only: a CHECK refusal here proves nothing about write-once

  -- Every probe is "where false": privileges are checked before any row is
  -- looked at, so each tests the grant and touches nothing. Run as the
  -- editor role; each probe switches to anon in its own sub-block. A
  -- REFUSED probe's sub-block rolls back, which undoes the role switch; an
  -- ALLOWED one leaves the role as anon. So the must-be-refused probes run
  -- FIRST: keep it so.

  -- MUST BE REFUSED (42501)
  begin set local role anon; update macro_observations set condition = condition where false;
    wrong := wrong || ' [macro_observations UPDATE allowed]';
  exception when insufficient_privilege then refused := refused || ' macro_observations-UPDATE'; end;
  begin set local role anon; delete from macro_observations where false;
    wrong := wrong || ' [macro_observations DELETE allowed]';
  exception when insufficient_privilege then refused := refused || ' macro_observations-DELETE'; end;
  begin set local role anon; truncate macro_observations;
    wrong := wrong || ' [macro_observations TRUNCATE allowed]';
  exception when insufficient_privilege then refused := refused || ' macro_observations-TRUNCATE'; end;

  -- MUST BE ALLOWED: what the observe-only build writes and reads
  begin set local role anon; insert into macro_observations (fetched_at, trading_date, source, feed, etf_moves, pattern_incomplete, groq_asked, path, display_threshold)
      select fetched_at, trading_date, source, feed, etf_moves, pattern_incomplete, groq_asked, path, display_threshold from macro_observations where false;
    allowed := allowed || ' macro_observations-INSERT';
  exception when others then wrong := wrong || ' [macro_observations INSERT refused: ' || sqlerrm || ']'; end;
  begin set local role anon; perform 1 from macro_observations where false; allowed := allowed || ' macro_observations-SELECT';
  exception when others then wrong := wrong || ' [macro_observations SELECT refused: ' || sqlerrm || ']'; end;
  begin set local role anon; insert into rating_snapshots (ticker, macro_path, display_threshold, macro_observation_id, tier, scoring_version, scoring_hash)
      select ticker, macro_path, display_threshold, macro_observation_id, tier, scoring_version, scoring_hash from rating_snapshots where false;
    allowed := allowed || ' rating_snapshots-INSERT(new cols)';
  exception when others then wrong := wrong || ' [rating_snapshots INSERT of new columns refused: ' || sqlerrm || ']'; end;
  begin set local role anon; insert into trades_v2 (ticker, macro_path, sell_filled_at, sell_filled_at_source) select ticker, macro_path, sell_filled_at, sell_filled_at_source from trades_v2 where false;
    allowed := allowed || ' trades_v2-INSERT(macro_path, sell_filled_at, sell_filled_at_source)';
  exception when others then wrong := wrong || ' [trades_v2 INSERT of macro_path refused: ' || sqlerrm || ']'; end;
  begin set local role anon; update portfolio set macro_path_at_buy = macro_path_at_buy where false;
    allowed := allowed || ' portfolio-UPDATE(macro_path_at_buy)';
  exception when others then wrong := wrong || ' [portfolio UPDATE of macro_path_at_buy refused: ' || sqlerrm || ']'; end;
  begin set local role anon; update settings set risk_per_trade_pct = risk_per_trade_pct, float_threshold_shares = float_threshold_shares,
      max_loss_pct = max_loss_pct, developer_tools = developer_tools where false;
    allowed := allowed || ' settings-UPDATE(new cols)';
  exception when others then wrong := wrong || ' [settings UPDATE of new columns refused: ' || sqlerrm || ']'; end;
  begin set local role anon; perform risk_per_trade_pct, float_threshold_shares, max_loss_pct, developer_tools from settings where false;
    allowed := allowed || ' settings-SELECT(new cols)';
  exception when others then wrong := wrong || ' [settings SELECT of new columns refused: ' || sqlerrm || ']'; end;

  -- revision d: macro_observations' FULL grid, eight privileges by three roles, by behaviour (the db/037 probe shape:
  -- every probe undoes itself; refused only as 42501 "permission denied for table"; REFERENCES from the catalog,
  -- since no role here can exercise it). The probes above leave the role set, so reset it first.
  reset role;
  select string_agg(quote_ident(attname), ', ' order by attnum), string_agg('default', ', ') into g_cols, g_defs
    from pg_attribute where attrelid = 'public.macro_observations'::regclass and attnum > 0 and not attisdropped;
  foreach g_role in array array['anon', 'authenticated', 'outcome_filler'] loop
    foreach g_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      g_exp := g_role = 'anon' and g_priv in ('SELECT', 'INSERT');
      if (g_priv = 'REFERENCES') is not false then
        g_out := case when has_table_privilege(g_role, 'public.macro_observations', 'REFERENCES') then 'allowed' else 'refused' end;
      elsif (not pg_has_role(current_user, g_role, 'SET')) is not false then
        g_out := 'NOT TESTED';
      else
        begin
          execute format('set local role %I', g_role);
          execute case g_priv
            when 'SELECT' then format('select %s from public.macro_observations where false', g_cols)
            when 'INSERT' then format('insert into public.macro_observations (%s) values (%s)', g_cols, g_defs)
            when 'UPDATE' then format('update public.macro_observations set (%s) = row(%s) where false', g_cols, g_defs)
            when 'DELETE' then 'delete from public.macro_observations where false'
            when 'TRUNCATE' then 'truncate public.macro_observations'
            when 'TRIGGER' then 'create trigger db038_probe before insert on public.macro_observations for each row execute function reject_code_version_change()'
            when 'MAINTAIN' then 'reindex table public.macro_observations' end;
          raise exception 'db038-probe-allowed';
        exception when others then
          g_out := case when sqlerrm = 'db038-probe-allowed' then 'allowed'
                        when sqlstate = '42501' and sqlerrm like '%row-level security%' then 'allowed (stopped by RLS)'
                        when sqlstate = '42501' and sqlerrm like 'permission denied for table%' then 'refused'
                        when sqlstate = '42501' then 'refused for another reason: ' || sqlerrm
                        else 'allowed (then ' || sqlstate || ')' end;
        end;
      end if;
      if ((g_out like 'allowed%') = g_exp and g_out not like 'refused for another reason%' and g_out <> 'NOT TESTED') is not false then
        g_ok := g_ok + 1;
      else
        wrong := wrong || format(' [macro_observations grid %s %s: expected %s, %s]', g_role, g_priv, case when g_exp then 'allowed' else 'refused' end, g_out);
      end if;
    end loop;
  end loop;
  allowed := allowed || format(' macro_observations-grid(%s/24)', g_ok);

  raise exception 'db/038 run 2 RESULT: % | revision % | parts:% | constraints (expected 8):% | refused (expected 3):%. | still allowed (expected 8):%.%  Raised on purpose so everything rolls back; every probe was WHERE FALSE and touched no row.',
    case when wrong = '' then 'PASS' else 'FAIL' end, applied_revision, parts, constrained, refused, allowed, case when wrong = '' then '' else ' | WRONG:' || wrong end;
end $$;
