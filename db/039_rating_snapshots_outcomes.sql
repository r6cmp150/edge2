-- REVISION 2026-11-06-a. Run 2 reads this back from the database and fails on any other, so pasting an old copy
-- can't pass. Any copy of db/039 without this line is void.
-- db/039 (2026-11-05): outcomes for rating_snapshots. For Roman, AFTER db/037 and db/038 (both live, 2026-11-06).
-- Run 1 of 2; the behaviour check is db/039-run-2-behaviour.sql, and db/039-rollback.sql undoes it.
-- REVISED 2026-11-06 (a), carved to main ahead of its app code (main is deployable at every commit):
--   - the function's ACL is made explicit. The live default ACL (pg_default_acl, objtype f) gives every NEW function in
--     public EXECUTE for anon, authenticated AND service_role (captured 2026-11-06). The draft revoked anon and
--     authenticated by name and left service_role holding EXECUTE. Now every grantee the default ACL put there,
--     whoever it is, is revoked from the function's own ACL, and the post-condition requires the ACL to be exactly the
--     owner and outcome_filler. anon=X from the default ACL is the thing being avoided, by construction not by list.
--   - a revision stamp, read back by run 2.
--   - the undo is guarded (three-state): it refuses if any new column holds data.
-- AGAINST THE APP AS DEPLOYED: every added column is nullable or NOT NULL with a default; the one new CHECK
-- (outcome_selection) is satisfied for the deployed app's rows through its explicit "is null" branch, a definite TRUE,
-- never by a NULL; no trigger is added; the two new policies are for outcome_filler only and change nothing for anon.
--
-- WHAT IT ADDS:
--   1. Outcome columns, as signal_log's: returns at 5, 15 and 30 minutes, the close, 1, 3 and 5
--      days, split refusals, outcomes_filled_at. Fractions, not percent.
--   2. outcome_selection: which rows outcomes are filled for. The first capture of each ticker in
--      each 30-minute bucket, marked so the selection is in the data. NULL = not marked yet.
--   3. sip_price_at_capture and iex_volume_share: entry is the browser's IEX price and exit is SIP
--      bars, so the venue gap is measured on each row and split by IEX share.
--   4. outcome_filler: SELECT, and UPDATE on these columns only, with an update policy.
--   5. fill_rating_outcomes(jsonb): many rows in one request. SECURITY INVOKER, EXECUTE for
--      outcome_filler only, and run 2 proves both by behaviour, not from the catalog. It runs as
--      its caller, so it holds nothing the caller doesn't. PostgREST's bulk upsert can't do this: ON CONFLICT DO UPDATE
--      needs INSERT, and outcome_filler must not be able to create rows.
--
-- anon's position is unchanged: db/037 revoked its UPDATE, and nothing here gives it back.
--
-- GUARDED on the live schema: aborts, nothing changed, unless db/037 and db/038 have run, the role
-- exists, rating_snapshots.id is unique (the table has no CREATE in db/, so that is inferred from
-- the data until this checks it), and no column here exists already.

begin;

do $$
declare
  c text;
