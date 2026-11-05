-- db/040 (2026-11-05): CHECK constraints that can't pass on unknown. Run 1 of 2. Paste whole; one transaction.
--
-- WHY: a CHECK passes when its expression is TRUE *or NULL*. jsonb_typeof(x -> 'key') is NULL when the key is
-- absent, and x ->> 'key' = '...' is NULL the same way, so these constraints never required their keys:
--   trades_v2_signal_before_sale_shape_chk (db/035): {"state":"PREDATES_SALE"} with no scanned_at, and
--     {"state":"NOT_RECORDED"} with no reason, were ACCEPTED. Found by db/035 run 4 (3 of 4 refused).
--   *_code_version_shape_chk (db/028), on portfolio, scan_runs, signal_log, trades_v2, and
--     trades_v2_sale_code_version_shape_chk: {} was accepted, and so was any object missing app or scoring.
--   scan_runs_prefilter_rule_shape_chk (db/032): {} was accepted.
-- Every rewritten branch is definite: coalesce(..., '') turns a missing key into a comparison that is false.
-- Also made explicit, same meaning: order_type and sell_order_type (db/027: NULL = legacy row) and exit_rule_id
-- (db/012; only Warrior sets it, EDGE writes NULL). engine_source is NOT changed: whether NULL is allowed there
-- is an open decision (two rows from a 2026-09-09 re-entry), and writing "is null or" would decide it silently.
--
-- GUARDS: aborts, changing nothing, unless every constraint it replaces has exactly the definition the live
-- schema had on 2026-11-05 (from the inspection query), and unless no existing row would break the new
-- definitions. The new constraints are added VALIDATED, so Postgres checks every existing row as well.
-- Tested before sending: reconstructed live schema in PGlite (PostgreSQL 18.6), run 1 then run 2.
begin;

do $$
declare
  expected constant jsonb := jsonb_build_object(
    'trades_v2.trades_v2_signal_before_sale_shape_chk', $c$CHECK (((signal_before_sale IS NULL) OR (((signal_before_sale ->> 'state'::text) = 'PREDATES_SALE'::text) AND (jsonb_typeof((signal_before_sale -> 'scanned_at'::text)) = 'string'::text)) OR (((signal_before_sale ->> 'state'::text) = ANY (ARRAY['NOT_ESTABLISHED'::text, 'NOT_RECORDED'::text])) AND (jsonb_typeof((signal_before_sale -> 'reason'::text)) = 'string'::text))))$c$,
    'trades_v2.trades_v2_code_version_shape_chk', $c$CHECK (((code_version IS NULL) OR ((jsonb_typeof((code_version -> 'app'::text)) = 'string'::text) AND (jsonb_typeof((code_version -> 'scoring'::text)) = 'number'::text) AND ((NOT (code_version ? 'scoring_hash'::text)) OR (jsonb_typeof((code_version -> 'scoring_hash'::text)) = 'string'::text)))))$c$,
    'trades_v2.trades_v2_sale_code_version_shape_chk', $c$CHECK (((sale_code_version IS NULL) OR ((jsonb_typeof((sale_code_version -> 'app'::text)) = 'string'::text) AND (jsonb_typeof((sale_code_version -> 'scoring'::text)) = 'number'::text) AND ((NOT (sale_code_version ? 'scoring_hash'::text)) OR (jsonb_typeof((sale_code_version -> 'scoring_hash'::text)) = 'string'::text)))))$c$,
    'portfolio.portfolio_code_version_shape_chk', $c$CHECK (((code_version IS NULL) OR ((jsonb_typeof((code_version -> 'app'::text)) = 'string'::text) AND (jsonb_typeof((code_version -> 'scoring'::text)) = 'number'::text) AND ((NOT (code_version ? 'scoring_hash'::text)) OR (jsonb_typeof((code_version -> 'scoring_hash'::text)) = 'string'::text)))))$c$,
    'scan_runs.scan_runs_code_version_shape_chk', $c$CHECK (((code_version IS NULL) OR ((jsonb_typeof((code_version -> 'app'::text)) = 'string'::text) AND (jsonb_typeof((code_version -> 'scoring'::text)) = 'number'::text) AND ((NOT (code_version ? 'scoring_hash'::text)) OR (jsonb_typeof((code_version -> 'scoring_hash'::text)) = 'string'::text)))))$c$,
    'signal_log.signal_log_code_version_shape_chk', $c$CHECK (((code_version IS NULL) OR ((jsonb_typeof((code_version -> 'app'::text)) = 'string'::text) AND (jsonb_typeof((code_version -> 'scoring'::text)) = 'number'::text) AND ((NOT (code_version ? 'scoring_hash'::text)) OR (jsonb_typeof((code_version -> 'scoring_hash'::text)) = 'string'::text)))))$c$,
    'scan_runs.scan_runs_prefilter_rule_shape_chk', $c$CHECK (((prefilter_rule IS NULL) OR ((jsonb_typeof(prefilter_rule) = 'object'::text) AND (jsonb_typeof((prefilter_rule -> 'rule'::text)) = 'string'::text))))$c$,
    'trades_v2.trades_v2_order_type_chk', $c$CHECK ((order_type = ANY (ARRAY['market'::text, 'limit'::text, 'stop'::text, 'stop_limit'::text, 'trailing_stop'::text])))$c$,
    'trades_v2.trades_v2_sell_order_type_chk', $c$CHECK ((sell_order_type = ANY (ARRAY['market'::text, 'limit'::text, 'stop'::text, 'stop_limit'::text, 'trailing_stop'::text])))$c$,
    'portfolio.portfolio_order_type_chk', $c$CHECK ((order_type = ANY (ARRAY['market'::text, 'limit'::text, 'stop'::text, 'stop_limit'::text, 'trailing_stop'::text])))$c$,
    'trades_v2.trades_v2_exit_rule_id_check', $c$CHECK ((exit_rule_id = ANY (ARRAY['edge.atr.multiday'::text, 'warrior.sameday.tightstop'::text])))$c$,
    'portfolio.portfolio_exit_rule_id_check', $c$CHECK ((exit_rule_id = ANY (ARRAY['edge.atr.multiday'::text, 'warrior.sameday.tightstop'::text])))$c$);
  k text;
  live text;
  wrong text := '';
  breaks text := '';
  n bigint;
