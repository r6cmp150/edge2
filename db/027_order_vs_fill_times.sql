-- db/027 (2026-10-09): ORDER moment vs FILL moment.
--
-- WHY: Roman's orders don't always fill when he enters them -- limit
-- orders on both sides, and market orders placed while the market is
-- closed (fill at the next open). The app has only ever recorded the
-- moment he enters a buy (buy_date/buy_time). Hold duration -- now the
-- most important metric in the system -- should run from the buy FILL.
--
-- SEMANTICS, FIXED HERE SO NOBODY RE-DERIVES THEM:
--   buy_date / buy_time    = BUY ORDER PLACEMENT (the decision). Unchanged
--     columns, unchanged meaning. Signal attribution
--     (scripts/lib/taken-precedence.mjs) uses these and must never use a
--     fill time.
--   filled_at              = BUY FILL instant (timestamptz -- not a date +
--     text pair; buy_time's implicit-PT text is why that comparison needed
--     a converter).
--   order_type             = 'market' | 'limit' | 'stop' | 'stop_limit' |
--     'trailing_stop'; NULL = legacy row, type never recorded (every row
--     before this file).
--   sell_date / sell_time  = the SELL FILL, by construction: a sale can
--     only be recorded once it has filled, because its price isn't known
--     before that (and trades_v2 is insert-only for anon, db/002, so it
--     can't be recorded early and completed later). No sell placement
--     column: nothing would read it -- hold duration uses the fill, and
--     attribution is entry-side only.
--   sell_order_type        = same five values; NULL = legacy. Recorded
--     for one question nothing else can answer: do limit exits beat market
--     exits?
--
-- WHEN filled_at IS SET (app contract, one comparison on
-- core/clock.js classifySession at the moment the buy is entered):
--   market + REGULAR                              -> filled_at = now
--   market + PRE_MARKET / AFTER_HOURS             -> NULL, pending
--   market + CLOSED (overnight, weekend, holiday) -> NULL, pending
--   limit / stop / stop_limit / trailing_stop     -> NULL until marked filled
--     (none of them fills on placement; each waits on a price condition)
--
-- REVISED 2026-10-09 (comment only; the columns are unchanged). This file
-- first said "market + PRE_MARKET / AFTER_HOURS -> filled now", reasoning
-- that Roman's extended-hours fills are real (10 of his first 37 buys were
-- after the close). That establishes extended-hours FILLS exist, not that a
-- plain MARKET order fills on placement there -- many brokers queue it for
-- the open or require a limit. The error is asymmetric: a wrongly-pending
-- order costs one tap on Mark filled; a wrongly-filled one writes a
-- fabricated timestamp into filled_at, the column every hold-time figure
-- runs from, permanently and indistinguishably from a real one. So only
-- REGULAR auto-fills until Roman confirms what his broker does with a market
-- order pre-market and after-hours -- ASK, don't infer (the overnight rule
-- below was learned the same way).
--
-- "CLOSED -> PENDING" FOR MARKET ORDERS IS CORRECT EVEN THOUGH ROMAN'S
-- BROKER TRADES OVERNIGHT. Confirmed with Roman on 2026-10-09, not
-- inferred: the broker's 24-hour market accepts LIMIT ORDERS ONLY
-- overnight; a plain market order placed then waits for the next session.
-- (classifySession's CLOSED covers 5:00pm-1:00am PT plus weekends and
-- holidays -- the overnight window included.) The Sunday-night fills on
-- 2026-09-27 were limit orders, which this rule already treats as pending
-- until marked. Do not "fix" this to fill market orders at 9pm; if the
-- broker's overnight rules ever change, re-confirm with Roman first.
-- So for every new row, filled_at NULL means one thing: NOT FILLED (yet,
-- or never confirmed) -- whatever the order type. The invariant is about
-- the fill, not the intent. A position can't be sold until it's marked
-- filled; if Roman doesn't know the fill time at sale, it stays NULL and
-- the trade says so.
--
-- HOLD-DURATION BASIS, derived per trade at read time (never stored):
--   filled_at set                   -> "from fill"
--   filled_at NULL, order_type set  -> "from order date -- fill not recorded"
--   order_type NULL                 -> "from order date -- legacy row"
-- Anything aggregating durations states how many trades used each basis
-- instead of averaging two different measures. (The 24 Sunday-placed rows
-- are legacy; their close count is the same for a Sunday-night or Monday
-- fill, because Sunday has no close -- see core/clock.js marketClosesHeld.)
--
-- PORTFOLIO gets order_type + filled_at. A row with filled_at NULL and
-- order_type set is a PENDING ORDER, not a position: excluded from
-- portfolio P&L, hold-time alerts and the sell flow until marked filled.
-- Pre-027 positions (order_type NULL) are treated as filled, as today.
--
-- NO DATA CHANGES HERE. The 24 Sunday-placed rows stay NULL/NULL until
-- Roman supplies real broker fills; those go in as a separate, observed-
-- data correction -- never an inferred Monday.
--
-- No database constraint ties filled_at to the sell: sell_date/sell_time
-- are a date + PT-text pair, and a cross-type, timezone-converting CHECK is
-- more fragile than the app validating "fill before sale" on the form.
--
-- WHY THE ORDER-TYPE CHECKS STAY (unlike workflow_runs.trigger_type, whose
-- CHECK was removed): there the writer was an audit log recording an
-- external event it didn't control, and a rejection failed the very job
-- being observed. Here the writer is our own UI with a fixed set of
-- choices, so a rejected value means a UI bug, and failing loudly is
-- correct. The set is widened up front (stop / stop_limit / trailing_stop,
-- 2026-10-09) because Roman uses a stop on every position: recording a
-- broker-side stop order must not fail, and widening later would cost a
-- migration. A broker stop ORDER is distinct from the app's own
-- position.stop level.
--
-- Additive only. Safe to run twice. Run in the Supabase SQL editor.

