-- READ ONLY, one SELECT, safe to run at any time. For Roman: run it in the Supabase
-- SQL editor and send back the one cell it returns.
--
-- Five tables have no CREATE TABLE in db/: db_meta, portfolio, rating_snapshots,
-- settings, trades. Their constraints have never been read, only inferred from
-- behaviour, and the anon key can't read the schema (the REST root answers 401,
-- "Secret API key required"). This returns every public table's real definition:
-- columns, constraints, indexes, triggers, policies and RLS, including any table
-- the code doesn't name. Auth step 4 writes policies against these tables.
with t as (
  select c.oid, c.relname::text as name, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
)
select jsonb_pretty(jsonb_agg(jsonb_build_object(
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
) order by t.name)) as schema_dump
from t;
