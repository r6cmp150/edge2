-- READ ONLY, one SELECT, safe to run at any time. For Roman: run it in the Supabase SQL editor and send back the
-- one cell it returns. (2026-11-14, cleared by the reviewer; sent together with db/044's run, never alone.)
--
-- Why: (c) multiplied rating_snapshots' write rate (every scored row, BELOW_THRESHOLD included, for the sign-test),
-- and this project uses the free tier. Supabase's own documentation (platform/database-size, read 2026-11-14 03:2xZ):
-- the Free plan's DATABASE SIZE QUOTA is 500 MB, evaluated PER ORGANISATION on the average daily size over the
-- billing period (over it: a Fair Use restriction, requests answering HTTP 402). Read-only mode is separate, at 95%
-- of the fixed 2 GB disk. The anon key cannot read sizes (no RPC returns them; the REST root needs the secret key).
--
-- ALSO NEEDED, AND NOT AVAILABLE FROM SQL: the ORGANISATION's total. The quota is per organisation, and one project
-- cannot see another's databases. Read it from the dashboard: Organization -> Usage -> Database Size, and send that
-- figure with this cell.
--
-- Returns: the docs' own total (every database in this project's cluster), this database's size, and per public
-- table its total size (table + indexes + TOAST), table size, index size, and exact row count.
select jsonb_pretty(jsonb_build_object(
  'read_at', now(),
  'cluster_total', (select pg_size_pretty(sum(pg_database_size(d.datname))) from pg_database d),
  'cluster_total_bytes', (select sum(pg_database_size(d.datname))::bigint from pg_database d),
  'this_database_bytes', pg_database_size(current_database()),
  'public_tables', (
    select jsonb_agg(jsonb_build_object(
             'table', c.relname,
             'total_bytes', pg_total_relation_size(c.oid),
             'table_bytes', pg_relation_size(c.oid),
             'index_bytes', pg_indexes_size(c.oid),
             'rows', (xpath('/row/n/text()',
                        query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
           ) order by pg_total_relation_size(c.oid) desc)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  )
));
