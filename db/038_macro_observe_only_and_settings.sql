-- REVISION 2026-11-06-e. Run 2 reads this back from the database and fails on any other, so pasting an old copy
-- is detected, not announced against. A test ties this stamp to the file's contents.
-- REVISED 2026-11-06 (e): the macro path vocabulary separates "not measured" from "measured, indeterminate". The
-- engine running and classifying nothing was 'pattern_groq_failed' with a NULL condition, one value shared with
-- "the pattern classified, Groq failed", told apart only by an absence; it is now 'unclassified'. And "the writer sent
-- nothing" is 'unknown' in all three tables: portfolio.macro_path_at_buy was NULL for it, and is now NOT NULL DEFAULT
-- 'unknown', like rating_snapshots.macro_path and trades_v2.macro_path. One vocabulary, in every column's comment.
-- REVISED 2026-11-06 (d): macro_observations' grants are explicit (revoke all, then anon SELECT and INSERT), not
-- whatever the default ACL gives: after db/037 it would otherwise be the one EDGE table still open to authenticated
-- and to TRIGGER, REFERENCES and MAINTAIN. Run 2 probes its full grid, eight privileges by three roles.
-- REVISED 2026-11-05 (c): every guard is three-state: "if (<condition>) is not false then raise", so a guard
-- whose condition is NULL (could not be evaluated) aborts instead of proceeding. No guard's meaning changed.
-- REVISED 2026-11-05 (b): every CHECK made definite (spec §7.7: a CHECK passes on NULL). Revision a's
-- verdict_display_consistent ACCEPTED a CAPTURED state with nothing captured, and a captured object with no
-- state; sell_filled_at_consistent accepted a fill time with no source. Found by the schema harness before
-- anything was sent. Nullable columns now say "is null or" where NULL is intended (each one's comment says why).
-- REVISED 2026-11-05 (A): added trades_v2.verdict_displayed_at_sale and verdict_display_state.
-- REVISED 2026-11-05 (later): added rating_snapshots.scoring_version and scoring_hash.
-- REVISED 2026-11-05: added trades_v2.sell_filled_at and sell_filled_at_source, and
-- corrected sell_time's comment. ANY EARLIER COPY OF THIS FILE IS VOID: the build
-- writes both on every sale, so with an earlier copy every sale insert would fail.
-- REVISED 2026-11-04: added rating_snapshots.tier.
-- REVISED 2026-11-03: added macro_observations.unjudged_etfs and etf_bar_dates.
--
-- db/038 (2026-11-02): macro condition OBSERVE-ONLY, fully recorded; and the
-- four phone-only settings get Supabase columns. DRAFT, for Roman, AFTER
-- db/035 runs 2-5 and db/037. Run 1 of 2; the behaviour check is
-- db/038-run-2-behaviour.sql.
--
-- WHY (phase-10 spec, "Macro condition: observe-only"): an unrecorded Groq
-- judgment had been setting Roman's shortlist (the display cut 20 -> 65 on
-- GEOPOLITICAL/RISK_OFF days) with the banner hidden by the very switch that
-- claimed to turn macro off. Decision: the condition is shown and recorded,
-- and affects nothing. To test later whether the pattern rule or Groq
-- predicts anything (the pre-committed test), both answers must be stored
-- every day, with Groq's inputs, and every rating_snapshots row must say
-- which display cut it passed. Separately, riskPerTradePct,
-- floatThresholdShares, maxLossPct and developerTools live only in the
-- phone's localStorage, behind catch(e) {}, in no backup: the only data in
-- this project with no recovery path.
--
-- WHAT:
--   1. macro_observations: one row per macro fetch (each scan), holding
--      the ETF moves (a missing quote is NULL, never 0), the pattern
--      answer, Groq's answer when asked, Groq's full inputs and raw reply,
--      the path, the base cut in effect, and the per-category adjustment
--      that WOULD have applied. `applied` is CHECKed false: observe-only is
--      enforced here, not just in the app.
--   2. rating_snapshots: macro_path, display_threshold,
--      macro_observation_id, tier, scoring_version, scoring_hash.
--   3. trades_v2: macro_path, sell_filled_at, sell_filled_at_source, verdict_displayed_at_sale,
--      verdict_display_state; portfolio: macro_path_at_buy (carried to the sale).
--   4. settings: the four columns. NULL = never saved to Supabase; the app
--      shows that setting's source.
--
-- DEFAULTS ON EXISTING ROWS: macro_path defaults to 'unknown', the true
-- value for every row written before this (no path was recorded anywhere).
-- A constant default is metadata-only in Postgres 11+, so no existing row
-- is rewritten and no trigger fires (trades_v2's db/035 triggers included).
-- The live build, which doesn't send macro_path yet, keeps writing 'unknown'
-- until the observe-only build ships: also true. display_threshold and
-- macro_observation_id stay NULL on old rows: not recorded.
--
-- NO FOREIGN KEY from rating_snapshots.macro_observation_id: the two are
-- written separately, and a failed observation write must not take the
-- snapshot batch down with it. The id is a join key, documented as such.

begin;

do $$
declare
  t text;
  c text;
begin
  if (to_regprocedure('public.trades_v2_reject_provenance_change()') is null) is not false then
    raise exception 'db/038 ABORTED, nothing changed: trades_v2_reject_provenance_change does not exist, so db/035 has not run';
  end if;
  foreach t in array array['settings', 'rating_snapshots', 'trades_v2', 'portfolio'] loop
    if (to_regclass('public.' || t) is null) is not false then
      raise exception 'db/038 ABORTED, nothing changed: table public.% does not exist', t;
    end if;
  end loop;
  -- This table's create statement isn't in the repo, and rows under 60 are new to it.
  if (exists (select 1 from pg_constraint where conrelid = 'public.rating_snapshots'::regclass
              and contype = 'c' and pg_get_constraintdef(oid) ~ '(score|label)')) is not false then
    raise exception 'db/038 ABORTED, nothing changed: a CHECK on rating_snapshots.score or label could refuse rows the build now writes';
  end if;
  if (to_regclass('public.macro_observations') is not null) is not false then
    raise exception 'db/038 ABORTED, nothing changed: macro_observations already exists (db/038 applied already?)';
  end if;
  for t, c in select * from (values
      ('settings', 'risk_per_trade_pct'), ('settings', 'float_threshold_shares'),
      ('settings', 'max_loss_pct'), ('settings', 'developer_tools'),
      ('rating_snapshots', 'macro_path'), ('rating_snapshots', 'display_threshold'),
      ('rating_snapshots', 'macro_observation_id'), ('rating_snapshots', 'tier'), ('rating_snapshots', 'scoring_version'), ('rating_snapshots', 'scoring_hash'), ('trades_v2', 'macro_path'), ('trades_v2', 'sell_filled_at'), ('trades_v2', 'sell_filled_at_source'), ('trades_v2', 'verdict_displayed_at_sale'), ('trades_v2', 'verdict_display_state'),
      ('portfolio', 'macro_path_at_buy')) as v(t, c) loop
    if (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c)) is not false then
      raise exception 'db/038 ABORTED, nothing changed: %.% already exists', t, c;
    end if;
  end loop;
  -- The columns this file's design relies on, as the live schema has them.
  if (not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rating_snapshots' and column_name = 'macro_condition')) is not false then
    raise exception 'db/038 ABORTED, nothing changed: rating_snapshots.macro_condition is missing; the plan assumed it exists';
  end if;
  if ((select count(*) from settings) <> 1) is not false then
    raise exception 'db/038 ABORTED, nothing changed: settings has % rows, expected exactly 1 (Roman''s, id 3)', (select count(*) from settings);
  end if;
end $$;

-- 1. macro_observations
create table macro_observations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  fetched_at timestamptz not null,                 -- when the ETF quotes were read
  trading_date date not null,                      -- the PT session date they belong to
  source text not null check (source in ('browser', 'logger')),
  feed text not null check (feed in ('iex', 'sip')),
  etf_moves jsonb not null,                        -- {"SPY": 0.07, ..., "XLY": null}: null = quote missing, never 0
  missing_etfs text[] not null default '{}',
  unjudged_etfs text[] not null default '{}',      -- the quote is an earlier session's or undated: yesterday's move, so its move is NULL
  etf_bar_dates jsonb,                             -- {"SPY": "2026-11-03", ...}: each dailyBar's date; null = no dated bar. What the staleness call was made on
  pattern_condition text,                          -- NULL only when the moves were incomplete
  pattern_matched text[] not null default '{}',
  pattern_incomplete boolean not null,             -- true = a required ETF was missing or unjudged: the rule could not run, so its answer is withheld
  groq_asked boolean not null,
  groq_ask_reason text check (groq_ask_reason is null or groq_ask_reason in ('daily', 'pattern_changed')),
  groq_condition text,                             -- Groq's answer in effect: from this ask, or carried from the day's last ask (groq_asked false); NULL = none
  groq_failed boolean,                             -- NULL when not asked
  groq_error text,
  groq_model text,
  groq_temperature numeric,
  groq_request jsonb,                              -- news request: symbols, start, end, lookback_hours, filter_hours, limit
  groq_headlines jsonb,                            -- the headlines sent: [{id, created_at, source, headline}]
  groq_headlines_empty boolean,                    -- true = the prompt said "no recent headlines available"
  groq_raw_reply text,
  path text not null check (path in ('pattern', 'groq', 'pattern_groq_failed', 'unclassified', 'not_fetched')),
  condition text,                                  -- what the banner shows (from `path`); NULL = could not be determined
  display_threshold numeric not null,              -- the cut in effect: the base line, every day (observe-only)
  would_adjust jsonb,                              -- {"TECH": -15, ...}: MACRO_ADJUSTMENTS[condition], NOT APPLIED
  applied boolean not null default false check (applied = false),
  code_version jsonb,
  check (groq_asked = (groq_ask_reason is not null)),
  check (not groq_asked or groq_failed is not null)
);
comment on table macro_observations is 'db/038: one row per macro fetch. Observe-only: nothing here changes a score, the display cut, or what is stored as buyable (applied is CHECKed false). Both the pattern answer and Groq''s are kept so the pre-committed test (phase-10 spec) can measure which, if either, predicts anything. db038_revision=2026-11-06-e';
comment on column macro_observations.etf_moves is 'Percent change vs previous close at fetched_at, per ETF. NULL = the quote was missing or stale (never coerced to 0, which would read as a flat sector; never yesterday''s move read as today''s). missing_etfs and unjudged_etfs say which.';
comment on column macro_observations.unjudged_etfs is 'ETFs whose dailyBar was not from the reading''s own date (before that ETF''s first trade of the day the snapshot serves the previous session''s bar), or had no date. Their move is NULL: a stale quote gives a valid-looking move, so it is not classified from.';
comment on column macro_observations.path is 'Which answer the banner shows, and why. not_fetched = the app had no macro reading when it scored; pattern = the pattern classified the market; groq = Groq classified it; pattern_groq_failed = Groq was needed and failed, and the pattern''s classification is used; unclassified = the engine ran and neither the pattern nor Groq classified the market. A missing reading and an indeterminate one are different values, never one value and its absence.';
comment on column macro_observations.groq_request is 'The Alpaca news request behind the headlines. The feed is irreproducible by construction (now moves, no end bound, articles added and updated), so the stored headlines are the only record of what Groq saw.';
alter table macro_observations enable row level security;
create policy "anon insert" on macro_observations for insert to anon with check (true);
create policy "anon select" on macro_observations for select to anon using (true);
revoke all on macro_observations from anon, authenticated;
grant select, insert on macro_observations to anon; -- explicit (revision d): the default ACL is not relied on

