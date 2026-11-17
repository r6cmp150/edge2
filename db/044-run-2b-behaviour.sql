-- SUPABASE WILL SAY "Failed to run sql query" FOR A PASS. This file ends by raising an error ON PURPOSE, so that
-- everything it tried is rolled back. The result is the "RESULT:" line inside that error message: read it, not the
-- red label. Send the whole message: it carries the grants as well as the result.
-- db/044 run 2b (2026-11-17): run 2 again, corrected. db/044 IS APPLIED (2026-11-14, verified from the capture by the
-- reviewer); run 2 was INCOMPLETE, not failed: its write-once probe got 42501, a GRANT refusal, before the trigger.
-- WHY, from the 2026-11-06 grants baseline: the probe ran as outcome_filler, which holds SELECT on trades_v2 and
-- UPDATE on only 7 columns (best_exit_*, price_at_plus*, sell_timing_resolved), so its update of
-- peak_rsi_during_hold was refused by the column grant. The harness had MODELLED outcome_filler with full UPDATE; the
-- probe tested our assumption. So no non-owner role can write a peak column at all, and write-once's live audience is
-- the owner. This version:
--   PRINTS THE GRANTS IT DEPENDS ON FIRST, read from the catalog (pg_class.relacl and pg_attribute.attacl, every role,
--     table and column level) for trades_v2, portfolio and peak_corrections. Read-only, in the same transaction. If
--     it fails, the output says why; when it passes, the precondition is on the record (the reviewer, 2026-11-17).
--   write-once, where it can reach: the OWNER, with no correction declared, changing a peak -> refused by the trigger;
--   the grant layer, asserted: anon's UPDATE of trades_v2, and outcome_filler's UPDATE of a peak column -> 42501;
--   the positive control: outcome_filler updating one of ITS OWN columns still works (the trigger lets through an
--     update that changes nothing of the peak).
-- Everything else as run 2 (backfill, CHECKs, portfolio, door). Writes nothing.
-- Expected: "db/044 run 2b RESULT: PASS | backfill: ... | checks: refused 7 of 7, passed 4 of 4 | portfolio: 9 of 9 |
-- door: 3 of 3 | write-once (owner, undeclared): 1 of 1 | refused at the grant: 2 of 2 | outcome_filler's own column:
-- 1 of 1 | wrong: none. GRANTS: ..."
do $$
declare
  n_ne bigint; n_other bigint; n_null_old bigint; n_null_new bigint; newest_backfilled timestamptz;
  probes constant jsonb := jsonb_build_array(
    -- [provenance (json null = omit the three columns), sampled_from, peak, correction_id, expected, label]
    jsonb_build_array('bogus', null, 60, null, 'check', 'a value not on the list'),
    jsonb_build_array('sampled_since', null, 60, null, 'check', 'sampled_since without its timestamp'),
    jsonb_build_array('sampled_since', '2026-11-14T15:00:00Z', null, null, 'check', 'sampled_since without a peak'),
    jsonb_build_array('not_sampled', null, 60, null, 'check', 'not_sampled carrying a peak'),
    jsonb_build_array('not_established', '2026-11-14T15:00:00Z', 60, null, 'check', 'a timestamp outside sampled_since'),
    jsonb_build_array('corrected', null, 60, null, 'check', 'corrected without its log row'),
    jsonb_build_array('not_sampled', null, null, 1, 'check', 'a correction id outside corrected'),
    jsonb_build_array('sampled_since', '2026-11-14T15:00:00Z', 60, null, 'key', 'sampled_since with its timestamp and peak'),
    jsonb_build_array('not_sampled', null, null, null, 'key', 'not_sampled, no peak'),
    jsonb_build_array('not_established', null, 61, null, 'key', 'not_established'),
    jsonb_build_array(null, null, 61, null, 'key', 'a build that has not reloaded: no provenance (until db/045)'));
  p jsonb; src jsonb; outcome text;
  refused text := ''; passed text := ''; wrong text := ''; nr int := 0; np int := 0;
  pf record; got record; npf int := 0; ndoor int := 0; nwo int := 0; log_id bigint;
  pos text;
  ngrant int := 0; nown int := 0; grants text := '';
