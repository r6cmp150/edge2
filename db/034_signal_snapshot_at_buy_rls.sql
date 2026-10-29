-- db/034 (2026-10-28): let the app actually write signal_snapshot_at_buy.
-- DRAFT, for Roman to apply.
--
-- WHY: every insert into signal_snapshot_at_buy since it shipped (10-27) was
-- refused: "new row violates row-level security policy" (42501). Supabase
-- enables row-level security on tables created in its SQL editor, and db/033
-- created the table without a policy, so RLS denied every row regardless of
-- the GRANTs. db/033's verification checked has_table_privilege, which RLS
-- does not consult, so it passed while every write failed. About 63
-- positions bought on 10-27/10-28 have no snapshot, and most are already
-- sold, so it cannot be recaptured. The app logged each failure to the
-- console only, by design, so nobody saw it.
--
-- WHAT: keep RLS on, and give anon exactly what the GRANTs already intend:
-- INSERT (any row; the CHECK still enforces the three states) and SELECT. No
-- UPDATE or DELETE policy, matching the grants: write-once by privilege AND
-- by policy.
--
-- VERIFICATION LESSON: a privilege check isn't a write test. The
-- verification below performs a real insert AS anon inside a transaction
-- that is rolled back, so it proves the write path the app uses and leaves
-- nothing behind.

begin;

alter table signal_snapshot_at_buy enable row level security;

drop policy if exists signal_snapshot_at_buy_anon_insert on signal_snapshot_at_buy;
create policy signal_snapshot_at_buy_anon_insert on signal_snapshot_at_buy
  for insert to anon with check (true);

drop policy if exists signal_snapshot_at_buy_anon_select on signal_snapshot_at_buy;
create policy signal_snapshot_at_buy_anon_select on signal_snapshot_at_buy
  for select to anon using (true);

commit;

-- Verification, part 1: ONE query, ONE row. Expected:
--   rls_on true | insert_policies 1 | select_policies 1 | update_or_delete_policies 0 | rows 0
select
  (select relrowsecurity from pg_class where oid = 'public.signal_snapshot_at_buy'::regclass) as rls_on,
  (select count(*) from pg_policies where tablename = 'signal_snapshot_at_buy' and cmd = 'INSERT' and 'anon' = any(roles)) as insert_policies,
  (select count(*) from pg_policies where tablename = 'signal_snapshot_at_buy' and cmd = 'SELECT' and 'anon' = any(roles)) as select_policies,
  (select count(*) from pg_policies where tablename = 'signal_snapshot_at_buy' and cmd in ('UPDATE', 'DELETE', 'ALL')) as update_or_delete_policies,
  (select count(*) from signal_snapshot_at_buy) as rows;

-- Verification, part 2: a REAL insert as anon, rolled back. Run as one
-- block. Expected: "INSERT 0 1", then ROLLBACK; afterwards rows is still 0.
-- An error here (42501) means the app still can't write.
begin;
set local role anon;
insert into signal_snapshot_at_buy (position_id, engine_source, snapshot, absent_reason)
values ('db034-verify-rolled-back', 'EDGE', null, 'no_signal');
rollback;
