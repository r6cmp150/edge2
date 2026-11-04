select 'function' as section,
       p.oid::regprocedure::text as object,
       'owner ' || pg_get_userbyid(p.proowner)
         || '; security ' || case when p.prosecdef then 'DEFINER' else 'INVOKER' end
         || '; execute granted to: ' || coalesce(array_to_string(p.proacl, ', '), 'PUBLIC (the default ACL)') as detail,
       pg_get_functiondef(p.oid) as body
  from pg_proc p
 where p.proname = 'rls_auto_enable'
union all
select 'event trigger',
       e.evtname::text,
       'fires on ' || e.evtevent::text || '; enabled ' || e.evtenabled::text || '; owner ' || pg_get_userbyid(e.evtowner)
         || '; tags ' || coalesce(array_to_string(e.evttags, ','), 'all'),
       'calls ' || e.evtfoid::regproc::text
  from pg_event_trigger e
union all
select 'trigger',
       t.tgrelid::regclass::text || '.' || t.tgname::text,
       'calls ' || t.tgfoid::regproc::text,
       null
  from pg_trigger t
 where t.tgfoid in (select oid from pg_proc where proname = 'rls_auto_enable')
union all
select 'anon columns',
       c.relname::text || ' ' || priv,
       (count(*) filter (where has_column_privilege('anon', c.oid, a.attnum, priv)))::text || ' of ' || count(*)::text || ' columns'
         || case when count(*) filter (where has_column_privilege('anon', c.oid, a.attnum, priv)) between 1 and count(*) - 1
                 then ': ' || string_agg(a.attname::text, ', ' order by a.attnum) filter (where has_column_privilege('anon', c.oid, a.attnum, priv))
                 else '' end,
       case when has_table_privilege('anon', c.oid, priv) then 'table-level grant' else 'no table-level grant' end
         || coalesce('; explicit column ACLs on: ' || string_agg(a.attname::text, ', ' order by a.attnum) filter (where a.attacl is not null), '')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 cross join unnest(array['SELECT', 'INSERT', 'UPDATE']) as priv
 where n.nspname = 'public' and c.relkind in ('r', 'p')
 group by c.relname, c.oid, priv
 order by 1, 2;
