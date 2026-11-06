-- db/037 (rewritten 2026-11-06): every EDGE table's grants down to what its enumerated paths use. Run 1 of 2.
-- Paste whole; one transaction. Behaviour check: db/037-run-2-behaviour.sql. Tested way back: db/037-rollback.sql.
--
-- WHY: Supabase's default ACL gives anon and authenticated every privilege on every new table, and RLS is the only
-- barrier on most of them. Every narrowing so far (db/023, db/033, the trades UPDATE revoke) touched anon only, and
-- authenticated still holds the full set on all 18 tables (grants dump, 2026-11-06). portfolio and db_meta have RLS
-- off, so there a grant is the whole story. TRUNCATE (not filtered by RLS) and TRIGGER (measured in the schema
-- harness: lets a role attach an existing function and refuse every write, including a sale) were revoked by hand
-- on 2026-11-06; this makes the rest of the grid explicit.
--
-- THE TEMPLATE is outcome_filler: table-level SELECT, column-level UPDATE, nothing else. For each of EDGE's 12
-- tables, REVOKE ALL from anon and authenticated, then grant back only what the enumerated paths use:
--   anon SELECT + INSERT   analysis_periods, rating_snapshots, scan_runs, setup_triggers, signal_log,
--                          signal_snapshot_at_buy, trades_v2 (the app, the loggers, the add path; their upserts are
--                          ON CONFLICT DO NOTHING, so INSERT only)
--   anon SELECT + INSERT + UPDATE + DELETE   portfolio (the app saves and removes positions)
--   anon SELECT + UPDATE   settings (one row, updated in place)
--   anon SELECT            trades (read by the backup only)
--   anon SELECT, and db/023's column grants   workflow_runs (INSERT on 5 columns, UPDATE on 4)
--   nothing                db_meta (unread since 2026-09-04): RLS on, no policy, no grant
--   authenticated          nothing anywhere, until the auth cutover grants it deliberately
--   outcome_filler         untouched (SELECT on signal_log and trades_v2, UPDATE on its 21 columns)
-- rating_snapshots: the "anon delete aged" policy is dropped (the app stopped deleting in e27bcad).
-- COLUMN GRANTS (added 2026-11-06, after the first run aborted correctly on an incomplete baseline): anon held 13
-- column grants that duplicate a table-level grant (INSERT on portfolio, scan_runs, signal_log and trades_v2 columns,
-- and UPDATE on portfolio.bars_as_of_at_buy). They are revoked explicitly, below. Behaviour-neutral: each is covered by
-- a table-level grant anon keeps after this file, and no enumerated anon write path needs them. Measured in the schema
-- harness, a table-level REVOKE already removes a role's column grants on that table, so the explicit lines repeat
-- what REVOKE ALL does; they are there so the intent is readable and survives a reordering. Kept exactly: outcome_filler's
-- 21 column UPDATEs (not named anywhere here) and anon's 9 on workflow_runs (granted back explicitly).
-- The six shark tables are outside db/001-041 and are not touched.
--
-- GUARDS (three-state: a guard proceeds only on a definite false): aborts, changing nothing, unless every table
-- exists and its table-level and column-level grants for the three roles are exactly the 2026-11-06 dump's. After
-- the change, aborts and rolls back unless the grid is exactly the one above.
-- Tested before sending: reconstructed live schema and grants in PGlite.
begin;

