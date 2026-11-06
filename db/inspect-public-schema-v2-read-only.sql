-- READ ONLY, one SELECT, safe to run at any time. It changes nothing. For Roman: run it in the Supabase SQL editor and
-- save the one cell it returns as a file (the RUN-ME file that carries it says where).
--
-- Version 2 of db/inspect-public-schema-read-only.sql (2026-11-06). The tables part is unchanged. Added:
--   functions     every function in public: name, argument types, return type, kind, volatility, SECURITY DEFINER,
--                 owner, its ACL exactly as stored (proacl; NULL means the built-in default, which lets PUBLIC execute),
--                 and whether an extension owns it. Without this no rpc/ call can be shown live, and the default-ACL
--                 work has nothing measured to stand on.
--   default_acls  the default privileges set on schema public (pg_default_acl): what a NEW table or function gets.
-- scripts/capture-live-columns.mjs reads the saved cell and records this file's sha256 beside it, so a capture always
-- says which query produced it.
with t as (
  select c.oid, c.relname::text as name, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
)
select jsonb_pretty(jsonb_build_object(
  'query', 'inspect-public-schema-v2',
  'tables', (select jsonb_agg(jsonb_build_object(
    'table', t.name,
    'rls', t.rls,
    'columns', (select jsonb_agg(jsonb_build_object(
                    'name', a.attname::text,
                    'type', format_type(a.atttypid, a.atttypmod),
                    'not_null', a.attnotnull,
                    'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attnum)
                  from pg_attribute a
                  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                 where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped),
    'constraints', (select jsonb_agg(jsonb_build_object('name', con.conname::text, 'def', pg_get_constraintdef(con.oid)))
                      from pg_constraint con where con.conrelid = t.oid),
    'indexes', (select jsonb_agg(i.indexdef) from pg_indexes i where i.schemaname = 'public' and i.tablename = t.name),
    'triggers', (select jsonb_agg(pg_get_triggerdef(tg.oid)) from pg_trigger tg where tg.tgrelid = t.oid and not tg.tgisinternal),
    'policies', (select jsonb_agg(jsonb_build_object('name', p.policyname::text, 'cmd', p.cmd, 'roles', p.roles::text[], 'using', p.qual, 'check', p.with_check))
                   from pg_policies p where p.schemaname = 'public' and p.tablename = t.name)
  ) order by t.name) from t),
  'functions', (select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.proname::text,
      'args', pg_get_function_identity_arguments(p.oid),
      'returns', pg_get_function_result(p.oid),
      'kind', p.prokind,
      'volatility', p.provolatile,
      'security_definer', p.prosecdef,
      'owner', pg_get_userbyid(p.proowner)::text,
      'acl', p.proacl::text[],
      'extension', exists (select 1 from pg_depend dep
                            where dep.classid = 'pg_proc'::regclass and dep.objid = p.oid and dep.deptype = 'e')
    ) order by p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'),
  'default_acls', (select coalesce(jsonb_agg(jsonb_build_object(
      'role', pg_get_userbyid(d.defaclrole)::text,
      'object_type', d.defaclobjtype,
      'acl', d.defaclacl::text[]
    ) order by pg_get_userbyid(d.defaclrole), d.defaclobjtype), '[]'::jsonb)
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = 'public')
)) as schema_dump;
