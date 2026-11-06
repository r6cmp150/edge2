-- db/037 ROLLBACK (rewritten 2026-11-06): restores the 2026-11-06 grants dump's grid on EDGE's 12 tables exactly.
-- That is the state after the by-hand TRUNCATE and TRIGGER revokes; this does not undo those. IDEMPOTENT: it can be run
-- whether or not run 1 ever applied (2026-11-06: run on an unchanged database it failed on the policy, 42710; now the
-- policy is dropped if it exists first). A table-level REVOKE removes column grants too, so it grants back all of anon's
-- 22 column grants (the 13 that duplicate a table grant, and workflow_runs' 9). Checked in the schema harness: run 1,
-- then this, gives back the complete 43-row column capture and the dump's table grid; and run twice, or on an
-- unchanged database, it changes nothing.
begin;

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
grant delete, insert, maintain, references, select, update on analysis_periods to anon;
grant delete, insert, maintain, references, select, update on analysis_periods to authenticated;
grant delete, insert, maintain, references, select, update on db_meta to anon;
grant delete, insert, maintain, references, select, update on db_meta to authenticated;
grant delete, insert, maintain, references, select, update on portfolio to anon;
grant delete, insert, maintain, references, select, update on portfolio to authenticated;
grant delete, insert, maintain, references, select, update on rating_snapshots to anon;
grant delete, insert, maintain, references, select, update on rating_snapshots to authenticated;
grant delete, insert, maintain, references, select, update on scan_runs to anon;
grant delete, insert, maintain, references, select, update on scan_runs to authenticated;
grant delete, insert, maintain, references, select, update on settings to anon;
grant delete, insert, maintain, references, select, update on settings to authenticated;
grant delete, insert, maintain, references, select, update on setup_triggers to anon;
grant delete, insert, maintain, references, select, update on setup_triggers to authenticated;
grant delete, insert, maintain, references, select, update on signal_log to anon;
grant delete, insert, maintain, references, select, update on signal_log to authenticated;
grant insert, select on signal_snapshot_at_buy to anon;
grant delete, insert, maintain, references, select, update on signal_snapshot_at_buy to authenticated;
grant delete, insert, maintain, references, select on trades to anon;
grant delete, insert, maintain, references, select, update on trades to authenticated;
grant delete, insert, maintain, references, select, update on trades_v2 to anon;
grant delete, insert, maintain, references, select, update on trades_v2 to authenticated;
grant delete, maintain, references, select on workflow_runs to anon;
grant delete, insert, maintain, references, select, update on workflow_runs to authenticated;
grant insert (actual_fired_at, declared_cron, run_url, trigger_type, workflow_name) on workflow_runs to anon;
grant update (completed_at, is_noop, job_status, noop_reason) on workflow_runs to anon;
grant insert (bars_as_of_at_buy, code_version) on portfolio to anon;
grant update (bars_as_of_at_buy) on portfolio to anon;
grant insert (code_version, prefilter_rejections, prefilter_rule, trigger_type) on scan_runs to anon;
grant insert (bars_as_of, code_version) on signal_log to anon;
grant insert (bars_as_of_at_buy, code_version, position_id, sale_code_version) on trades_v2 to anon;
drop policy if exists "anon delete aged" on rating_snapshots; -- idempotent: runnable whether or not run 1 ever dropped it
create policy "anon delete aged" on rating_snapshots
  for delete to anon using (captured_at < (now() - '80 days'::interval));
alter table db_meta disable row level security;

commit;
