-- db/038 ROLLBACK: the undo for db/038 (revision 2026-11-06-e). Puts the schema back exactly as it was before db/038.
-- IDEMPOTENT: every step is "if exists", so it can be run whether or not db/038 ever applied, or twice; on a database
-- db/038 never touched it changes nothing.
-- GUARDED (three-state: it proceeds only on a definite "nothing would be lost"): it aborts, changing nothing, if any of
-- db/038's new columns already holds real data -- Roman's settings values once the app saves them, a recorded fill
-- time, a captured verdict, an observed macro path. This undo is for the hours right after db/038 ran, before the app
-- code that fills those columns is live; afterwards, dropping them would destroy what they were added to keep.
-- AVAILABLE ONLY BETWEEN db/038 AND THE APP-CODE PUSH, BY DESIGN: once the app saves real values into these columns,
-- this refuses to run.
-- It restores db/027's comment on trades_v2.sell_time as it was, although that comment is wrong (it calls the column
-- the fill time; it is the time the sale was recorded): an undo gives back exactly what was there.
-- Checked in the schema harness: db/038, then this, gives back the same columns, constraints, triggers and tables; and
-- run on an unchanged database, or twice, it changes nothing.
begin;

do $$
declare
  held text := '';
  n bigint;
begin
  if (to_regclass('public.macro_observations') is not null) is not false then
    select count(*) into n from macro_observations;
    if (n > 0) is not false then held := held || format(' [macro_observations: %s rows]', n); end if;
  end if;
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'settings' and column_name = 'max_loss_pct')) is not false then
    execute $q$select count(*) from settings where risk_per_trade_pct is not null or float_threshold_shares is not null or max_loss_pct is not null or developer_tools is not null$q$ into n;
    if (n > 0) is not false then held := held || ' [settings: saved values in the new columns]'; end if;
  end if;
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trades_v2' and column_name = 'sell_filled_at')) is not false then
    execute $q$select count(*) from trades_v2 where sell_filled_at is not null or sell_filled_at_source is not null or verdict_displayed_at_sale is not null or verdict_display_state is not null or macro_path <> 'unknown'$q$ into n;
    if (n > 0) is not false then held := held || format(' [trades_v2: %s rows with a fill time, a captured verdict or a macro path]', n); end if;
  end if;
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rating_snapshots' and column_name = 'tier')) is not false then
    execute $q$select count(*) from rating_snapshots where tier is not null or scoring_version is not null or scoring_hash is not null or display_threshold is not null or macro_observation_id is not null or macro_path <> 'unknown'$q$ into n;
    if (n > 0) is not false then held := held || format(' [rating_snapshots: %s rows with new-column data]', n); end if;
  end if;
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'portfolio' and column_name = 'macro_path_at_buy')) is not false then
    execute $q$select count(*) from portfolio where macro_path_at_buy <> 'unknown'$q$ into n;
    if (n > 0) is not false then held := held || format(' [portfolio: %s positions with a macro path]', n); end if;
  end if;
  if (held <> '') is not false then
    raise exception 'db/038 ROLLBACK ABORTED, nothing changed: db/038''s columns already hold data the undo would destroy:%', held;
  end if;
end $$;

drop trigger if exists trades_v2_verdict_display_write_once on trades_v2;
alter table trades_v2 drop constraint if exists trades_v2_verdict_display_consistent;
alter table trades_v2 drop constraint if exists trades_v2_sell_filled_at_consistent;
alter table trades_v2
  drop column if exists verdict_display_state,
  drop column if exists verdict_displayed_at_sale,
  drop column if exists sell_filled_at_source,
  drop column if exists sell_filled_at,
  drop column if exists macro_path;
comment on column trades_v2.sell_time is 'SELL FILL time, PT wall clock HH:MM. (db/027)';
alter table rating_snapshots
  drop column if exists scoring_hash,
  drop column if exists scoring_version,
  drop column if exists tier,
  drop column if exists macro_observation_id,
  drop column if exists display_threshold,
  drop column if exists macro_path;
alter table portfolio drop column if exists macro_path_at_buy;
alter table settings
  drop column if exists developer_tools,
  drop column if exists max_loss_pct,
  drop column if exists float_threshold_shares,
  drop column if exists risk_per_trade_pct;
drop table if exists macro_observations;

commit;