-- 2. rating_snapshots
alter table rating_snapshots
  add column macro_path text not null default 'unknown'
    check (macro_path in ('pattern', 'groq', 'pattern_groq_failed', 'unclassified', 'not_fetched', 'unknown')),
  add column display_threshold numeric,
  add column macro_observation_id uuid,
  add column tier text check (tier is null or tier in ('SHOWN', 'BELOW_THRESHOLD')),
  add column scoring_version integer,
  add column scoring_hash text;
comment on column rating_snapshots.scoring_version is 'db/038: the scoring version that produced this score. Every reader keys off it. NULL = not recorded (before db/038), never "the same as now".';
comment on column rating_snapshots.scoring_hash is 'db/038: the hash of the formula that produced this score. NULL with a version set is a real state: a version with no hash.';
comment on column rating_snapshots.tier is 'db/038: SHOWN or BELOW_THRESHOLD, the scan''s own decision, as signal_log.tier. From this column on, every scored row is written. NULL = the earlier era: only shown signals scoring 60+ were written. Never pool the two without saying so.';
comment on column rating_snapshots.macro_path is 'db/038: how macro_condition was decided. unknown = the writer sent no macro reading (every row before db/038, and any writer that does not compute one); not_fetched = the app had no macro reading when it scored; pattern = the pattern classified the market; groq = Groq classified it; pattern_groq_failed = Groq was needed and failed, and the pattern''s classification is used; unclassified = the engine ran and neither the pattern nor Groq classified the market. A missing reading and an indeterminate one are different values, never one value and its absence.';
comment on column rating_snapshots.display_threshold is 'db/038: the display cut in force at this scan; tier says whether this row passed it. NULL = not recorded (before db/038). Before observe-only shipped, the cut rose to 65 on GEOPOLITICAL/RISK_OFF days, so older rows sit behind a cut that moved by day.';
comment on column rating_snapshots.macro_observation_id is 'db/038: join key to macro_observations.id (no FK: written separately, so a failed observation write cannot fail the snapshot batch).';