begin
  if (to_regclass('public.rating_snapshots') is null) is not false then
    raise exception 'db/039 ABORTED, nothing changed: rating_snapshots does not exist';
  end if;
  if (not exists (select 1 from pg_roles where rolname = 'outcome_filler')) is not false then
    raise exception 'db/039 ABORTED, nothing changed: role outcome_filler does not exist (db/017)';
  end if;
  if (has_table_privilege('anon', 'public.rating_snapshots', 'UPDATE')) is not false then
    raise exception 'db/039 ABORTED, nothing changed: anon has UPDATE on rating_snapshots, so db/037 has not run';
  end if;
  if (not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rating_snapshots' and column_name = 'tier')) is not false then
    raise exception 'db/039 ABORTED, nothing changed: rating_snapshots.tier does not exist, so db/038 has not run';
  end if;
  if (not exists (
    select 1 from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
     where i.indrelid = 'public.rating_snapshots'::regclass and i.indisunique and i.indnatts = 1 and a.attname = 'id')) is not false then
    raise exception 'db/039 ABORTED, nothing changed: rating_snapshots.id has no unique index, and fills update by id';
  end if;
  foreach c in array array['ret_5m', 'ret_15m', 'ret_30m', 'ret_close', 'ret_1d', 'ret_3d', 'ret_5d', 'ret_close_split_in_window', 'ret_1d_split_in_window', 'ret_3d_split_in_window', 'ret_5d_split_in_window', 'sip_price_at_capture', 'iex_volume_share', 'outcomes_filled_at', 'outcome_selection'] loop
    if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rating_snapshots' and column_name = c)) is not false then
      raise exception 'db/039 ABORTED, nothing changed: rating_snapshots.% already exists', c;
    end if;
  end loop;
  if (to_regprocedure('public.fill_rating_outcomes(jsonb)') is not null) is not false then
    raise exception 'db/039 ABORTED, nothing changed: fill_rating_outcomes already exists';
  end if;
end $$;

alter table rating_snapshots
  add column ret_5m numeric,
  add column ret_15m numeric,
  add column ret_30m numeric,
  add column ret_close numeric,
  add column ret_1d numeric,
  add column ret_3d numeric,
  add column ret_5d numeric,
  add column ret_close_split_in_window boolean not null default false,
  add column ret_1d_split_in_window boolean not null default false,
  add column ret_3d_split_in_window boolean not null default false,
  add column ret_5d_split_in_window boolean not null default false,
  add column sip_price_at_capture numeric,
  add column iex_volume_share numeric,
  add column outcomes_filled_at timestamptz,
  add column outcome_selection text check (outcome_selection is null or outcome_selection in ('first_in_30min', 'not_selected')); -- NULL = not selected yet (spec §7.7: a CHECK must be definite)

comment on column rating_snapshots.outcome_selection is 'db/039: first_in_30min = the first capture of this ticker in this 30-minute PT bucket, which is filled with outcomes; not_selected = a later capture in the same bucket, kept for the score distribution; NULL = not marked yet. The rule reads the ticker, the capture time and the id, never an outcome, a score or a tier. Which rows have outcomes is a filler policy (scripts/lib/rating-outcomes.mjs), and it can be relaxed without a migration.';
comment on column rating_snapshots.ret_5m is 'db/039: fraction, from price (the browser''s IEX snapshot) to SIP bars. NULL = not measured: not selected, not yet due, or the horizon does not fit in the session. As for every ret_ column here.';
comment on column rating_snapshots.sip_price_at_capture is 'db/039: the SIP minute bar at captured_at, for the venue gap against price. NULL outside the session or with no bar within 5 minutes.';
comment on column rating_snapshots.iex_volume_share is 'db/039: IEX volume over SIP volume for the ticker on that date, the split the venue gap is reported by.';
comment on column rating_snapshots.outcomes_filled_at is 'db/039: when this row was finished: every horizon has a value, was refused for a split, or can never apply; or 12 days passed and what is missing stays missing. NULL on not_selected rows.';

-- One privilege per statement when a column list is present: in "select, update (cols)" the list binds only to
-- UPDATE, so SELECT there was table-level all along. It is granted on its own line below. (2026-11-06)
grant update (
  ret_5m, ret_15m, ret_30m, ret_close, ret_1d, ret_3d, ret_5d,
  ret_close_split_in_window, ret_1d_split_in_window, ret_3d_split_in_window, ret_5d_split_in_window,
  sip_price_at_capture, iex_volume_share, outcomes_filled_at, outcome_selection
) on rating_snapshots to outcome_filler;
grant select on rating_snapshots to outcome_filler;
create policy "outcome filler select" on rating_snapshots for select to outcome_filler using (true);
create policy "outcome filler update" on rating_snapshots for update to outcome_filler using (true) with check (true);

-- Fills only what the patch names: coalesce keeps a column the patch doesn't carry. Returns how many
-- rows it updated, which the caller checks against how many it sent.
create function fill_rating_outcomes(patches jsonb) returns integer
language sql security invoker set search_path = public, pg_temp as $$
  with done as (
    update rating_snapshots r set
      ret_5m = coalesce(p.ret_5m, r.ret_5m),
      ret_15m = coalesce(p.ret_15m, r.ret_15m),
      ret_30m = coalesce(p.ret_30m, r.ret_30m),
      ret_close = coalesce(p.ret_close, r.ret_close),
      ret_1d = coalesce(p.ret_1d, r.ret_1d),
      ret_3d = coalesce(p.ret_3d, r.ret_3d),
      ret_5d = coalesce(p.ret_5d, r.ret_5d),
      ret_close_split_in_window = coalesce(p.ret_close_split_in_window, r.ret_close_split_in_window),
      ret_1d_split_in_window = coalesce(p.ret_1d_split_in_window, r.ret_1d_split_in_window),
      ret_3d_split_in_window = coalesce(p.ret_3d_split_in_window, r.ret_3d_split_in_window),
      ret_5d_split_in_window = coalesce(p.ret_5d_split_in_window, r.ret_5d_split_in_window),
      sip_price_at_capture = coalesce(p.sip_price_at_capture, r.sip_price_at_capture),
      iex_volume_share = coalesce(p.iex_volume_share, r.iex_volume_share),
      outcomes_filled_at = coalesce(p.outcomes_filled_at, r.outcomes_filled_at),
      outcome_selection = coalesce(p.outcome_selection, r.outcome_selection)
    from jsonb_to_recordset(patches) as p(
      id bigint, ret_5m numeric, ret_15m numeric, ret_30m numeric, ret_close numeric, ret_1d numeric, ret_3d numeric, ret_5d numeric,
      ret_close_split_in_window boolean, ret_1d_split_in_window boolean, ret_3d_split_in_window boolean, ret_5d_split_in_window boolean,
      sip_price_at_capture numeric, iex_volume_share numeric, outcomes_filled_at timestamptz, outcome_selection text)
    where r.id = p.id
    returning 1
  )
  select count(*)::integer from done;
$$;
-- Explicit ACL (revision a): revoke from PUBLIC, then from every role the default ACL granted EXECUTE to, read from the
-- function's own ACL (live: anon, authenticated, service_role); then grant outcome_filler. The default ACL is not relied on.
revoke all on function fill_rating_outcomes(jsonb) from public;
do $$
declare
  g text;
begin
  for g in select distinct pg_get_userbyid(a.grantee)::text
             from pg_proc p, aclexplode(p.proacl) a
            where p.oid = 'public.fill_rating_outcomes(jsonb)'::regprocedure
              and a.grantee <> 0 and a.grantee <> p.proowner loop
    execute format('revoke all on function public.fill_rating_outcomes(jsonb) from %I', g);
  end loop;
end $$;
grant execute on function fill_rating_outcomes(jsonb) to outcome_filler;
comment on function fill_rating_outcomes(jsonb) is 'db/039: fills rating_snapshots outcome columns, many rows per call. SECURITY INVOKER; EXECUTE for outcome_filler only, explicitly (the default ACL''s anon/authenticated/service_role EXECUTE revoked). db039_revision=2026-11-06-a';

-- POST-CONDITION, before commit.
do $$
begin
  if (has_table_privilege('anon', 'public.rating_snapshots', 'UPDATE')
     or has_column_privilege('anon', 'public.rating_snapshots', 'ret_close', 'UPDATE')) is not false then
    raise exception 'db/039 ABORTED, rolled back: anon can UPDATE rating_snapshots';
  end if;
  if (has_table_privilege('outcome_filler', 'public.rating_snapshots', 'INSERT') or has_table_privilege('outcome_filler', 'public.rating_snapshots', 'DELETE')) is not false then
    raise exception 'db/039 ABORTED, rolled back: outcome_filler can create or delete rows';
  end if;
  if (has_column_privilege('outcome_filler', 'public.rating_snapshots', 'score', 'UPDATE') or has_column_privilege('outcome_filler', 'public.rating_snapshots', 'price', 'UPDATE')) is not false then
    raise exception 'db/039 ABORTED, rolled back: outcome_filler can UPDATE a captured column';
  end if;
  if (has_function_privilege('anon', 'public.fill_rating_outcomes(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.fill_rating_outcomes(jsonb)', 'EXECUTE')) is not false then
    raise exception 'db/039 ABORTED, rolled back: anon or authenticated can run fill_rating_outcomes';
  end if;
  -- exactly the owner and outcome_filler, and nobody through PUBLIC (grantee 0)
  if ((select coalesce(string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end, ',' order by case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end), '')
         from pg_proc p, aclexplode(p.proacl) a
        where p.oid = 'public.fill_rating_outcomes(jsonb)'::regprocedure and a.grantee <> p.proowner) is distinct from 'outcome_filler') is not false then
    raise exception 'db/039 ABORTED, rolled back: fill_rating_outcomes'' ACL is not exactly its owner and outcome_filler';
  end if;
end $$;

commit;
