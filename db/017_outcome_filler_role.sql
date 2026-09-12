-- outcome_filler: the real, permanent credential for the deferred
-- outcome-filling job -- db/009 proved the JWT-custom-role mechanism works
-- (throwaway outcome_filler_test, dropped in 009b); this is the production
-- role built on that proof, scoped to what THIS PASS actually needs.
--
-- MUST RUN AFTER db/016: the grant below names taken_resolution and
-- matched_trade_id, which db/016 creates. Running this file first fails
-- on an unknown-column error in the grant statement, not silently.
--
-- SCOPE OF THIS PASS: signal_log outcome columns only. trades_v2 gets a
-- SELECT grant here -- needed to read ticker/buy_date/source/engine_source/
-- signal_log_id for the taken-resolution fallback match -- but NO update
-- grant and NO update policy. Writing trades_v2's five sell-timing columns
-- is deferred to the second pass (sell_timing_resolved, best_exit_price,
-- best_exit_date, best_exit_timing, price_at_plus5_days), which will widen
-- this SAME role (not create a second one) with an additional column grant
-- and update policy on trades_v2, then re-run verification for the new
-- grant specifically. Keeping the surface this narrow now is deliberate:
-- this is the first role in the project with real UPDATE power anywhere,
-- and the smallest grant that does this pass's job is the one to ship.
--
-- CREDENTIAL LIFETIME (found live 2026-09-10): the first outcome_filler
-- JWT was minted with sign-supabase-role-jwt.mjs's `days` argument
-- omitted, which at the time defaulted to 3650 (~10 years) -- a decade of
-- bearer-token UPDATE access over the forward test's own results, chosen
-- by nobody. Fixed two ways: sign-supabase-role-jwt.mjs no longer has a
-- default at all (a lifetime must be stated explicitly every time a token
-- is minted, for any role), and this token was re-minted at 365 days --
-- long enough that rotation isn't monthly toil, short enough that a leak
-- has a real backstop rather than a decade of exposure, and short enough
-- that renewal is a once-a-year conscious event rather than something
-- assumed permanent. An expired token fails LOUD, not silent -- the fill
-- script's main().catch() pattern (same as both loggers) turns a 401 into
-- an exit-1 job failure with a GitHub Actions notification, the same
-- mechanism that surfaced the EDGE hoursSincePreviousClose bug and the
-- request_count schema gap -- so a forgotten renewal announces itself
-- rather than degrading quietly.
--
-- outcome_filler's current token: minted 2026-09-10, expires 2027-09-11
-- (confirmed from the real mint's own printed expiry, not the test run
-- above -- a few hours' difference in when each was actually run crossed
-- a UTC day boundary; both are correctly "365 days from whenever that
-- command ran," not a discrepancy).
-- RENEW BY THAT DATE: re-run
--   SUPABASE_JWT_SECRET=... node scripts/sign-supabase-role-jwt.mjs outcome_filler 365
-- and update the OUTCOME_FILLER_JWT GitHub Actions secret. This date must
-- also be written into the fill job's own workflow YAML as a comment once
-- that workflow exists (it doesn't yet, as of this migration) -- a
-- calendar fact worth seeing in two places, not one. (Done: see
-- .github/workflows/fill-outcomes.yml's own header once that file lands.)
--
-- NOT RE-RUNNABLE: same as db/009 -- `create role` has no IF NOT EXISTS
-- in Postgres. A second run of this file errors on line 17 ("role already
-- exists"). That's an ordinary re-run collision, not a sign anything is
-- broken; it does not need a cleanup file the way db/009's throwaway role
-- did, since this role is meant to persist. If this file ever needs a
-- real re-run (not the pass-2 widening, which is a separate ALTER/GRANT
-- migration against the existing role, not a re-run of this one), drop
-- the role first and re-verify from scratch.
create role outcome_filler nologin;
grant outcome_filler to authenticator;

grant usage on schema public to outcome_filler;

-- signal_log: read (needed to evaluate which columns/rows are due) and a
-- column-narrowed update -- exactly the columns this job fills, nothing
-- else. reference_price, first_shown_at, signal_snapshot, tier, etc. are
-- deliberately absent from the update() column list: this role can read
-- them to decide what to compute, never rewrite them.
grant select, update (
  ret_5m, ret_15m, ret_30m, ret_close, ret_1d, ret_3d, ret_5d,
  outcomes_filled_at, taken_resolution, matched_trade_id
) on signal_log to outcome_filler;

drop policy if exists "outcome filler select" on signal_log;
create policy "outcome filler select" on signal_log
  for select to outcome_filler using (true);

drop policy if exists "outcome filler update" on signal_log;
create policy "outcome filler update" on signal_log
  for update to outcome_filler using (true) with check (true);

-- trades_v2: SELECT only, for fallback matching -- no update grant, no
-- update policy, in this pass.
grant select on trades_v2 to outcome_filler;

drop policy if exists "outcome filler select" on trades_v2;
create policy "outcome filler select" on trades_v2
  for select to outcome_filler using (true);

-- VERIFICATION PLAN (scripts/test-outcome-filler-role.mjs, extended for
-- the production role -- run before the fill script ever dispatches with
-- --write):
--   check A: PATCH signal_log.ret_5m on a real row, filtered by id --
--     expect success, re-select via anon key confirms the write landed.
--   check B: PATCH signal_log.reference_price (read-only for this role)
--     on the same row -- expect permission-denied, re-select confirms
--     unchanged.
--   CHECK E, the one db/009 never completed: PATCH trades_v2 on a REAL
--     existing row's id (not the malformed unfiltered request that
--     tripped PostgREST's own guard last time, and not a random id either
--     -- a real id means a permission-denied result can't be confused
--     with "no such row") -- expect permission-denied, since this role has
--     SELECT but no UPDATE grant here. Re-select via anon key confirms
--     the row is unchanged. This is a sharper version of what db/009's
--     check C was trying to prove: not just "zero access to another
--     table" but "real read access, zero write access" on the same one --
--     the actual boundary the trades_v2 SELECT grant above creates.