-- 3. trades_v2
alter table trades_v2
  add column macro_path text not null default 'unknown'
    check (macro_path in ('pattern', 'groq', 'pattern_groq_failed', 'unclassified', 'not_fetched', 'unknown')),
  add column sell_filled_at timestamptz,
  add column sell_filled_at_source text check (sell_filled_at_source is null or sell_filled_at_source in ('entered', 'default', 'not_known')),
  add constraint trades_v2_sell_filled_at_consistent check (
    (sell_filled_at_source is null and sell_filled_at is null)
    or (coalesce(sell_filled_at_source, '') = 'not_known' and sell_filled_at is null)
    or (coalesce(sell_filled_at_source, '') in ('entered', 'default') and sell_filled_at is not null));
alter table trades_v2
  add column verdict_displayed_at_sale jsonb,
  add column verdict_display_state text check (verdict_display_state is null or verdict_display_state in ('CAPTURED_BEFORE_FILL', 'CAPTURED_AFTER_FILL', 'CAPTURED_FILL_UNKNOWN', 'NOT_DISPLAYED')),
  add constraint trades_v2_verdict_display_consistent check (
    (verdict_display_state is null and verdict_displayed_at_sale is null)
    or (coalesce(verdict_display_state, '') = 'NOT_DISPLAYED' and verdict_displayed_at_sale is null)
    or (coalesce(verdict_display_state, '') like 'CAPTURED_%' and coalesce(jsonb_typeof(verdict_displayed_at_sale), '') = 'object'));
