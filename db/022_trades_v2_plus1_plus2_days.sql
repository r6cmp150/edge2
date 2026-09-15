-- Phase 9 §3.4 review (2026-09-15, found while building the counterfactual
-- the newly-shipped -6% max-loss floor needs measured): trades_v2 already
-- carries price_at_plus5_days (db/002) but nothing at day+1 or day+2.
-- Roman, in review: "you cut at -6%, and two days later it was at X -- that
-- is the entire counterfactual."
--
-- CORRECTED (Roman, in review, same day): these columns measure whether
-- the floor was RIGHT on the 45 trades Roman actually took -- they do NOT
-- feed §3.2's Model A. Model A needs the base rate across the whole
-- eligible universe from historical daily bars, thousands of cases;
-- trades_v2 is a selected sample of what Roman chose to buy, not a
-- population, and reaching for it as training data would fit a model to
-- 45 self-selected observations that LOOKS like it works. §3.1's dataset
-- is built separately, entirely offline from Alpaca history, and does not
-- read trades_v2 at all. Do not point future work at this table for that.
--
-- No new Alpaca calls: scripts/lib/sell-timing.mjs's resolveSellTiming
-- already fetches the full window through sell_date+5-trading-days for
-- price_at_plus5_days; day+1/day+2 are two more reads of the SAME allBars
-- array it already holds (see that file's 2026-09-15 change).
--
-- Applies to every trade, not just floor-triggered ones -- cheap, and
-- unified_recommendation_at_sale already names which hard floor (if any)
-- fired, so "what happened to floor-cut trades specifically" is a WHERE
-- clause on existing data, not a separate mechanism.
--
-- SAME COLUMN-NARROWED-GRANT SHAPE as db/019/db/021, for the same reason:
-- outcome_filler's existing trades_v2 UPDATE grant (db/019) is already
-- column-scoped to the five sell-timing columns, not table-wide, so there
-- is nothing broad to revoke -- this ADDS two columns to that same
-- existing privilege set (column-level GRANT is additive in Postgres).
alter table trades_v2 add column if not exists price_at_plus1_day numeric;
alter table trades_v2 add column if not exists price_at_plus2_days numeric;

grant update (
  price_at_plus1_day, price_at_plus2_days
) on trades_v2 to outcome_filler;

-- No new RLS policy needed: db/019's "outcome filler update" policy on
-- trades_v2 is `using (true) with check (true)` -- row-level, already
-- covers every row regardless of which columns a given UPDATE touches.

-- VERIFICATION PLAN (same shape as db/019's/db/021's):
--   check A: PATCH trades_v2.price_at_plus1_day on a real row (filtered by
--     id) via the outcome_filler JWT -- expect success, re-select via the
--     anon key confirms the write landed. Naturally exercised by the next
--     real fill-outcomes.mjs --write dispatch (Pass 3 writes both new
--     columns for every trade it resolves) -- no standalone write needed,
--     same reasoning as db/019 check A's own note in
--     scripts/test-db019-db021-grants.mjs.
--   check B: already covered -- db/019 check B already proved buy_price
--     stays outside this role's grant; these two new columns don't change
--     that boundary, only widen the columns already inside it.
--   Then: re-run node scripts/fill-outcomes.mjs --write once (after this
--   migration is applied) and re-select a few trades_v2 rows to confirm
--   price_at_plus1_day/price_at_plus2_days are populated.
