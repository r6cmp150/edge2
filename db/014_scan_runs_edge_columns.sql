-- Three fixes to scan_runs, all found while building the EDGE logger,
-- all before a single EDGE row exists -- the cheapest this will ever be.

-- 1. prefiltered_count: evaluated_count < universe_count meant something
-- FAILED for Warrior (a partial scan, Alpaca 429s partway through) and
-- means the price/volume pre-filter did its job correctly for EDGE (191
-- of 239 tickers never reach scoreStock, by design). Same two columns,
-- opposite meanings, and no third column to tell them apart -- the
-- report's completeness rule ("exclude incomplete runs") would either
-- false-alarm on every EDGE row, or get loosened until it stops catching
-- real Warrior failures. That second outcome is the dangerous one: a
-- safety check quietly relaxed until nothing trips it.
--
-- prefiltered_count makes the arithmetic explicit and checkable:
--   universe_count - prefiltered_count = evaluated_count
-- always, for both engines. Warrior has no pre-filter stage between
-- universe and gate evaluation -- every universe candidate gets a gate
-- result -- so prefiltered_count is 0 for every Warrior row, including
-- every row already written before this column existed (default 0 is
-- correct for that backfill, not just convenient: it's the true value).
-- fetch_failed_count remains the one genuine failure signal for both
-- engines. "Was this scan complete" is now one question with one answer,
-- not a rule with an engine-specific exception nobody remembers to check.
alter table scan_runs add column if not exists prefiltered_count integer not null default 0;

-- 2. universe_source's CHECK constraint only allowed Warrior's two live-
-- screener provenance values. EDGE always reads a static ticker list, a
-- third, real provenance kind -- widened here rather than worked around
-- with a value that doesn't actually describe what happened.
alter table scan_runs drop constraint if exists scan_runs_universe_source_check;
alter table scan_runs add constraint scan_runs_universe_source_check
  check (universe_source in ('committed-movers-snapshot', 'self-fetched-fallback', 'static-universe-list'));

-- 3. universe_detail: 'static-universe-list' alone loses WHICH static
-- list -- currently STOCK_UNIVERSES.OTHER, 239 of ~5,714 eligible
-- tickers, a known open item that may change mid-test (e.g. widened to
-- the full eligible set). Deliberately a free-text column, not another
-- CHECK-constrained enum -- universe_source is the coarse, cross-engine-
-- comparable PROVENANCE KIND (does this row's universe come from a
-- committed snapshot, a live self-fetch, or a static list); universe_detail
-- is the specific, engine-local IDENTITY of that universe, free to change
-- without a migration every time it does. If the identity changes
-- mid-test, rows before and after are marked as not directly comparable
-- by this column rather than silently pooled.
alter table scan_runs add column if not exists universe_detail text;
