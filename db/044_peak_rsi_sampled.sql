-- db/044 (2026-11-14): the peak RSI is SAMPLED, per position, in the database, with its provenance. Run 1 of 2. Paste
-- whole; one transaction. After db/043. Ruled by the reviewer (review-db044-design.md, CC-db044-ruled-build-it.md).
--
-- WHY: the peak RSI during a hold lived only on Roman's phone (localStorage, keyed by TICKER), and was copied into
-- trades_v2.peak_rsi_during_hold at the sale. It was lost to a cleared site or a new device, shared between two lots of
-- a ticker, and, until dd1ba4e, contaminated by a fallback that wrote the buy's RSI in as if measured. The stored rows
-- cannot be sorted after the fact. And it is SAMPLED, not measured: it is the maximum over the moments Roman had the
-- Portfolio tab open. The names say so.
--
-- WHAT:
--   peak_corrections (new): the log a deliberate correction must write BEFORE it may change a peak. It holds the old
--     and the new value, the reason, the row, the time and who did it. RLS is on with no policy, and anon and
--     authenticated get no grant, so the app can neither read nor write it.
--   trades_v2 (the sale record):
--     peak_rsi_provenance     sampled_since | not_sampled | not_established | corrected. NULL is allowed ONLY until
--                             db/045 (the cached-build window): a build that has not reloaded does not send it, and
--                             a NOT NULL column with no default would refuse that build's sale. There is NO DEFAULT,
--                             now or later: a default is a provenance nobody determined.
--     peak_rsi_sampled_from   when sampling began. Present exactly when sampled_since, NULL otherwise.
--     peak_rsi_correction_id  the peak_corrections row that justifies a corrected value. Present exactly when corrected.
--     Every existing row is set to not_established, EXPLICITLY, and the count is checked.
--     CHECKs: the value list; the timestamp in exactly the one state; sampled_since carries a peak; not_sampled carries
--     none; the correction id in exactly the corrected state.
--     WRITE-ONCE, with a door: once a row's provenance is set, its four peak columns change only through a
--     correction (below). NULL -> value is the first classification and is allowed (db/045 needs it).
--   portfolio (the open position; the app writes it while sampling):
--     peak_rsi, peak_rsi_at, peak_rsi_sampled_from: all NULL together, or all set with sampled_from <= peak_rsi_at.
--     RISING ONLY, on peak_rsi and on peak_price: a BEFORE UPDATE trigger keeps the GREATEST of the stored and the
--     sent value, and the timestamp that goes with the winner. The app sends the whole row, so a second session with
--     a stale, lower peak would otherwise lower it (last writer wins; the 11-06/11-10 duplicate sales came from such
--     a session). GREATEST IGNORES NULLS in Postgres: GREATEST(NULL, 5) = 5 and GREATEST(5, NULL) = 5. So a first
--     value over NULL is taken, and a NULL sent over a value keeps the value. That is not MAX-style null
--     propagation, and it is what is wanted in both directions.
--     ONE EXEMPTION, the fill: when filled_at goes from NULL to a value, the row is a position from that moment, and
--     its peaks start over at what the app sends (Mark filled resets peak_price to the fill price, app.js; a pending
--     order's peak was its order price, never traded).
--   THE CORRECTION DOOR (both tables). A peak may be lowered or rewritten only when ALL THREE hold:
--     1. the session's role is a member of the table's owner (the app's anon and authenticated roles, and
--        outcome_filler, never are);
--     2. `set local edge2.correction = '<reason>'` in the same transaction;
--     3. a peak_corrections row for THIS row, THIS column, recording exactly this old and new value and this reason,
--        already exists.
--     A correction attempted with 1 and 2 but no matching log row RAISES: an attempted correction without its
--     evidence is an error, never a silent no-op. Without 1 or 2, the trigger's ordinary rule applies (rising only on
--     portfolio, write-once on trades_v2). A corrected sale row says `corrected` and points at its log row.
--
-- GUARDS (three-state: proceeds only on a definite agreement with the live schema; else aborts and changes nothing):
-- none of the new objects exists; each column this relies on exists with the captured type; and the backfill
-- updates exactly the row count read at the start, in the same transaction.
-- Tested before sending: the 2026-11-11b capture rebuilt in PGlite, run 1, run 2, the door both ways, both GREATEST
-- cases, the fill exemption, the rollback and every guard (harness outside the repo).
begin;

do $$
declare
  n int;
  t text;