do $$
declare
  before constant jsonb := jsonb_build_object(
    'analysis_periods', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'db_meta', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'portfolio', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'rating_snapshots', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'scan_runs', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'settings', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'setup_triggers', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'signal_log', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:SELECT',
    'signal_snapshot_at_buy', 'anon:INSERT,SELECT authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'trades', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:',
    'trades_v2', 'anon:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:SELECT',
    'workflow_runs', 'anon:DELETE,MAINTAIN,REFERENCES,SELECT authenticated:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,UPDATE outcome_filler:');
  cols_before constant text := 'portfolio.bars_as_of_at_buy anon INSERT; portfolio.bars_as_of_at_buy anon UPDATE; portfolio.code_version anon INSERT; scan_runs.code_version anon INSERT; scan_runs.prefilter_rejections anon INSERT; scan_runs.prefilter_rule anon INSERT; scan_runs.trigger_type anon INSERT; signal_log.bars_as_of anon INSERT; signal_log.code_version anon INSERT; signal_log.matched_trade_id outcome_filler UPDATE; signal_log.outcomes_filled_at outcome_filler UPDATE; signal_log.ret_15m outcome_filler UPDATE; signal_log.ret_1d outcome_filler UPDATE; signal_log.ret_1d_split_in_window outcome_filler UPDATE; signal_log.ret_30m outcome_filler UPDATE; signal_log.ret_3d outcome_filler UPDATE; signal_log.ret_3d_split_in_window outcome_filler UPDATE; signal_log.ret_5d outcome_filler UPDATE; signal_log.ret_5d_split_in_window outcome_filler UPDATE; signal_log.ret_5m outcome_filler UPDATE; signal_log.ret_close outcome_filler UPDATE; signal_log.ret_close_split_in_window outcome_filler UPDATE; signal_log.taken_resolution outcome_filler UPDATE; trades_v2.bars_as_of_at_buy anon INSERT; trades_v2.best_exit_date outcome_filler UPDATE; trades_v2.best_exit_price outcome_filler UPDATE; trades_v2.best_exit_timing outcome_filler UPDATE; trades_v2.code_version anon INSERT; trades_v2.position_id anon INSERT; trades_v2.price_at_plus1_day outcome_filler UPDATE; trades_v2.price_at_plus2_days outcome_filler UPDATE; trades_v2.price_at_plus5_days outcome_filler UPDATE; trades_v2.sale_code_version anon INSERT; trades_v2.sell_timing_resolved outcome_filler UPDATE; workflow_runs.actual_fired_at anon INSERT; workflow_runs.completed_at anon UPDATE; workflow_runs.declared_cron anon INSERT; workflow_runs.is_noop anon UPDATE; workflow_runs.job_status anon UPDATE; workflow_runs.noop_reason anon UPDATE; workflow_runs.run_url anon INSERT; workflow_runs.trigger_type anon INSERT; workflow_runs.workflow_name anon INSERT';
  t text;
  live text;
  wrong text := '';
begin
  foreach t in array array['analysis_periods', 'db_meta', 'portfolio', 'rating_snapshots', 'scan_runs', 'settings', 'setup_triggers', 'signal_log', 'signal_snapshot_at_buy', 'trades', 'trades_v2', 'workflow_runs'] loop
    if (to_regclass('public.' || t) is null) is not false then
      raise exception 'db/037 ABORTED, nothing changed: table public.% does not exist', t;
    end if;
    select string_agg(r || ':' || coalesce(p, ''), ' ' order by r) into live from unnest(array['anon', 'authenticated', 'outcome_filler']) as r
      left join (select pg_get_userbyid(a.grantee) as who, string_agg(distinct a.privilege_type, ',' order by a.privilege_type) as p
                   from pg_class c, aclexplode(c.relacl) a where c.oid = ('public.' || t)::regclass group by a.grantee) x on x.who = r;
    if (live is distinct from before ->> t) is not false then
      wrong := wrong || format(' [%s: live %s]', t, coalesce(live, 'unreadable'));
    end if;
  end loop;
  if (wrong <> '') is not false then
    raise exception 'db/037 ABORTED, nothing changed: table grants differ from the 2026-11-06 dump this was written against:%', wrong;
  end if;
  select string_agg(distinct c.relname || '.' || at.attname || ' ' || pg_get_userbyid(a.grantee) || ' ' || a.privilege_type, '; '
                    order by c.relname || '.' || at.attname || ' ' || pg_get_userbyid(a.grantee) || ' ' || a.privilege_type) into live
    from pg_class c join pg_attribute at on at.attrelid = c.oid, aclexplode(at.attacl) a
   where c.relnamespace = 'public'::regnamespace and c.relname = any(array['analysis_periods', 'db_meta', 'portfolio', 'rating_snapshots', 'scan_runs', 'settings', 'setup_triggers', 'signal_log', 'signal_snapshot_at_buy', 'trades', 'trades_v2', 'workflow_runs'])
     and pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'outcome_filler');
  if (live is distinct from cols_before) is not false then
    raise exception 'db/037 ABORTED, nothing changed: column grants differ from the 2026-11-06 dump: live [%]', coalesce(live, 'none');
  end if;
  if (not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'rating_snapshots' and policyname = 'anon delete aged')) is not false then
    raise exception 'db/037 ABORTED, nothing changed: rating_snapshots has no "anon delete aged" policy to drop';
  end if;
