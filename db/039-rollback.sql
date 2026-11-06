-- db/039 ROLLBACK: the undo for db/039 (revision 2026-11-06-a). Puts the schema back exactly as it was before db/039.
-- IDEMPOTENT: every step is "if exists", so it can be run whether or not db/039 ever applied, or twice; on a database
-- db/039 never touched it changes nothing.
-- GUARDED (three-state: it proceeds only on a definite "nothing would be lost"): it aborts, changing nothing, if any of
-- db/039's new columns already holds data -- an outcome, a split refusal, a venue-gap reading, a selection mark.
-- AVAILABLE ONLY BETWEEN db/039 AND THE FIRST OUTCOME FILL, BY DESIGN: once the filler writes these columns, this
-- refuses to run. Outcomes can be recomputed from bars, but the selection marks and the capture-time SIP prices are
-- what a later fill is judged by, so they are not dropped silently.
-- EXACT: outcome_filler held nothing on rating_snapshots before db/039 (grants captured 2026-11-06), so revoking all of
-- its privileges there restores that; the two policies and the function are the ones db/039 created.
-- Checked in the schema harness: db/039, then this, gives back the same columns, policies, functions and grants; and
-- run on an unchanged database, or twice, it changes nothing.
begin;

do $$
declare
  n bigint;
begin
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rating_snapshots' and column_name = 'outcome_selection')) is not false then
    execute $q$select count(*) from rating_snapshots
                where ret_5m is not null or ret_15m is not null or ret_30m is not null or ret_close is not null
                   or ret_1d is not null or ret_3d is not null or ret_5d is not null
                   or ret_close_split_in_window or ret_1d_split_in_window or ret_3d_split_in_window or ret_5d_split_in_window
                   or sip_price_at_capture is not null or iex_volume_share is not null
                   or outcomes_filled_at is not null or outcome_selection is not null$q$ into n;
    if (n > 0) is not false then
      raise exception 'db/039 ROLLBACK ABORTED, nothing changed: % rating_snapshots rows hold db/039 data the undo would destroy', n;
    end if;
  end if;
end $$;

drop function if exists fill_rating_outcomes(jsonb);
drop policy if exists "outcome filler update" on rating_snapshots;
drop policy if exists "outcome filler select" on rating_snapshots;
revoke all on rating_snapshots from outcome_filler;
alter table rating_snapshots
  drop column if exists ret_5m,
  drop column if exists ret_15m,
  drop column if exists ret_30m,
  drop column if exists ret_close,
  drop column if exists ret_1d,
  drop column if exists ret_3d,
  drop column if exists ret_5d,
  drop column if exists ret_close_split_in_window,
  drop column if exists ret_1d_split_in_window,
  drop column if exists ret_3d_split_in_window,
  drop column if exists ret_5d_split_in_window,
  drop column if exists sip_price_at_capture,
  drop column if exists iex_volume_share,
  drop column if exists outcomes_filled_at,
  drop column if exists outcome_selection;

commit;