begin
  -- nothing of db/044 exists yet
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trades_v2'
              and column_name in ('peak_rsi_provenance', 'peak_rsi_sampled_from', 'peak_rsi_correction_id'))) is not false then
    raise exception 'db/044 ABORTED, nothing changed: trades_v2 already has a db/044 column (db/044 is applied, or half-applied: read the schema)';
  end if;
  if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'portfolio'
              and column_name in ('peak_rsi', 'peak_rsi_at', 'peak_rsi_sampled_from'))) is not false then
    raise exception 'db/044 ABORTED, nothing changed: portfolio already has a db/044 column';
  end if;
  if (to_regclass('public.peak_corrections') is not null) is not false then
    raise exception 'db/044 ABORTED, nothing changed: peak_corrections already exists';
  end if;
  -- what it relies on, with the captured types
  for t in select unnest(array['trades_v2.peak_rsi_during_hold:numeric', 'trades_v2.id:uuid', 'portfolio.peak_price:numeric',
                               'portfolio.peak_price_date:timestamp with time zone', 'portfolio.filled_at:timestamp with time zone',
                               'portfolio.position_id:text']) loop
    select count(*) into n from information_schema.columns
     where table_schema = 'public' and table_name = split_part(t, '.', 1)
       and column_name = split_part(split_part(t, '.', 2), ':', 1) and data_type = split_part(t, ':', 2);
    if (n <> 1) is not false then
      raise exception 'db/044 ABORTED, nothing changed: expected column % (as captured 2026-11-11b), found % match(es)', t, n;
    end if;
  end loop;
end $$;

-- ── the correction log ──────────────────────────────────────────────────────────────────────────────────────────
create table peak_corrections (
  id               bigint generated always as identity primary key,
  table_name       text not null check (table_name in ('trades_v2', 'portfolio')),
  row_key          text not null,
  column_name      text not null check (column_name in ('peak_rsi_during_hold', 'peak_rsi', 'peak_price')),
  old_value        numeric,
  new_value        numeric,
  provenance_written text not null,
  reason           text not null check (length(btrim(reason)) > 0),
  -- when, and as whom: FORCED by peak_corrections_stamp below, never defaulted. A default is used only when the column
  -- is omitted; an insert that names it would attest to a time and a user of its own choosing (a copied row, a
  -- replayed log, a restore). This is the one table whose purpose is to be believed later. (The reviewer, 2026-11-14.)
  corrected_at     timestamptz not null,
  corrected_by     text not null
);
create function peak_corrections_stamp() returns trigger language plpgsql as $f$
begin
  new.corrected_at := now();          -- overwritten unconditionally, whatever the insert supplied
  new.corrected_by := current_user;   -- the role in effect, which the door requires to be the owner's
  return new;
end $f$;
create trigger peak_corrections_stamp before insert on peak_corrections
  for each row execute function peak_corrections_stamp();
alter table peak_corrections enable row level security;
revoke all on peak_corrections from anon, authenticated;
comment on table peak_corrections is 'db/044: the evidence for a deliberate correction of a peak (trades_v2.peak_rsi_during_hold, portfolio.peak_rsi, portfolio.peak_price), written BEFORE the correction, which the triggers require. Owner only.';

-- ── trades_v2 ───────────────────────────────────────────────────────────────────────────────────────────────────
alter table trades_v2 add column peak_rsi_provenance text;
alter table trades_v2 add column peak_rsi_sampled_from timestamptz;
alter table trades_v2 add column peak_rsi_correction_id bigint references peak_corrections (id);

do $$
declare
  before_n bigint;
  updated bigint;
begin
  select count(*) into before_n from trades_v2;
  update trades_v2 set peak_rsi_provenance = 'not_established' where peak_rsi_provenance is null;
  get diagnostics updated = row_count;
  if (updated <> before_n) is not false then
    raise exception 'db/044 ABORTED, nothing changed: the backfill updated % rows, but trades_v2 holds % (both read in this transaction)', updated, before_n;
  end if;
  raise notice 'db/044: % trades_v2 rows set to not_established', updated;
end $$;

alter table trades_v2 add constraint trades_v2_peak_rsi_provenance_chk check (
  peak_rsi_provenance is null   -- only until db/045 (the cached-build window)
  or peak_rsi_provenance in ('sampled_since', 'not_sampled', 'not_established', 'corrected'));
alter table trades_v2 add constraint trades_v2_peak_rsi_sampled_from_chk check (
  (peak_rsi_sampled_from is not null) = (peak_rsi_provenance is not distinct from 'sampled_since'));
