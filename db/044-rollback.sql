-- db/044 ROLLBACK. Paste whole; one transaction. Undoes run 1 exactly, and ONLY while it would lose nothing:
-- it refuses (changing nothing) if any trades_v2 row holds a peak provenance other than run 1's not_established
-- or an older build's NULL, if any portfolio row holds a sampled peak, or if any correction has been logged. Past
-- that point a rollback would destroy what the new build recorded; that is a decision, not a paste.
begin;

do $$
declare
  n_written bigint; n_pf bigint; n_log bigint;
begin
  if (to_regclass('public.peak_corrections') is null
      or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trades_v2' and column_name = 'peak_rsi_provenance')) is not false then
    raise exception 'db/044 ROLLBACK ABORTED, nothing changed: db/044 is not applied (no peak_corrections, or no trades_v2.peak_rsi_provenance)';
  end if;
  select count(*) into n_written from trades_v2 where peak_rsi_provenance is not null and peak_rsi_provenance <> 'not_established';
  select count(*) into n_pf from portfolio where peak_rsi is not null;
  select count(*) into n_log from peak_corrections;
  if (n_written <> 0 or n_pf <> 0 or n_log <> 0) is not false then
    raise exception 'db/044 ROLLBACK ABORTED, nothing changed: it would destroy recorded data: % sale rows with a sampled/not_sampled/corrected provenance, % positions with a sampled peak, % logged corrections', n_written, n_pf, n_log;
  end if;
end $$;

drop trigger portfolio_peaks_rising_only on portfolio;
drop function portfolio_peaks_rising_only();
drop trigger trades_v2_peak_rsi_write_once on trades_v2;
drop function trades_v2_peak_rsi_write_once();
drop function peak_correction_door(regclass, text, text, numeric, numeric, text, bigint);
alter table portfolio drop constraint portfolio_peak_rsi_chk;
alter table portfolio drop column peak_rsi_sampled_from;
alter table portfolio drop column peak_rsi_at;
alter table portfolio drop column peak_rsi;
alter table trades_v2 drop constraint trades_v2_peak_rsi_correction_chk;
alter table trades_v2 drop constraint trades_v2_peak_rsi_not_sampled_chk;
alter table trades_v2 drop constraint trades_v2_peak_rsi_sampled_has_peak_chk;
alter table trades_v2 drop constraint trades_v2_peak_rsi_sampled_from_chk;
alter table trades_v2 drop constraint trades_v2_peak_rsi_provenance_chk;
alter table trades_v2 drop column peak_rsi_correction_id;
alter table trades_v2 drop column peak_rsi_sampled_from;
alter table trades_v2 drop column peak_rsi_provenance;
drop trigger peak_corrections_stamp on peak_corrections;
drop function peak_corrections_stamp();
drop table peak_corrections;

do $$
begin
  if (exists (select 1 from information_schema.columns where table_schema = 'public'
              and ((table_name = 'trades_v2' and column_name in ('peak_rsi_provenance', 'peak_rsi_sampled_from', 'peak_rsi_correction_id'))
                or (table_name = 'portfolio' and column_name in ('peak_rsi', 'peak_rsi_at', 'peak_rsi_sampled_from'))))
      or to_regclass('public.peak_corrections') is not null) is not false then
    raise exception 'db/044 ROLLBACK ABORTED, nothing changed: something of db/044 is still there after the drops';
  end if;
  raise notice 'db/044 rolled back: the schema is db/043''s again.';
end $$;

commit;