end $$;

revoke all on analysis_periods from anon, authenticated;
revoke all on db_meta from anon, authenticated;
revoke all on portfolio from anon, authenticated;
revoke all on rating_snapshots from anon, authenticated;
revoke all on scan_runs from anon, authenticated;
revoke all on settings from anon, authenticated;
revoke all on setup_triggers from anon, authenticated;
revoke all on signal_log from anon, authenticated;
revoke all on signal_snapshot_at_buy from anon, authenticated;
revoke all on trades from anon, authenticated;
revoke all on trades_v2 from anon, authenticated;
revoke all on workflow_runs from anon, authenticated;
grant select, insert on analysis_periods to anon;
grant select, insert, update, delete on portfolio to anon;
grant select, insert on rating_snapshots to anon;
grant select, insert on scan_runs to anon;
grant select, update on settings to anon;
grant select, insert on setup_triggers to anon;
grant select, insert on signal_log to anon;
grant select, insert on signal_snapshot_at_buy to anon;
grant select on trades to anon;
grant select, insert on trades_v2 to anon;
grant select on workflow_runs to anon;
grant insert (actual_fired_at, declared_cron, run_url, trigger_type, workflow_name) on workflow_runs to anon;
grant update (completed_at, is_noop, job_status, noop_reason) on workflow_runs to anon;
revoke insert (bars_as_of_at_buy, code_version) on portfolio from anon;
revoke update (bars_as_of_at_buy) on portfolio from anon;
revoke insert (code_version, prefilter_rejections, prefilter_rule, trigger_type) on scan_runs from anon;
revoke insert (bars_as_of, code_version) on signal_log from anon;
revoke insert (bars_as_of_at_buy, code_version, position_id, sale_code_version) on trades_v2 from anon;
drop policy "anon delete aged" on rating_snapshots;
alter table db_meta enable row level security;