begin
  -- THE PRECONDITION, PRINTED: every grant on the three tables, table level and column level, read from the catalog.
  select coalesce(string_agg(line, ' || ' order by line), 'none') into grants from (
    select format('%s: %s=%s', c.relname, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                  string_agg(a.privilege_type, ',' order by a.privilege_type)) as line
      from pg_class c cross join lateral aclexplode(c.relacl) a
     where c.oid in ('public.trades_v2'::regclass, 'public.portfolio'::regclass, 'public.peak_corrections'::regclass)
       and a.grantee <> c.relowner                      -- every grantee but the owner: no role hides by not being listed
     group by c.relname, a.grantee
    union all
    select format('%s.(cols) %s=%s(%s)', c.relname, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, a.privilege_type,
                  string_agg(att.attname::text, ',' order by att.attname))
      from pg_class c join pg_attribute att on att.attrelid = c.oid and att.attacl is not null
      cross join lateral aclexplode(att.attacl) a
     where c.oid in ('public.trades_v2'::regclass, 'public.portfolio'::regclass, 'public.peak_corrections'::regclass)
     group by c.relname, a.grantee, a.privilege_type) g;

  -- the backfill
  select max(created_at) into newest_backfilled from trades_v2 where peak_rsi_provenance = 'not_established';
  select count(*) filter (where peak_rsi_provenance = 'not_established'),
         count(*) filter (where peak_rsi_provenance is not null and peak_rsi_provenance <> 'not_established'),
         count(*) filter (where peak_rsi_provenance is null and created_at <= newest_backfilled),
         count(*) filter (where peak_rsi_provenance is null and created_at > newest_backfilled)
    into n_ne, n_other, n_null_old, n_null_new from trades_v2;
  if (n_other <> 0) is not false then wrong := wrong || format(' [backfill: %s rows hold another value before any new build wrote]', n_other); end if;
  if (n_null_old <> 0) is not false then wrong := wrong || format(' [backfill: %s NULL rows as old as the backfilled ones]', n_null_old); end if;
  if (n_ne = 0) is not false then wrong := wrong || ' [backfill: no not_established row at all]'; end if;

  -- trades_v2's CHECKs, on copies of one row
  select to_jsonb(r) into src from trades_v2 r limit 1;
  for p in select * from jsonb_array_elements(probes) loop
    begin
      if jsonb_typeof(p -> 0) = 'null' then
        execute format('insert into trades_v2 (%s) select %s from jsonb_populate_record(null::trades_v2, $1)',
          (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(src - 'peak_rsi_provenance' - 'peak_rsi_sampled_from' - 'peak_rsi_correction_id') k),
          (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(src - 'peak_rsi_provenance' - 'peak_rsi_sampled_from' - 'peak_rsi_correction_id') k))
          using jsonb_set(src, '{peak_rsi_during_hold}', p -> 2);
      else
        execute 'insert into trades_v2 select (jsonb_populate_record(null::trades_v2, $1)).*'
          using src || jsonb_build_object('peak_rsi_provenance', p -> 0, 'peak_rsi_sampled_from', p -> 1,
                                          'peak_rsi_during_hold', p -> 2, 'peak_rsi_correction_id', p -> 3);
      end if;
      outcome := 'INSERTED';
    exception
      when check_violation then outcome := 'check';
      when foreign_key_violation then outcome := 'check';     -- a correction id with no log row is refused as well
      when unique_violation then outcome := 'key';
      when others then outcome := 'other: ' || sqlstate || ' ' || sqlerrm;
    end;
    if outcome = p ->> 4 and outcome = 'key' then np := np + 1; passed := passed || ' ' || (p ->> 5) || ';';
    elsif outcome = p ->> 4 then nr := nr + 1; refused := refused || ' ' || (p ->> 5) || ';';
    else wrong := wrong || format(' [%s: expected %s, got %s]', p ->> 5, p ->> 4, outcome);
    end if;
  end loop;

  -- portfolio: one row, from a clean state (the final raise undoes all of it)
  select position_id into pos from portfolio limit 1;
  if (pos is null) is not false then
    wrong := wrong || ' [portfolio: no row to probe, NOT TESTED]';
  else
    update portfolio set filled_at = null where position_id = pos;
    update portfolio set filled_at = now(), peak_rsi = null, peak_rsi_at = null, peak_rsi_sampled_from = null,
                         peak_price = 10, peak_price_date = now() where position_id = pos;       -- the fill: starts over
    select peak_rsi, peak_price into got from portfolio where position_id = pos;
    if got.peak_rsi is null and got.peak_price = 10 then npf := npf + 1; else wrong := wrong || ' [the fill did not reset the peaks]'; end if;
    update portfolio set peak_rsi = 60, peak_rsi_at = '2026-11-14T15:10:00Z', peak_rsi_sampled_from = '2026-11-14T15:00:00Z' where position_id = pos;
    select peak_rsi into got from portfolio where position_id = pos;
    if got.peak_rsi = 60 then npf := npf + 1; else wrong := wrong || ' [GREATEST(NULL, 60) is not 60]'; end if;
    update portfolio set peak_rsi = 55, peak_rsi_at = '2026-11-14T15:20:00Z' where position_id = pos;
    select peak_rsi, peak_rsi_at into got from portfolio where position_id = pos;
    if got.peak_rsi = 60 and got.peak_rsi_at = '2026-11-14T15:10:00Z' then npf := npf + 1; else wrong := wrong || format(' [a lower value moved the peak: %s at %s]', got.peak_rsi, got.peak_rsi_at); end if;
    update portfolio set peak_rsi = null, peak_rsi_at = null, peak_rsi_sampled_from = null where position_id = pos;
    select peak_rsi, peak_rsi_sampled_from into got from portfolio where position_id = pos;
    if got.peak_rsi = 60 and got.peak_rsi_sampled_from = '2026-11-14T15:00:00Z' then npf := npf + 1; else wrong := wrong || ' [GREATEST(60, NULL) is not 60]'; end if;
    update portfolio set peak_rsi = 70, peak_rsi_at = '2026-11-14T15:30:00Z', peak_rsi_sampled_from = '2026-11-14T15:25:00Z' where position_id = pos;
    select peak_rsi, peak_rsi_at, peak_rsi_sampled_from into got from portfolio where position_id = pos;
    if got.peak_rsi = 70 and got.peak_rsi_at = '2026-11-14T15:30:00Z' then npf := npf + 1; else wrong := wrong || ' [a higher value was not taken with its timestamp]'; end if;
    if got.peak_rsi_sampled_from = '2026-11-14T15:00:00Z' then npf := npf + 1; else wrong := wrong || ' [the earliest first sample was not kept]'; end if;
    update portfolio set peak_price = 12 where position_id = pos;
    update portfolio set peak_price = 11 where position_id = pos;
    select peak_price into got from portfolio where position_id = pos;
    if got.peak_price = 12 then npf := npf + 1; else wrong := wrong || ' [peak_price went down]'; end if;
    update portfolio set peak_price = null where position_id = pos;
    select peak_price into got from portfolio where position_id = pos;
    if got.peak_price = 12 then npf := npf + 1; else wrong := wrong || ' [a NULL peak_price replaced the value]'; end if;
    begin
      update portfolio set peak_rsi_at = null where position_id = pos;     -- the three move together or not at all
      wrong := wrong || ' [portfolio_peak_rsi_chk let peak_rsi_at go NULL alone]';
    exception when check_violation then npf := npf + 1;
    end;

    -- the door, on portfolio.peak_rsi (70 -> 50)
    perform set_config('edge2.correction', 'run 2 probe: a contaminated peak', true);
    begin
      update portfolio set peak_rsi = 50 where position_id = pos;
      wrong := wrong || ' [a declared correction with no log row went through]';
    exception when raise_exception then ndoor := ndoor + 1;
    end;
    insert into peak_corrections (table_name, row_key, column_name, old_value, new_value, provenance_written, reason)
      values ('portfolio', pos, 'peak_rsi', 70, 50, 'corrected', 'run 2 probe: a contaminated peak');
    execute 'set local role anon';
    update portfolio set peak_rsi = 50 where position_id = pos;
    execute 'reset role';
    perform set_config('edge2.correction', 'run 2 probe: a contaminated peak', true);
    select peak_rsi into got from portfolio where position_id = pos;
    if got.peak_rsi = 70 then ndoor := ndoor + 1; else wrong := wrong || ' [the anon role opened the door]'; end if;
    update portfolio set peak_rsi = 50 where position_id = pos;
    select peak_rsi into got from portfolio where position_id = pos;
    if got.peak_rsi = 50 then ndoor := ndoor + 1; else wrong := wrong || ' [the owner, declared and logged, could not correct]'; end if;
    perform set_config('edge2.correction', '', true);
  end if;

  -- write-once, where it can reach: the OWNER (this session), no correction declared, changing a peak
  perform set_config('edge2.correction', '', true);
  begin
    update trades_v2 set peak_rsi_during_hold = coalesce(peak_rsi_during_hold, 0) + 1 where id = (src ->> 'id')::uuid;
    wrong := wrong || ' [the owner changed a peak with no correction declared]';
  exception when raise_exception then if (sqlerrm like '%write-once%') is not false then nwo := nwo + 1; else wrong := wrong || format(' [write-once: %s]', sqlerrm); end if;
           when others then wrong := wrong || format(' [write-once (owner): %s %s]', sqlstate, sqlerrm);
  end;
  -- the grant layer: anon's UPDATE of trades_v2, and outcome_filler's UPDATE of a peak column, refused with 42501
  begin
    execute 'set local role anon';
    update trades_v2 set peak_rsi_during_hold = peak_rsi_during_hold where id = (src ->> 'id')::uuid;
    execute 'reset role';
    wrong := wrong || ' [anon updated trades_v2]';
  exception when insufficient_privilege then ngrant := ngrant + 1;
           when others then wrong := wrong || format(' [anon update: %s %s]', sqlstate, sqlerrm);
  end;
  begin
    execute 'set local role outcome_filler';
    update trades_v2 set peak_rsi_during_hold = peak_rsi_during_hold where id = (src ->> 'id')::uuid;
    execute 'reset role';
    wrong := wrong || ' [outcome_filler updated a peak column]';
  exception when insufficient_privilege then ngrant := ngrant + 1;
           when others then wrong := wrong || format(' [outcome_filler peak update: %s %s]', sqlstate, sqlerrm);
  end;
  -- the positive control: outcome_filler's OWN column still updates (the trigger lets through what changes no peak)
  begin
    execute 'set local role outcome_filler';
    update trades_v2 set sell_timing_resolved = sell_timing_resolved where id = (src ->> 'id')::uuid;
    execute 'reset role';
    nown := nown + 1;
  exception when others then wrong := wrong || format(' [outcome_filler own column: %s %s]', sqlstate, sqlerrm);
  end;

  raise exception 'db/044 run 2b RESULT: % | backfill: % not_established, % other, % null before run 1 (% written since) | checks: refused % of 7, passed % of 4 | portfolio: % of 9 | door: % of 3 | write-once (owner, undeclared): % of 1 | refused at the grant: % of 2 | outcome_filler''s own column: % of 1 | wrong:%. GRANTS (read from the catalog, this transaction): %. This message is raised on purpose so everything rolls back.',
    case when wrong = '' and nr = 7 and np = 4 and npf = 9 and ndoor = 3 and nwo = 1 and ngrant = 2 and nown = 1 then 'PASS' else 'FAIL' end,
    n_ne, n_other, n_null_old, n_null_new, nr, np, npf, ndoor, nwo, ngrant, nown,
    case when wrong = '' then ' none' else wrong end, grants;
end $$;