create trigger trades_v2_verdict_display_write_once before update on trades_v2
  for each row execute function trades_v2_reject_provenance_change('verdict_displayed_at_sale', 'verdict_display_state');
comment on column trades_v2.verdict_displayed_at_sale is 'db/038: what the app displayed when the sale was recorded, captured verbatim with its inputs. It audits the app''s output, so it records the app''s errors faithfully. See verdict_display_state for whether it preceded the fill. Write-once.';
comment on column trades_v2.verdict_display_state is 'db/038: CAPTURED_BEFORE_FILL / CAPTURED_AFTER_FILL need a typed fill; CAPTURED_AFTER_FILL is the normal case, because a sale is recorded after it is placed. CAPTURED_FILL_UNKNOWN: on screen, and nothing places it against the fill. NOT_DISPLAYED: no render, or recorded on a later day. NULL: a sale from before db/038. Write-once.';
comment on column trades_v2.sell_filled_at is 'db/038: when the sale filled. NULL: not known (see sell_filled_at_source), or a sale from before db/038, which has no fill recorded.';
comment on column trades_v2.sell_filled_at_source is 'db/038: entered = typed on the sell form; default = the form''s starting value accepted, which says nothing about the fill; not_known = Roman said so. NULL = a sale from before db/038.';
comment on column trades_v2.sell_time is 'When the sale was RECORDED, PT wall clock HH:MM, for every row ever written. Corrects db/027, which called this the sell fill: it never was. The fill is sell_filled_at.';
comment on column trades_v2.macro_path is 'db/038: how macro_condition at buy was decided, copied from the position. unknown = the writer sent no macro reading (every row before db/038, and any writer that does not compute one); not_fetched = the app had no macro reading when it scored; pattern = the pattern classified the market; groq = Groq classified it; pattern_groq_failed = Groq was needed and failed, and the pattern''s classification is used; unclassified = the engine ran and neither the pattern nor Groq classified the market. A missing reading and an indeterminate one are different values, never one value and its absence.';

