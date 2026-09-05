-- ONE-TIME TEST, not the production credential. Answers a single
-- question before the outcome-filling job gets built around an
-- assumption: does Supabase's PostgREST honor a manually-signed JWT
-- carrying a custom `role` claim (no Auth Hooks, no real user account --
-- just a role that exists in Postgres and is granted to `authenticator`,
-- the role PostgREST itself connects as)?
--
-- RESULT (2026-09-05): CONFIRMED. The mechanism works -- three
-- independent signals, not one: check A updated ret_5m and the anon
-- re-select showed the write actually landed (no role, anon included,
-- has ever had UPDATE on signal_log, so that can only mean the role
-- switch happened); check B's column-level grant genuinely narrowed the
-- role to ret_5m (ret_15m rejected, confirmed unchanged on re-select);
-- and later, an attempted re-run of check C against the already-dropped
-- role returned 401/22023 "role does not exist" -- meaning PostgREST
-- had validated the JWT's signature and attempted the SET ROLE before
-- discovering the role was gone, a third independent confirmation the
-- claim-reading mechanism itself is real.
--
-- WHAT REMAINS UNVERIFIED, stated so it isn't quietly assumed later:
-- cross-table UPDATE denial. Check D confirmed this role has no SELECT
-- grant on trades_v2 (403/42501). It did NOT confirm UPDATE is denied
-- there too -- UPDATE is a separate grant, and check C (which would have
-- tested it) never produced a valid result: its first run tripped
-- PostgREST's own unfiltered-mutation guard (400/21000, never reached
-- Postgres's permission layer) and its planned re-run found the
-- throwaway role already dropped (009b had already run). Recreating the
-- role solely to chase this one check was rejected as the wrong move --
-- the real outcome_filler role's own verification, required anyway
-- before the outcome job goes live, must include a filtered
-- cross-table UPDATE attempt (see db/009's role, matching check C's
-- corrected shape in scripts/test-outcome-filler-role.mjs) so this gap
-- gets closed by the real credential's test, not inferred from a
-- SELECT-only result on a role that no longer exists. Don't assume
-- UPDATE is denied just because SELECT was -- that's an inference this
-- project's own discipline says not to cash without having earned it.
--
-- CORRECTED 2026-09-05 before this ever ran (caught in review, not after
-- a false result): the first draft granted the role a table privilege
-- (SELECT/UPDATE) but never schema USAGE and never an RLS policy. Three
-- things had to all be true for the ret_5m update to succeed --
-- schema-level reachability, a policy giving the role ROW access, and a
-- column-level grant narrowing WHICH columns -- and the draft supplied
-- only the third. Every one of the five checks below was going to
-- "pass" for the wrong reason: the update would have failed with
-- permission-denied-for-schema before RLS or the column grant were even
-- consulted, and the three rejection checks (which are SUPPOSED to
-- fail) would have looked identical whether the role was correctly
-- scoped or completely broken. A test that can't tell "scoped correctly"
-- apart from "doesn't work at all" doesn't test what it's named for.
--
-- NOT RE-RUNNABLE: `create role` has no IF NOT EXISTS in Postgres. A
-- second run of this file errors on Step 1 ("role already exists") --
-- that's an ordinary re-run collision, not a sign anything is broken.
-- Run db/009b_cleanup.sql first if this needs to run again.
--
-- STEP 1: create the throwaway role and grant it to authenticator (the
-- switch PostgREST performs is `SET ROLE <jwt role claim>`, which
-- requires authenticator to already be a member of that role).
create role outcome_filler_test nologin;
grant outcome_filler_test to authenticator;

-- STEP 2: schema reachability, table-level column grant, AND the RLS
-- policies that give the role row access in the first place -- same
-- three-layer shape as 005's anon/trades split (a policy grants ROW
-- reach; the column-level grant is what narrows it to ret_5m alone).
-- Deliberately nothing else granted: the test must show every OTHER
-- column and every OTHER table rejected, not just that ret_5m succeeds.
grant usage on schema public to outcome_filler_test;
grant select, update (ret_5m) on signal_log to outcome_filler_test;

drop policy if exists "outcome filler select" on signal_log;
create policy "outcome filler select" on signal_log
  for select to outcome_filler_test using (true);

drop policy if exists "outcome filler update" on signal_log;
create policy "outcome filler update" on signal_log
  for update to outcome_filler_test using (true) with check (true);

-- WHY A SUCCESSFUL ret_5m UPDATE IS ACTUALLY INFORMATIVE, once the above
-- is all in place: signal_log's only other policies are "anon insert"
-- and "anon select" (001) -- no role, anon included, has ever been able
-- to UPDATE this table. So a ret_5m update succeeding under this JWT
-- can only mean the role switch genuinely happened (PostgREST read the
-- custom `role` claim and ran the query as outcome_filler_test, not as
-- anon or anything else) -- there is no OTHER path by which that update
-- could have succeeded. Success here is proof of the mechanism, not
-- just an isolated green check.
--
-- CLEANUP IS ITS OWN FILE: db/009b_cleanup.sql, real uncommented SQL, run
-- after the test in scripts/sign-supabase-role-jwt.mjs + Roman's own
-- verification run has confirmed or refuted the mechanism -- regardless
-- of which way it goes. Not repeated here as a comment: this project
-- already closed that exact hole in 004 (commented-out SQL that reports
-- "Success. No rows returned" and looks like it ran when it didn't) --
-- doing the same thing to the cleanup step, the one step nobody
-- re-verifies, would be the same mistake in a narrower spot.