begin;

-- ── trades_v2 ──
alter table trades_v2 add column if not exists order_type      text;
alter table trades_v2 add column if not exists filled_at       timestamptz;
alter table trades_v2 add column if not exists sell_order_type text;

alter table trades_v2 drop constraint if exists trades_v2_order_type_chk;
alter table trades_v2 add  constraint trades_v2_order_type_chk
  check (order_type in ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop'));
alter table trades_v2 drop constraint if exists trades_v2_sell_order_type_chk;
alter table trades_v2 add  constraint trades_v2_sell_order_type_chk
  check (sell_order_type in ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop'));

comment on column trades_v2.buy_date        is 'BUY ORDER PLACEMENT date (PT) -- the decision moment. Signal attribution uses this, never filled_at. (db/027)';
comment on column trades_v2.buy_time        is 'BUY ORDER PLACEMENT time, PT wall clock HH:MM. See buy_date. (db/027)';
comment on column trades_v2.filled_at       is 'BUY FILL instant. NULL = not filled/confirmed (new rows) or legacy (order_type NULL). Hold duration runs from this when set. (db/027)';
comment on column trades_v2.order_type      is '''market'' | ''limit'' | ''stop'' | ''stop_limit'' | ''trailing_stop''; NULL = legacy row, type never recorded. (db/027)';
comment on column trades_v2.sell_date       is 'SELL FILL date (PT), by construction -- a sale is recorded only once filled. (db/027)';
comment on column trades_v2.sell_time       is 'SELL FILL time, PT wall clock HH:MM. (db/027)';
comment on column trades_v2.sell_order_type is '''market'' | ''limit'' | ''stop'' | ''stop_limit'' | ''trailing_stop''; NULL = legacy row. For "do limit exits beat market exits". (db/027)';

-- ── portfolio (open positions; no RLS by design -- db/NOTE_portfolio_rls_not_applied.sql) ──
alter table portfolio add column if not exists order_type text;
alter table portfolio add column if not exists filled_at  timestamptz;

alter table portfolio drop constraint if exists portfolio_order_type_chk;
alter table portfolio add  constraint portfolio_order_type_chk
  check (order_type in ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop'));

comment on column portfolio.order_type is '''market'' | ''limit'' | ''stop'' | ''stop_limit'' | ''trailing_stop''; NULL = entered before db/027 (treated as filled). (db/027)';
comment on column portfolio.filled_at  is 'BUY FILL instant. NULL with order_type set = PENDING ORDER, not a position. (db/027)';

commit;

-- Verification (run after). Expect 3 trades_v2 rows + 2 portfolio rows,
-- all nullable, and zero rows with any new column populated:
-- select table_name, column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and ((table_name = 'trades_v2' and column_name in ('order_type','filled_at','sell_order_type'))
--      or (table_name = 'portfolio' and column_name in ('order_type','filled_at')))
--  order by table_name, column_name;
-- select (select count(*) from trades_v2 where order_type is not null or filled_at is not null or sell_order_type is not null)
--      + (select count(*) from portfolio where order_type is not null or filled_at is not null) as should_be_zero;