begin
  for k in select jsonb_object_keys(expected) loop
    select pg_get_constraintdef(c.oid) into live from pg_constraint c
     where c.conrelid = ('public.' || split_part(k, '.', 1))::regclass and c.conname = split_part(k, '.', 2);
    if live is distinct from expected ->> k then
      wrong := wrong || format(' [%s: %s]', k, coalesce(left(live, 60) || '...', 'MISSING'));
    end if;
  end loop;
  if wrong <> '' then
    raise exception 'db/040 ABORTED, nothing changed: the live schema does not agree with what this was written against:%', wrong;
  end if;
  -- rows the new definitions would refuse (the same expressions as below)
  select count(*) into n from trades_v2 where not (signal_before_sale is null
    or (coalesce(signal_before_sale ->> 'state', '') = 'PREDATES_SALE' and coalesce(jsonb_typeof(signal_before_sale -> 'scanned_at'), '') = 'string')
    or (coalesce(signal_before_sale ->> 'state', '') in ('NOT_ESTABLISHED', 'NOT_RECORDED') and coalesce(jsonb_typeof(signal_before_sale -> 'reason'), '') = 'string'));
  if n > 0 then breaks := breaks || format(' [trades_v2.signal_before_sale: %s rows]', n); end if;
  for k in select unnest(array['trades_v2.code_version', 'trades_v2.sale_code_version', 'portfolio.code_version', 'scan_runs.code_version', 'signal_log.code_version']) loop
    execute format($q$select count(*) from %I where not (%2$I is null or (coalesce(jsonb_typeof(%2$I -> 'app'), '') = 'string'
      and coalesce(jsonb_typeof(%2$I -> 'scoring'), '') = 'number'
      and (not (%2$I ? 'scoring_hash') or coalesce(jsonb_typeof(%2$I -> 'scoring_hash'), '') = 'string')))$q$, split_part(k, '.', 1), split_part(k, '.', 2)) into n;
    if n > 0 then breaks := breaks || format(' [%s: %s rows]', k, n); end if;
  end loop;
  select count(*) into n from scan_runs where not (prefilter_rule is null
    or (jsonb_typeof(prefilter_rule) = 'object' and coalesce(jsonb_typeof(prefilter_rule -> 'rule'), '') = 'string'));
  if n > 0 then breaks := breaks || format(' [scan_runs.prefilter_rule: %s rows]', n); end if;
  if breaks <> '' then
    raise exception 'db/040 ABORTED, nothing changed: existing rows would break the definite definitions:%', breaks;
  end if;
end $$;

