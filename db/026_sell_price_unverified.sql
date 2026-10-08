-- sell_price_unverified: marks the 22 trades_v2 rows corrupted by the
-- sell-price fabrication bug (app.js's renderPortfolioTab, fixed 2026-10
-- -- see docs/phase-9-entry-exit-spec.md §6's seventh entry). Those rows
-- have sell_price exactly equal to buy_price -- not because the market
-- closed them flat, but because a missing single-symbol Alpaca snapshot
-- silently fell back to buyPrice, and that fabricated number both looked
-- like a real "Now" price on the Portfolio card and pre-filled Mark as
-- Sold's sale-price field. They are UNKNOWN outcomes wearing a $0.00
-- mask, not genuine breakeven trades -- the distinction this column
-- exists to make queryable.
--
-- NOT backfilled with a guessed real sell price -- explicit instruction.
-- Nothing after the fact can recover what the market actually did at the
-- moment each of these was confirmed; a guessed number would be a second,
-- quieter version of the exact fabrication this migration exists to flag.
--
-- Column, not a delete/null-out of sell_price: the row itself (ticker,
-- shares, buy_price, dates, signal data at purchase) is still real and
-- still useful for everything that isn't P&L/win-rate math -- e.g. "what
-- did the scoring system look like for this entry" is unaffected by
-- whether the EXIT price is trustworthy. Downstream metrics (Sold tab,
-- Analytics, generateClaudeReport) should filter these out of any
-- win/loss/P&L calculation, not treat the whole row as not-a-trade.
--
-- Default false, not null: every row written from this point forward
-- goes through the fixed code path (openMarkSoldModal no longer
-- pre-fills an unverifiable price at all -- confirmed empty field per
-- tests/portfolio-price-unavailable.test.js), so "false" is the correct,
-- not just convenient, default for every new row.
alter table trades_v2 add column if not exists sell_price_unverified boolean not null default false;

-- The 22 rows identified 2026-10 by sell_price = buy_price (confirmed
-- via re-select against the live table, not assumed from a prior dump --
-- see the accompanying report for the exact query and count). IDs listed
-- explicitly, not re-derived by a WHERE pnl_dollars = 0 clause in this
-- migration itself: a future genuine breakeven trade (a real market
-- close at exactly cost, which IS possible) must never be swept into
-- this flag automatically just because it also nets to $0 -- only these
-- specific, already-investigated rows are known-fabricated.
update trades_v2 set sell_price_unverified = true where id in (
  '0cfbd655-31bf-4316-af32-965c13967728',
  '8c9b1246-32c4-4d60-8f8a-4681e87d930d',
  '2639b55b-8ce3-4825-9f04-0b1e5ed68123',
  '62d9b1d1-a28b-4a7f-a354-d6c1def4ebcf',
  '90dd173f-2f62-4c4a-870c-701382c7458a',
  '804ed12b-3bf4-4218-9358-d2767c32e398',
  '77a5bda0-0752-45a7-8b02-1e8e5891052f',
  '573a1b0b-6c2e-4a68-8c8c-103461f0ce6e',
  'd87ce85b-92e2-4928-905b-7b0fce74913c',
  '310df5f2-f391-4dbe-8f8c-9e8c5cd2ca0f',
  '522042f5-b93a-40f5-8bae-92189f7973e4',
  '26582aeb-fbe0-45ed-b3df-8dc7ae7126e8',
  'e7c604c6-9226-4665-b53c-19f55f11f9cd',
  '5db6c1fb-f5d8-4a0c-962c-610b15c54157',
  '43387232-537b-4900-afce-3aecffe092fa',
  '7eb10d64-020b-42af-b61e-9cd89fd96f61',
  '896bc67f-4e27-45ae-9399-87f678d47b14',
  'be5bd820-5e9a-424a-aa28-c4a56f45b09a',
  '36d98bcc-548a-4f57-84f3-f8204c77ea53',
  'c8fbd8e7-9809-43c8-bcc3-22075bc834df',
  '29072a52-95a3-4930-a32f-b244536aeb2d',
  '19429e6b-5829-4ecd-a9f6-752d9ef54f40'
);

-- No RLS/grant change: sell_price_unverified is an ordinary column on a
-- table anon can already SELECT in full; it needs no new policy, only a
-- column to exist. anon still has no UPDATE on trades_v2 (unchanged,
-- fail-closed posture from db/005/db/004b) -- this UPDATE statement runs
-- once, by hand, in the SQL editor, same as every other data correction
-- in this project.

-- VERIFICATION PLAN: re-select count(*) from trades_v2 where
-- sell_price_unverified = true -- expect exactly 22. Re-select the 22 IDs
-- above individually and confirm each now reads true. Confirm a normal
-- row (any ID not listed) still reads false, not null (the column's own
-- not-null constraint should make this unrepresentable, but confirm
-- anyway -- same discipline as every other migration here).