alter table trades_v2 add constraint trades_v2_peak_rsi_sampled_has_peak_chk check (
  peak_rsi_provenance is distinct from 'sampled_since' or peak_rsi_during_hold is not null);
alter table trades_v2 add constraint trades_v2_peak_rsi_not_sampled_chk check (
  peak_rsi_provenance is distinct from 'not_sampled' or peak_rsi_during_hold is null);
alter table trades_v2 add constraint trades_v2_peak_rsi_correction_chk check (
  (peak_rsi_correction_id is not null) = (peak_rsi_provenance is not distinct from 'corrected'));

comment on column trades_v2.peak_rsi_provenance is 'db/044: how peak_rsi_during_hold was established. sampled_since: the max over the moments the Portfolio tab rendered this position, from peak_rsi_sampled_from (a max over an unknown number of samples, NOT a measurement of the hold); not_sampled: no render saw it, and there is no peak; not_established: cannot be told after the fact (every row before db/044, and any row an older build wrote before db/045); corrected: set by a deliberate correction, see peak_rsi_correction_id. NULL only until db/045. No default, ever.';
comment on column trades_v2.peak_rsi_sampled_from is 'db/044: when sampling of this position began (its first sample). Present exactly when peak_rsi_provenance = sampled_since.';
comment on column trades_v2.peak_rsi_correction_id is 'db/044: the peak_corrections row that justifies a corrected peak. Present exactly when peak_rsi_provenance = corrected.';

-- ── portfolio ───────────────────────────────────────────────────────────────────────────────────────────────────
alter table portfolio add column peak_rsi numeric;
alter table portfolio add column peak_rsi_at timestamptz;
alter table portfolio add column peak_rsi_sampled_from timestamptz;
alter table portfolio add constraint portfolio_peak_rsi_chk check (
  (peak_rsi is null and peak_rsi_at is null and peak_rsi_sampled_from is null)
  or (peak_rsi is not null and peak_rsi_at is not null and peak_rsi_sampled_from is not null and peak_rsi_sampled_from <= peak_rsi_at));
comment on column portfolio.peak_rsi is 'db/044: the highest RSI SAMPLED for this position (the Portfolio tab renders), rising only (trigger portfolio_peaks_rising_only). Copied to trades_v2.peak_rsi_during_hold at the sale.';
comment on column portfolio.peak_rsi_at is 'db/044: when peak_rsi was sampled.';
comment on column portfolio.peak_rsi_sampled_from is 'db/044: this position''s first sample; copied to trades_v2.peak_rsi_sampled_from at the sale.';

-- ── the door, shared ────────────────────────────────────────────────────────────────────────────────────────────
-- 'open' when all three hold for this row and column (and, given log_id, it is THAT log row: a corrected sale row
-- points at its own justification); 'closed' when the session is not the owner or no correction is
-- declared; RAISES when a correction is declared by the owner but its log row is missing (evidence before the act).
create function peak_correction_door(tbl regclass, p_row_key text, col text, old_v numeric, new_v numeric, prov text, log_id bigint default null)
returns text language plpgsql as $f$
declare
  v_reason text := nullif(current_setting('edge2.correction', true), '');
  owner_ok boolean := pg_has_role(current_user, (select relowner from pg_class where oid = tbl), 'MEMBER');
begin
  if v_reason is null or not owner_ok then return 'closed'; end if;
  if exists (select 1 from peak_corrections c
              where c.table_name = (select relname from pg_class where oid = tbl) and c.row_key = p_row_key
                and c.column_name = col and c.old_value is not distinct from old_v and c.new_value is not distinct from new_v
                and c.reason = v_reason and c.provenance_written = prov
                and (log_id is null or c.id = log_id)) then
    return 'open';
  end if;
  raise exception 'db/044: a correction of %.% for % was declared (edge2.correction = %) but no peak_corrections row records old % -> new % with that reason. Write the log row first.',
    (select relname from pg_class where oid = tbl), col, p_row_key, v_reason, old_v, new_v;
end $f$;

