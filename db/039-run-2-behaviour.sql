-- SUPABASE WILL SAY "Failed to run sql query" FOR A PASS. This file ends by raising an error ON PURPOSE, so
-- that everything it tried is rolled back. The result is the "RESULT:" line inside that error message: read it,
-- not the red label. (Read three times as a failure: db/035, db/040, db/037.)
-- db/039 run 2 of 2: behaviour, after run 1. Expected: an ERROR reading
-- "db/039 run 2 RESULT: PASS | ...". It raises on purpose, so everything rolls back and no row keeps
-- anything this wrote. Any WRONG entry names what failed.
do $$
declare
  refused text := '';
  allowed text := '';
  wrong text := '';
  target rating_snapshots%rowtype;
  n integer;
  expected_revision constant text := '2026-11-06-a';
  applied_revision text;
begin
  -- which db/039 ran: read back from the database, never assumed
  applied_revision := substring(coalesce(obj_description(to_regprocedure('public.fill_rating_outcomes(jsonb)'), 'pg_proc'), '') from 'db039_revision=([^ ]+)');
  if (applied_revision is distinct from expected_revision) is not false then
    raise exception 'db/039 run 2 RESULT: FAIL | applied revision %, this check expects %. Run the current db/039, not an earlier copy.', coalesce(applied_revision, 'none'), expected_revision;
  end if;
  select * into target from rating_snapshots order by id limit 1;
  if (target.id is null) is not false then raise exception 'db/039 run 2: rating_snapshots read back empty'; end if;

  -- MUST BE REFUSED (42501). A refused sub-block rolls back, undoing its role switch.
  begin set local role anon; update rating_snapshots set ret_close = 0 where false;
    wrong := wrong || ' [anon UPDATE of an outcome allowed]';
  exception when insufficient_privilege then refused := refused || ' anon-UPDATE'; end;
  begin set local role anon; perform fill_rating_outcomes('[]'::jsonb);
    wrong := wrong || ' [anon ran fill_rating_outcomes]';
  exception when insufficient_privilege then refused := refused || ' anon-RPC'; end;
  begin set local role outcome_filler; update rating_snapshots set score = score where false;
    wrong := wrong || ' [outcome_filler UPDATE of score allowed]';
  exception when insufficient_privilege then refused := refused || ' filler-UPDATE-score'; end;
  begin set local role outcome_filler; update rating_snapshots set price = price where false;
    wrong := wrong || ' [outcome_filler UPDATE of price allowed]';
  exception when insufficient_privilege then refused := refused || ' filler-UPDATE-price'; end;
  begin set local role outcome_filler; insert into rating_snapshots (ticker) select ticker from rating_snapshots where false;
    wrong := wrong || ' [outcome_filler INSERT allowed]';
  exception when insufficient_privilege then refused := refused || ' filler-INSERT'; end;
  begin set local role outcome_filler; delete from rating_snapshots where false;
    wrong := wrong || ' [outcome_filler DELETE allowed]';
  exception when insufficient_privilege then refused := refused || ' filler-DELETE'; end;

  -- THE FUNCTION, BY BEHAVIOUR, NOT FROM THE CATALOG. rls_auto_enable() turned out to be SECURITY DEFINER
  -- with EXECUTE granted to anon, and a function is where a privilege mistake can't be seen from outside.
  begin set local role authenticated; perform fill_rating_outcomes('[]'::jsonb);
    wrong := wrong || ' [authenticated ran fill_rating_outcomes]';
  exception when insufficient_privilege then refused := refused || ' authenticated-RPC'; end;
  -- service_role: the live default ACL gave it EXECUTE on every new function; revision a revokes it. Where the role
  -- exists (it does on Supabase), it must be refused by behaviour.
  if (exists (select 1 from pg_roles where rolname = 'service_role')) is not false then
    begin set local role service_role; perform fill_rating_outcomes('[]'::jsonb);
      wrong := wrong || ' [service_role ran fill_rating_outcomes: the default ACL''s EXECUTE survived]';
    exception when insufficient_privilege then refused := refused || ' service_role-RPC'; end;
  else
    refused := refused || ' service_role-RPC(no such role here)';
  end if;
  -- A throwaway role, rolled back with everything else. With no grant it must be refused: EXECUTE was
  -- revoked from PUBLIC. Given EXECUTE, it must STILL be refused, by the table: that is what SECURITY
  -- INVOKER means. If the function ran as its owner, this update would land.
  begin
    create role db039_probe nologin;
    execute format('grant db039_probe to %I', current_user);
    grant usage on schema public to db039_probe;
  exception when others then wrong := wrong || ' [could not create the probe role: ' || sqlerrm || ']'; end;
  begin set local role db039_probe; perform fill_rating_outcomes('[]'::jsonb);
    wrong := wrong || ' [a role with no grant ran fill_rating_outcomes: PUBLIC still has EXECUTE]';
  exception when insufficient_privilege then refused := refused || ' no-grant-RPC'; end;
  begin
    grant execute on function fill_rating_outcomes(jsonb) to db039_probe;
    set local role db039_probe;
    n := fill_rating_outcomes(jsonb_build_array(jsonb_build_object('id', target.id, 'ret_30m', 0.0999)));
    wrong := wrong || format(' [SECURITY DEFINER behaviour: a role with EXECUTE and no table grant updated %s row(s)]', n);
  exception when insufficient_privilege then refused := refused || ' invoker-needs-the-table-grant'; end;
  perform set_config('role', 'none', true);
  if ((select ret_30m from rating_snapshots where id = target.id) is not null) is not false then wrong := wrong || ' [the probe wrote ret_30m]'; end if;

  -- MUST WORK: a real insert-and-reselect through the RPC, as the role, on a real row.
  begin
    set local role outcome_filler;
    n := fill_rating_outcomes(jsonb_build_array(jsonb_build_object('id', target.id, 'ret_5m', 0.0123, 'outcome_selection', 'first_in_30min')));
    if (n <> 1) is not false then wrong := wrong || format(' [RPC updated %s rows, not 1]', n); end if;
    n := fill_rating_outcomes(jsonb_build_array(jsonb_build_object('id', target.id, 'ret_15m', 0.0456)));
    if (n <> 1) is not false then wrong := wrong || format(' [second RPC updated %s rows, not 1]', n); end if;
    n := fill_rating_outcomes(jsonb_build_array(jsonb_build_object('id', -1, 'ret_5m', 0.5)));
    if (n <> 0) is not false then wrong := wrong || format(' [an id that does not exist updated %s rows]', n); end if;
    allowed := allowed || ' filler-RPC';
  exception when others then wrong := wrong || ' [outcome_filler RPC refused: ' || sqlerrm || ']'; end;
  perform set_config('role', 'none', true);
  select * into target from rating_snapshots where id = target.id;
  if (target.ret_5m is distinct from 0.0123) is not false then wrong := wrong || ' [ret_5m did not land]'; end if;
  if (target.ret_15m is distinct from 0.0456) is not false then wrong := wrong || ' [ret_15m did not land]'; end if;
  if (target.outcome_selection is distinct from 'first_in_30min') is not false then wrong := wrong || ' [a later patch cleared outcome_selection]'; end if;

  -- MUST STILL WORK: what the app writes and reads.
  begin set local role anon; insert into rating_snapshots (ticker, tier) select ticker, tier from rating_snapshots where false;
    allowed := allowed || ' anon-INSERT';
  exception when others then wrong := wrong || ' [anon INSERT refused: ' || sqlerrm || ']'; end;
  begin set local role anon; perform 1 from rating_snapshots where false;
    allowed := allowed || ' anon-SELECT';
  exception when others then wrong := wrong || ' [anon SELECT refused: ' || sqlerrm || ']'; end;

  if (wrong <> '') is not false then raise exception 'db/039 run 2 RESULT: WRONG:% | refused:% | allowed:%', wrong, refused, allowed; end if;
  raise exception 'db/039 run 2 RESULT: PASS | revision % | refused (expected 10):% | still allowed (expected 3):%', applied_revision, refused, allowed;
end $$;