-- 3b. portfolio: the buy's macro path rides on the open position until the
-- sale copies it to trades_v2 (positions round-trip through this table, so
-- without it a reload would lose it). NULL = bought before db/038.
alter table portfolio
  add column macro_path_at_buy text not null default 'unknown'
    check (macro_path_at_buy in ('pattern', 'groq', 'pattern_groq_failed', 'unclassified', 'not_fetched', 'unknown'));
comment on column portfolio.macro_path_at_buy is 'db/038: how macro_condition_at_buy was decided; copied to trades_v2.macro_path at sale. unknown = the writer sent no macro reading (every row before db/038, and any writer that does not compute one); not_fetched = the app had no macro reading when it scored; pattern = the pattern classified the market; groq = Groq classified it; pattern_groq_failed = Groq was needed and failed, and the pattern''s classification is used; unclassified = the engine ran and neither the pattern nor Groq classified the market. A missing reading and an indeterminate one are different values, never one value and its absence.';

-- 4. settings
alter table settings
  add column risk_per_trade_pct numeric check (risk_per_trade_pct is null or (risk_per_trade_pct > 0 and risk_per_trade_pct <= 100)),
  add column float_threshold_shares numeric check (float_threshold_shares is null or float_threshold_shares > 0),
  add column max_loss_pct numeric check (max_loss_pct is null or (max_loss_pct > 0 and max_loss_pct < 100)),
  add column developer_tools boolean;
comment on column settings.max_loss_pct is 'db/038: was phone-only (localStorage). NULL = never saved to Supabase; the app then shows which source it is using.';
comment on column settings.risk_per_trade_pct is 'db/038: was phone-only (localStorage). NULL = never saved to Supabase.';
comment on column settings.float_threshold_shares is 'db/038: was phone-only (localStorage). NULL = never saved to Supabase.';
comment on column settings.developer_tools is 'db/038: was phone-only (localStorage). NULL = never saved to Supabase.';

-- POST-CONDITION, before commit, both directions; any failure rolls the
-- whole file back.
do $$
declare
  missing text;
