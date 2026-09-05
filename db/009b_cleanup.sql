-- Cleanup for db/009's throwaway outcome_filler_test role. Real,
-- uncommented SQL, its own file -- not a comment block at the bottom of
-- 009, for the same reason 004's commented-out lock statements were a
-- real defect: a step that looks done because the editor said "Success"
-- is not the same as a step that ran. Run this after the verification
-- test (scripts/sign-supabase-role-jwt.mjs + Roman's own run of
-- test_outcome_filler_role.mjs) regardless of whether the mechanism
-- turned out to work -- a throwaway role has no reason to outlive the
-- question it was created to answer.
--
-- ORDER MATTERS: the grants on signal_log are dependencies of the role
-- itself. `drop role` before revoking them fails with "role
-- outcome_filler_test cannot be dropped because some objects depend on
-- it" (Postgres lists the signal_log privileges) -- dropping the two
-- policies is necessary but not sufficient, since the GRANTs (schema
-- usage, table select/update) are separate dependencies the policies
-- don't cover. Revoke everything the role holds, in this order, before
-- dropping the role itself.
drop policy if exists "outcome filler select" on signal_log;
drop policy if exists "outcome filler update" on signal_log;
revoke all on signal_log from outcome_filler_test;
revoke usage on schema public from outcome_filler_test;
revoke outcome_filler_test from authenticator;
drop role outcome_filler_test;

-- VERIFICATION: proof cleanup happened is the absence of the role, not
-- the absence of an error from the statements above. Zero rows means
-- clean.
select rolname from pg_roles where rolname = 'outcome_filler_test';
