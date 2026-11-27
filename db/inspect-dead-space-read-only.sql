-- READ ONLY, one SELECT, safe to run at any time. For Roman: run it in the Supabase SQL editor and send back the one
-- cell it returns. (2026-11-26, the reviewer's CC-the-date-was-mine-and-three-rulings §4: "trades_v2 grew 2.1 MB that
-- 101 rows do not explain. Find the cause.")
--
-- What it separates, per public table: the bytes of the LIVE rows (sum of pg_column_size over every row, the stored
-- size, compressed values as stored) against the bytes ON DISK for the table and its TOAST (indexes apart). The
-- difference is space holding no live row: dead row versions not yet vacuumed, or space vacuum freed for reuse (plain
-- VACUUM does not shrink the file). Postgres's own counters beside it say which: dead rows now, rows updated, and
-- when (auto)vacuum last ran, for the table and for its TOAST table.
--
-- Why trades_v2: between the two size reads (2026-11-14 19:05Z, 2026-11-26 18:22Z) every one of its 819 existing rows
-- was rewritten (the git backups f145eb4 and b786b78: db/044 and db/045's peak_rsi columns on all 819, plus ~225
-- sell-timing fills), and each UPDATE leaves the old row version behind until vacuum.
select jsonb_pretty(jsonb_build_object(
  'read_at', now(),
  'stats_reset', (select stats_reset from pg_stat_database where datname = current_database()),
  'public_tables', (
    select jsonb_agg(jsonb_build_object(
             'table', c.relname,
             'rows', s.n_live_tup,
             'dead_rows', s.n_dead_tup,
             'inserted', s.n_tup_ins,
             'updated', s.n_tup_upd,
             'hot_updated', s.n_tup_hot_upd,
             'deleted', s.n_tup_del,
             'last_vacuum', s.last_vacuum,
             'last_autovacuum', s.last_autovacuum,
             'autovacuum_count', s.autovacuum_count,
             'toast_dead_rows', ts.n_dead_tup,
             'toast_last_autovacuum', ts.last_autovacuum,
             'total_bytes', pg_total_relation_size(c.oid),
             'heap_bytes', pg_relation_size(c.oid),
             'toast_bytes', case when c.reltoastrelid = 0 then 0 else pg_total_relation_size(c.reltoastrelid) end,
             'index_bytes', pg_indexes_size(c.oid),
             'live_data_bytes', (xpath('/row/n/text()',
                        query_to_xml(format('select coalesce(sum(pg_column_size(t.*)), 0) as n from %I.%I t', n.nspname, c.relname), false, true, '')))[1]::text::bigint
           ) order by pg_total_relation_size(c.oid) desc)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_all_tables s on s.relid = c.oid
      left join pg_stat_all_tables ts on ts.relid = c.reltoastrelid
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  )
));