alter table trades_v2 drop constraint trades_v2_signal_before_sale_shape_chk;
alter table trades_v2 add  constraint trades_v2_signal_before_sale_shape_chk check (signal_before_sale is null
  or (coalesce(signal_before_sale ->> 'state', '') = 'PREDATES_SALE' and coalesce(jsonb_typeof(signal_before_sale -> 'scanned_at'), '') = 'string')
  or (coalesce(signal_before_sale ->> 'state', '') in ('NOT_ESTABLISHED', 'NOT_RECORDED') and coalesce(jsonb_typeof(signal_before_sale -> 'reason'), '') = 'string'));

alter table trades_v2 drop constraint trades_v2_code_version_shape_chk;
alter table trades_v2 add  constraint trades_v2_code_version_shape_chk check (code_version is null or (
  coalesce(jsonb_typeof(code_version -> 'app'), '') = 'string' and coalesce(jsonb_typeof(code_version -> 'scoring'), '') = 'number'
  and (not (code_version ? 'scoring_hash') or coalesce(jsonb_typeof(code_version -> 'scoring_hash'), '') = 'string')));
alter table trades_v2 drop constraint trades_v2_sale_code_version_shape_chk;
alter table trades_v2 add  constraint trades_v2_sale_code_version_shape_chk check (sale_code_version is null or (
  coalesce(jsonb_typeof(sale_code_version -> 'app'), '') = 'string' and coalesce(jsonb_typeof(sale_code_version -> 'scoring'), '') = 'number'
  and (not (sale_code_version ? 'scoring_hash') or coalesce(jsonb_typeof(sale_code_version -> 'scoring_hash'), '') = 'string')));
alter table portfolio drop constraint portfolio_code_version_shape_chk;
alter table portfolio add  constraint portfolio_code_version_shape_chk check (code_version is null or (
  coalesce(jsonb_typeof(code_version -> 'app'), '') = 'string' and coalesce(jsonb_typeof(code_version -> 'scoring'), '') = 'number'
  and (not (code_version ? 'scoring_hash') or coalesce(jsonb_typeof(code_version -> 'scoring_hash'), '') = 'string')));
alter table scan_runs drop constraint scan_runs_code_version_shape_chk;
alter table scan_runs add  constraint scan_runs_code_version_shape_chk check (code_version is null or (
  coalesce(jsonb_typeof(code_version -> 'app'), '') = 'string' and coalesce(jsonb_typeof(code_version -> 'scoring'), '') = 'number'
  and (not (code_version ? 'scoring_hash') or coalesce(jsonb_typeof(code_version -> 'scoring_hash'), '') = 'string')));
alter table signal_log drop constraint signal_log_code_version_shape_chk;
alter table signal_log add  constraint signal_log_code_version_shape_chk check (code_version is null or (
  coalesce(jsonb_typeof(code_version -> 'app'), '') = 'string' and coalesce(jsonb_typeof(code_version -> 'scoring'), '') = 'number'
  and (not (code_version ? 'scoring_hash') or coalesce(jsonb_typeof(code_version -> 'scoring_hash'), '') = 'string')));

alter table scan_runs drop constraint scan_runs_prefilter_rule_shape_chk;
alter table scan_runs add  constraint scan_runs_prefilter_rule_shape_chk check (prefilter_rule is null
  or (jsonb_typeof(prefilter_rule) = 'object' and coalesce(jsonb_typeof(prefilter_rule -> 'rule'), '') = 'string'));

-- Same meaning, now said: NULL is allowed on purpose (db/027 legacy rows; db/012, EDGE writes no exit rule).
alter table trades_v2 drop constraint trades_v2_order_type_chk;
alter table trades_v2 add  constraint trades_v2_order_type_chk check (order_type is null or order_type in ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop'));
alter table trades_v2 drop constraint trades_v2_sell_order_type_chk;
alter table trades_v2 add  constraint trades_v2_sell_order_type_chk check (sell_order_type is null or sell_order_type in ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop'));
alter table portfolio drop constraint portfolio_order_type_chk;
alter table portfolio add  constraint portfolio_order_type_chk check (order_type is null or order_type in ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop'));
alter table trades_v2 drop constraint trades_v2_exit_rule_id_check;
alter table trades_v2 add  constraint trades_v2_exit_rule_id_check check (exit_rule_id is null or exit_rule_id in ('edge.atr.multiday', 'warrior.sameday.tightstop'));
alter table portfolio drop constraint portfolio_exit_rule_id_check;
alter table portfolio add  constraint portfolio_exit_rule_id_check check (exit_rule_id is null or exit_rule_id in ('edge.atr.multiday', 'warrior.sameday.tightstop'));

commit;
