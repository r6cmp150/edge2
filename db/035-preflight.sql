with t as (
  select c.oid, c.relname::text as name, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         coalesce(array_to_string(c.reloptions, ','), '') as opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
),
pol as (
  select tablename::text as name,
         string_agg(policyname || ' [' || cmd || ', ' || permissive || ', to ' || array_to_string(roles, ',')
                    || coalesce(', using ' || qual, '') || coalesce(', check ' || with_check, '') || ']',
                    '; ' order by policyname) as policies,
         bool_or(cmd in ('UPDATE', 'DELETE', 'ALL') and roles && array['anon', 'public']::name[]) as anon_write,
         bool_or(cmd in ('INSERT', 'ALL') and roles && array['anon', 'public']::name[]) as anon_insert,
         bool_or(cmd in ('SELECT', 'ALL') and roles && array['anon', 'public']::name[]) as anon_select,
         bool_or(cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and roles && array['authenticated']::name[]) as auth_write
    from pg_policies
   where schemaname = 'public'
   group by tablename
),
r as (
  select case when t.relkind in ('v', 'm') then 'view' else 'table' end as kind,
         t.name,
         case when t.relkind in ('v', 'm') then 'n/a (view: ' || coalesce(nullif(t.opts, ''), 'no options') || ')'
              else (case when t.relrowsecurity then 'RLS on' else 'RLS OFF' end)
                   || (case when t.relforcerowsecurity then ', forced' else '' end) end as rls,
         concat_ws(' ',
           case when has_table_privilege('anon', t.oid, 'SELECT') then 'SELECT' end,
           case when has_table_privilege('anon', t.oid, 'INSERT') then 'INSERT' end,
           case when has_table_privilege('anon', t.oid, 'UPDATE') then 'UPDATE' end,
           case when has_table_privilege('anon', t.oid, 'DELETE') then 'DELETE' end) as anon_grants,
         coalesce(pol.policies, '(none)') as policies,
         case
           when t.relkind in ('v', 'm') and has_table_privilege('anon', t.oid, 'SELECT')
             then 'VIEW READABLE BY ANON: bypasses the underlying tables'' RLS unless security_invoker=true'
           when t.relkind in ('v', 'm')
             then 'view; anon has no SELECT'
           when not t.relrowsecurity
                and (has_table_privilege('anon', t.oid, 'SELECT') or has_table_privilege('anon', t.oid, 'INSERT')
                     or has_table_privilege('anon', t.oid, 'UPDATE') or has_table_privilege('anon', t.oid, 'DELETE'))
             then 'OPEN: RLS OFF, anon can do everything its grants allow'
           when not t.relrowsecurity
             then 'RLS OFF (anon holds no grant on it today)'
           when coalesce(pol.anon_write, false)
             then 'OPEN: an UPDATE/DELETE policy reaches anon'
           when coalesce(pol.auth_write, false)
             then 'CHECK: a write policy reaches authenticated (open if Supabase sign-ups are open)'
           when coalesce(pol.anon_insert, false) and coalesce(pol.anon_select, false)
             then 'anon can INSERT and READ (rows its policy allows); no UPDATE/DELETE'
           when coalesce(pol.anon_insert, false)
             then 'anon can INSERT; no READ/UPDATE/DELETE'
           when coalesce(pol.anon_select, false)
             then 'anon can READ (rows its policy allows); no writes'
           else 'closed to anon (RLS on, no anon policy)'
         end as answer
    from t left join pol on pol.name = t.name
  union all
  select 'function', f.oid::regprocedure::text, 'n/a', 'EXECUTE', '(n/a)',
         'SECURITY DEFINER callable by anon: runs as its owner, bypassing RLS'
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname = 'public' and f.prosecdef and has_function_privilege('anon', f.oid, 'EXECUTE')
  union all
  select 'check', 'db/035 function name trades_v2_reject_provenance_change', 'n/a', '', '',
         case when exists (select 1 from pg_proc where proname = 'trades_v2_reject_provenance_change')
              then 'NAME TAKEN: db/035 would roll back' else 'free' end
)
select kind, name, rls, anon_grants, policies, answer
  from r
 order by case when answer like 'OPEN%' or answer like 'RLS OFF%' or answer like 'VIEW READABLE%'
                    or answer like 'SECURITY DEFINER%' or answer like 'NAME TAKEN%' then 0
               when answer like 'CHECK%' then 1
               else 2 end,
          kind, name;