do $$
declare
  after constant jsonb := jsonb_build_object(
    'analysis_periods', 'anon:INSERT,SELECT authenticated: outcome_filler:',
    'db_meta', 'anon: authenticated: outcome_filler:',
    'portfolio', 'anon:DELETE,INSERT,SELECT,UPDATE authenticated: outcome_filler:',
    'rating_snapshots', 'anon:INSERT,SELECT authenticated: outcome_filler:',
    'scan_runs', 'anon:INSERT,SELECT authenticated: outcome_filler:',
    'settings', 'anon:SELECT,UPDATE authenticated: outcome_filler:',
    'setup_triggers', 'anon:INSERT,SELECT authenticated: outcome_filler:',
    'signal_log', 'anon:INSERT,SELECT authenticated: outcome_filler:SELECT',
    'signal_snapshot_at_buy', 'anon:INSERT,SELECT authenticated: outcome_filler:',
    'trades', 'anon:SELECT authenticated: outcome_filler:',
    'trades_v2', 'anon:INSERT,SELECT authenticated: outcome_filler:SELECT',
    'workflow_runs', 'anon:SELECT authenticated: outcome_filler:');
  cols_after constant text := 'signal_log.matched_trade_id outcome_filler UPDATE; signal_log.outcomes_filled_at outcome_filler UPDATE; signal_log.ret_15m outcome_filler UPDATE; signal_log.ret_1d outcome_filler UPDATE; signal_log.ret_1d_split_in_window outcome_filler UPDATE; signal_log.ret_30m outcome_filler UPDATE; signal_log.ret_3d outcome_filler UPDATE; signal_log.ret_3d_split_in_window outcome_filler UPDATE; signal_log.ret_5d outcome_filler UPDATE; signal_log.ret_5d_split_in_window outcome_filler UPDATE; signal_log.ret_5m outcome_filler UPDATE; signal_log.ret_close outcome_filler UPDATE; signal_log.ret_close_split_in_window outcome_filler UPDATE; signal_log.taken_resolution outcome_filler UPDATE; trades_v2.best_exit_date outcome_filler UPDATE; trades_v2.best_exit_price outcome_filler UPDATE; trades_v2.best_exit_timing outcome_filler UPDATE; trades_v2.price_at_plus1_day outcome_filler UPDATE; trades_v2.price_at_plus2_days outcome_filler UPDATE; trades_v2.price_at_plus5_days outcome_filler UPDATE; trades_v2.sell_timing_resolved outcome_filler UPDATE; workflow_runs.actual_fired_at anon INSERT; workflow_runs.completed_at anon UPDATE; workflow_runs.declared_cron anon INSERT; workflow_runs.is_noop anon UPDATE; workflow_runs.job_status anon UPDATE; workflow_runs.noop_reason anon UPDATE; workflow_runs.run_url anon INSERT; workflow_runs.trigger_type anon INSERT; workflow_runs.workflow_name anon INSERT';
  t text;
  live text;
  wrong text := '';
begin
  foreach t in array array['analysis_periods', 'db_meta', 'portfolio', 'rating_snapshots', 'scan_runs', 'settings', 'setup_triggers', 'signal_log', 'signal_snapshot_at_buy', 'trades', 'trades_v2', 'workflow_runs'] loop
    select string_agg(r || ':' || coalesce(p, ''), ' ' order by r) into live from unnest(array['anon', 'authenticated', 'outcome_filler']) as r
      left join (select pg_get_userbyid(a.grantee) as who, string_agg(distinct a.privilege_type, ',' order by a.privilege_type) as p
                   from pg_class c, aclexplode(c.relacl) a where c.oid = ('public.' || t)::regclass group by a.grantee) x on x.who = r;
    if (live is distinct from after ->> t) is not false then
      wrong := wrong || format(' [%s: %s]', t, coalesce(live, 'unreadable'));
    end if;
  end loop;
  if (wrong <> '') is not false then
    raise exception 'db/037 ABORTED, rolled back: the grid after is not the target:%', wrong;
  end if;
  select string_agg(distinct c.relname || '.' || at.attname || ' ' || pg_get_userbyid(a.grantee) || ' ' || a.privilege_type, '; '
                    order by c.relname || '.' || at.attname || ' ' || pg_get_userbyid(a.grantee) || ' ' || a.privilege_type) into live
    from pg_class c join pg_attribute at on at.attrelid = c.oid, aclexplode(at.attacl) a
   where c.relnamespace = 'public'::regnamespace and c.relname = any(array['analysis_periods', 'db_meta', 'portfolio', 'rating_snapshots', 'scan_runs', 'settings', 'setup_triggers', 'signal_log', 'signal_snapshot_at_buy', 'trades', 'trades_v2', 'workflow_runs'])
     and pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'outcome_filler');
  if (live is distinct from cols_after) is not false then
    raise exception 'db/037 ABORTED, rolled back: column grants after are not the target: live [%]', coalesce(live, 'none');
  end if;
  if (exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'rating_snapshots' and policyname = 'anon delete aged')) is not false then
    raise exception 'db/037 ABORTED, rolled back: the anon delete policy is still there';
  end if;
  if (not (select relrowsecurity from pg_class where oid = 'public.db_meta'::regclass)
      or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'db_meta')) is not false then
    raise exception 'db/037 ABORTED, rolled back: db_meta is not RLS-on with no policy';
  end if;
end $$;

commit;