-- ── trades_v2: write-once, with the door ────────────────────────────────────────────────────────────────────────
create function trades_v2_peak_rsi_write_once() returns trigger language plpgsql as $f$
begin
  if old.peak_rsi_during_hold is not distinct from new.peak_rsi_during_hold
     and old.peak_rsi_provenance is not distinct from new.peak_rsi_provenance
     and old.peak_rsi_sampled_from is not distinct from new.peak_rsi_sampled_from
     and old.peak_rsi_correction_id is not distinct from new.peak_rsi_correction_id then
    return new;                                                     -- nothing of the peak changes
  end if;
  if old.peak_rsi_provenance is null and new.peak_rsi_provenance is not null
     and old.peak_rsi_during_hold is not distinct from new.peak_rsi_during_hold
     and old.peak_rsi_sampled_from is not distinct from new.peak_rsi_sampled_from
     and old.peak_rsi_correction_id is not distinct from new.peak_rsi_correction_id then
    return new;                                                     -- the first classification (db/045)
  end if;
  if new.peak_rsi_provenance is not distinct from 'corrected'
     and peak_correction_door(tg_relid, new.id::text, 'peak_rsi_during_hold', old.peak_rsi_during_hold,
                              new.peak_rsi_during_hold, 'corrected', new.peak_rsi_correction_id) = 'open' then
    return new;
  end if;
  raise exception 'trades_v2 %: the peak RSI and its provenance are write-once (db/044); a change goes through a correction (peak_corrections, edge2.correction, the owner)', old.id;
end $f$;
create trigger trades_v2_peak_rsi_write_once before update on trades_v2
  for each row execute function trades_v2_peak_rsi_write_once();

-- ── portfolio: rising only, with the fill exemption and the door ────────────────────────────────────────────────
create function portfolio_peaks_rising_only() returns trigger language plpgsql as $f$
declare
  g numeric;
begin
  -- the fill: the row becomes a position now, and its peaks start over at what is sent. EXACTLY AS NARROW AS ITS
  -- REASON: only on the transition of filled_at from NULL to a value, in that same update. A later update, with
  -- filled_at already set (changed or not), is no fill and cannot lower either peak (pinned by the harness).
  -- ASYMMETRY, written down rather than discovered: peak_price has no provenance column, so a reset here leaves no
  -- trace in the row (peak_rsi's reset at a fill is to NULL, and the sale says not_sampled or sampled_since with its
  -- start). Not expanded in scope (the reviewer, 2026-11-14).
  if old.filled_at is null and new.filled_at is not null then return new; end if;

  -- peak_rsi. GREATEST ignores NULLs: GREATEST(NULL, x) = x (a first sample is taken), GREATEST(x, NULL) = x (a
  -- NULL sent over a value keeps the value).
  g := greatest(old.peak_rsi, new.peak_rsi);
  if g is distinct from new.peak_rsi then
    if peak_correction_door(tg_relid, new.position_id, 'peak_rsi', old.peak_rsi, new.peak_rsi, 'corrected') <> 'open' then
      new.peak_rsi := g;
      new.peak_rsi_at := old.peak_rsi_at;                           -- the timestamp goes with the winner
    end if;
  end if;
  -- sampling began at the earliest first sample either side knows (LEAST ignores NULLs the same way)
  if new.peak_rsi is not null then
    new.peak_rsi_sampled_from := least(old.peak_rsi_sampled_from, new.peak_rsi_sampled_from);
  end if;

  -- peak_price, the same rule
  g := greatest(old.peak_price, new.peak_price);
  if g is distinct from new.peak_price then
    if peak_correction_door(tg_relid, new.position_id, 'peak_price', old.peak_price, new.peak_price, 'corrected') <> 'open' then
      new.peak_price := g;
      new.peak_price_date := old.peak_price_date;
    end if;
  end if;
  return new;
end $f$;
create trigger portfolio_peaks_rising_only before update on portfolio
  for each row execute function portfolio_peaks_rising_only();

-- ── post-conditions, before commit ──────────────────────────────────────────────────────────────────────────────
do $$
declare
  n_other bigint; n_null bigint; n_ne bigint;
begin
  select count(*) filter (where peak_rsi_provenance = 'not_established'),
         count(*) filter (where peak_rsi_provenance is distinct from 'not_established' and peak_rsi_provenance is not null),
         count(*) filter (where peak_rsi_provenance is null)
    into n_ne, n_other, n_null from trades_v2;
  if (n_other <> 0 or n_null <> 0) is not false then
    raise exception 'db/044 ABORTED, nothing changed: after the backfill % rows are not not_established (% other, % null)', n_other + n_null, n_other, n_null;
  end if;
  raise notice 'db/044 run 1 done: % trades_v2 rows not_established, 0 other, 0 null. Now run 2.', n_ne;
end $$;

commit;