begin
  -- the columns exist, with their checks
  select string_agg(t || '.' || c, ', ') into missing from (values
      ('settings', 'risk_per_trade_pct'), ('settings', 'float_threshold_shares'),
      ('settings', 'max_loss_pct'), ('settings', 'developer_tools'),
      ('rating_snapshots', 'macro_path'), ('rating_snapshots', 'display_threshold'),
      ('rating_snapshots', 'macro_observation_id'), ('rating_snapshots', 'tier'), ('rating_snapshots', 'scoring_version'), ('rating_snapshots', 'scoring_hash'), ('trades_v2', 'macro_path'), ('trades_v2', 'sell_filled_at'), ('trades_v2', 'sell_filled_at_source'), ('trades_v2', 'verdict_displayed_at_sale'), ('trades_v2', 'verdict_display_state'),
      ('portfolio', 'macro_path_at_buy')) as v(t, c)
   where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c);
  if (missing is not null) is not false then raise exception 'db/038 ABORTED, rolled back: columns missing after the change: %', missing; end if;
  if (not exists (select 1 from pg_constraint where conrelid = 'public.macro_observations'::regclass and contype = 'c'
                  and pg_get_constraintdef(oid) ilike '%applied = false%')) is not false then
    raise exception 'db/038 ABORTED, rolled back: macro_observations has no applied = false CHECK (observe-only not enforced)';
  end if;
  -- existing rows read as unknown, not as a path nobody recorded
  if (exists (select 1 from rating_snapshots where macro_path <> 'unknown') or exists (select 1 from trades_v2 where macro_path <> 'unknown')) is not false then
    raise exception 'db/038 ABORTED, rolled back: an existing row has a macro_path other than unknown';
  end if;
  -- anon can still do what the app needs...
  if (not has_table_privilege('anon', 'public.macro_observations', 'INSERT')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'macro_observations' and cmd = 'INSERT' and roles && array['anon']::name[])) is not false then
    raise exception 'db/038 ABORTED, rolled back: anon cannot INSERT into macro_observations (grant or policy)';
  end if;
  select string_agg(c, ', ') into missing from unnest(array['risk_per_trade_pct', 'float_threshold_shares', 'max_loss_pct', 'developer_tools']) as c
   where not has_column_privilege('anon', 'public.settings', c, 'UPDATE') or not has_column_privilege('anon', 'public.settings', c, 'SELECT');
  if (missing is not null) is not false then raise exception 'db/038 ABORTED, rolled back: anon cannot read/update settings.%', missing; end if;
  select string_agg(c, ', ') into missing from unnest(array['macro_path', 'display_threshold', 'macro_observation_id', 'tier', 'scoring_version', 'scoring_hash']) as c
   where not has_column_privilege('anon', 'public.rating_snapshots', c, 'INSERT');
  if (missing is not null) is not false then raise exception 'db/038 ABORTED, rolled back: anon cannot insert rating_snapshots.%', missing; end if;
  if (not has_column_privilege('anon', 'public.trades_v2', 'macro_path', 'INSERT') or not has_column_privilege('anon', 'public.trades_v2', 'sell_filled_at', 'INSERT') or not has_column_privilege('anon', 'public.trades_v2', 'sell_filled_at_source', 'INSERT')) is not false then
    raise exception 'db/038 ABORTED, rolled back: anon cannot insert trades_v2.macro_path, sell_filled_at or sell_filled_at_source';
  end if;
  if (not has_column_privilege('anon', 'public.portfolio', 'macro_path_at_buy', 'INSERT')
     or not has_column_privilege('anon', 'public.portfolio', 'macro_path_at_buy', 'UPDATE')) is not false then
    raise exception 'db/038 ABORTED, rolled back: anon cannot insert/update portfolio.macro_path_at_buy (the add form and position saves write it)';
  end if;
  -- ...and nothing more on the new table
  if (has_table_privilege('anon', 'public.macro_observations', 'UPDATE') or has_table_privilege('anon', 'public.macro_observations', 'DELETE')) is not false then
    raise exception 'db/038 ABORTED, rolled back: anon can UPDATE or DELETE macro_observations';
  end if;
end $$;

commit;
