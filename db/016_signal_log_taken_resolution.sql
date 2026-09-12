-- signal_log.taken_resolution / matched_trade_id -- "was this signal acted
-- on," upgraded from db/001's original plan of deriving it purely via a
-- JOIN from trades_v2.signal_log_id. That plan assumed the app would set
-- signal_log_id at buy time; it never has (grepped app.js -- zero writes
-- to signal_log_id anywhere), so a pure join would show every trade ever
-- made as unlinked, forever, regardless of whether it really followed a
-- shown signal. This column is filled by the outcome job via a fallback
-- match instead (ticker + engine_source + buy_date within the signal's own
-- resolution window), with the direct-link case (taken-exact) kept as a
-- real, live option for whenever/if the app is ever wired to set
-- signal_log_id itself -- this schema doesn't foreclose that, it just
-- doesn't assume it already happened.
--
-- FIVE STATES, not a boolean, because collapsing them loses a real
-- distinction:
--   unresolved            -- window still open, no match yet
--   taken-exact            -- a trades_v2 row directly links via
--                             signal_log_id (not currently possible given
--                             the app never sets it, but the fill job
--                             checks for it first regardless, so this
--                             activates automatically if that ever changes)
--   taken-by-fallback      -- no direct link, but a heuristic match found
--                             (see fill job: ticker + engine_source +
--                             buy_date in-window, source != 'Own Decision')
--   traded-against-engine  -- a matching trade exists, but every signal_log
--                             row for that (signal_date, symbol,
--                             engine_source) was a NON-actionable tier
--                             (WARRIOR: BLOCKED/REJECTED/NOT_EVALUATED;
--                             EDGE: BELOW_THRESHOLD/NOT_EVALUATED) -- Roman
--                             traded something the engine declined to
--                             endorse. Collapsing this into either
--                             taken-by-fallback (implies the engine's call
--                             led to the trade) or not-taken-confirmed
--                             (implies no trade happened) would erase a
--                             real, distinct behavioral fact.
--   not-taken-confirmed    -- resolution window fully elapsed with no
--                             matching trade found (or, within a group
--                             that had a match, every row except the one
--                             actionable row that claimed it)
--
-- Tie-break within one (signal_date, symbol, engine_source) group (dedup
-- by tier means a symbol can have multiple rows the same day): when a
-- match exists AND at least one row in the group has an actionable tier,
-- only the single most-actionable row (WARRIOR: QUALIFIED over NEAR_MISS;
-- EDGE: SHOWN) claims taken-exact/taken-by-fallback; every other row in
-- that group resolves not-taken-confirmed immediately (not after waiting
-- out the window -- the group's disposition is already known once one row
-- claims the match). A genuine ambiguity if it ever matters more than this
-- says: not solved here, resolved to the single best-tier row per the
-- design conversation this migration comes from.
--
-- default 'unresolved', not null: every existing row (all currently
-- pending, since this column doesn't exist yet) starts in the same state
-- new rows start in, so the fill job's idempotency guard
-- (WHERE taken_resolution = 'unresolved') is correct from row 1, not just
-- for rows inserted after this migration.
alter table signal_log add column if not exists taken_resolution text not null default 'unresolved'
  check (taken_resolution in ('unresolved', 'taken-exact', 'taken-by-fallback', 'traded-against-engine', 'not-taken-confirmed'));

alter table signal_log add column if not exists matched_trade_id uuid references trades_v2(id);

create index if not exists signal_log_unresolved_taken_idx on signal_log (signal_date)
  where taken_resolution = 'unresolved';

create index if not exists signal_log_matched_trade_idx on signal_log (matched_trade_id);

-- Precision notes, stated in the schema itself (queryable via \d+
-- signal_log forever) rather than left to a migration file's prose that
-- nobody re-reads once it's landed. Same discipline as db/013's
-- triggered_at note.
comment on column signal_log.reference_price is
  'Price captured at first_shown_at (this row''s own first sighting), not at the setup''s trigger time and not re-read on a later scan of the same symbol/tier -- dedup keeps the earliest sighting, so a symbol seen at 13:50 and again at 15:15 under the same tier keeps the 13:50 reference_price.';

comment on column signal_log.ret_5m is
  'Return 5 minutes after first_shown_at, measured against reference_price -- NOT 5 minutes after the setup''s trigger time, and not tied to whichever scan happened to be running when the window elapsed. Null if no bar/price exists at that moment (fetch failure, halt, delisting), never a defaulted 0.';
comment on column signal_log.ret_15m is 'Same basis as ret_5m (first_shown_at / reference_price), at 15 minutes.';
comment on column signal_log.ret_30m is 'Same basis as ret_5m (first_shown_at / reference_price), at 30 minutes.';
comment on column signal_log.ret_close is 'Same basis as ret_5m (first_shown_at / reference_price), at that trading session''s close.';
comment on column signal_log.ret_1d is 'Same basis as ret_5m (first_shown_at / reference_price), at the close 1 trading day later.';
comment on column signal_log.ret_3d is 'Same basis as ret_5m (first_shown_at / reference_price), at the close 3 trading days later.';
comment on column signal_log.ret_5d is 'Same basis as ret_5m (first_shown_at / reference_price), at the close 5 trading days later.';
