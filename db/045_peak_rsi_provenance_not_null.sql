-- db/045: trades_v2.peak_rsi_provenance becomes NOT NULL. HELD: do not run until its gate is met. Paste whole; one
-- transaction. After db/044.
--
-- THE GATE IS A READ-BACK, NOT A DEPLOY (the reviewer, 2026-11-14). Not "the new build is live", not "the build stamp
-- says ...": a SALE WRITTEN BY THE NEW BUILD HAS BEEN READ BACK WITH THE COLUMN POPULATED. A build stamp says what was
-- served, not what a phone has loaded and written with. This file enforces the gate itself: it aborts, changing
-- nothing, unless trades_v2 already holds at least one row with peak_rsi_provenance = sampled_since or not_sampled
-- (values only the new build writes; db/044 wrote not_established). If you are reading this to decide whether to run
-- it, the question is not "has it deployed" but "has a sale landed with the column filled", and the file asks it.
--
-- WHY TWO STEPS (db/035 and db/036 did the same): a column lands nullable while an older build can still write to
-- it, and becomes NOT NULL only after the new build has been confirmed writing it. "No default" is right; "no default,
-- today" is a deploy-window outage: every sale from a phone that had not reloaded would be refused.
--
-- WHAT: any row still NULL (an older build's sale in the window) is set to not_established, explicitly, counted,
-- and reported: no build that wrote it recorded how its peak was established. Then SET NOT NULL, and the CHECK loses
-- its "is null" clause. Still no default.
begin;

do $$
declare
  n_new bigint; n_null bigint; updated bigint;
begin
  if (not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trades_v2'
                   and column_name = 'peak_rsi_provenance' and is_nullable = 'YES')) is not false then
    raise exception 'db/045 ABORTED, nothing changed: trades_v2.peak_rsi_provenance is missing (db/044 not applied) or already NOT NULL (db/045 applied)';
  end if;
  select count(*) into n_new from trades_v2 where peak_rsi_provenance in ('sampled_since', 'not_sampled');
  if (n_new < 1) is not false then
    raise exception 'db/045 ABORTED, nothing changed: THE GATE IS NOT MET. No sale written by the new build has been read back with its provenance (0 rows sampled_since or not_sampled). Wait for one.';
  end if;
  select count(*) into n_null from trades_v2 where peak_rsi_provenance is null;
  update trades_v2 set peak_rsi_provenance = 'not_established' where peak_rsi_provenance is null;
  get diagnostics updated = row_count;
  if (updated <> n_null) is not false then
    raise exception 'db/045 ABORTED, nothing changed: % NULL rows counted, % classified', n_null, updated;
  end if;
  raise notice 'db/045: gate met (% rows written by the new build); % window rows classified not_established', n_new, updated;
end $$;

alter table trades_v2 alter column peak_rsi_provenance set not null;
alter table trades_v2 drop constraint trades_v2_peak_rsi_provenance_chk;
alter table trades_v2 add constraint trades_v2_peak_rsi_provenance_chk check (
  peak_rsi_provenance in ('sampled_since', 'not_sampled', 'not_established', 'corrected'));
comment on column trades_v2.peak_rsi_provenance is 'db/044, NOT NULL since db/045: how peak_rsi_during_hold was established. sampled_since: the max over the moments the Portfolio tab rendered this position, from peak_rsi_sampled_from (a max over an unknown number of samples, NOT a measurement of the hold); not_sampled: no render saw it, and there is no peak; not_established: cannot be told after the fact (every row before db/044, and any row an older build wrote before db/045); corrected: set by a deliberate correction, see peak_rsi_correction_id. No default, ever.';

do $$
begin
  if (exists (select 1 from trades_v2 where peak_rsi_provenance is null)) is not false then
    raise exception 'db/045 ABORTED, nothing changed: a NULL survived';
  end if;
  raise notice 'db/045 done: peak_rsi_provenance is NOT NULL, with no default.';
end $$;

commit;
