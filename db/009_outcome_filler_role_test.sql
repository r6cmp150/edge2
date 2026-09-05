-- ONE-TIME TEST, not the production credential. Answers a single
-- question before the outcome-filling job gets built around an
-- assumption: does Supabase's PostgREST honor a manually-signed JWT
-- carrying a custom `role` claim (no Auth Hooks, no real user account --
-- just a role that exists in Postgres and is granted to `authenticator`,
-- the role PostgREST itself connects as)?
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
