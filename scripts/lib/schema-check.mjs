// Catches the exact failure class that hit EDGE's first --write dispatch
// and would have hit Warrior's 2026-09-11 13:50 UTC unattended run: code
// that writes a scan_runs/signal_log/setup_triggers column ships in the
// same commit as (or ahead of) the migration that creates it, and nothing
// notices until the first live write against Supabase's real schema --
// which for a scheduled job can be days after the code merged, unattended,
// with nobody watching. Three times now (db/011, db/012, db/014), caught
// each time by someone remembering rather than by anything mechanical.
//
// Runs a read-only, zero-row select against a table for exactly the
// columns a script is about to write, called BEFORE the dry-run early
// return in both loggers -- so a schema gap fails on the very next
// dispatch, dry-run or --write, loudly, naming the missing column, instead
// of silently on whichever run happens to be the first one made in
// --write mode (which is precisely how db/014's gap sat invisible through
// two successful EDGE dry runs tonight: the dry-run path never contacts
// Supabase at all, so it can't see a schema it never queries).
//
// LIMITATION, stated so this is never trusted past what it actually
// checks: this catches MISSING COLUMNS, not INCOMPATIBLE CONSTRAINTS.
// select=<cols>&limit=0 proves each column exists; it says nothing about
// whether the value about to be written satisfies a CHECK, a NOT NULL, a
// foreign key, or any other constraint on that column. db/014 itself had
// two parts -- a new column (prefiltered_count/universe_detail) and a
// widened universe_source CHECK -- and this function only covers the
// first kind. EDGE writing 'static-universe-list' against an un-widened
// CHECK would fail at insert time exactly as before, unhelped by this
// check passing. Column existence is the common, cheap case; it is not
// the only way a migration can be missing.
export async function assertColumnsExist(supabaseUrl, anonKey, table, columns) {
  if (!columns.length) return;
  const uniqueCols = [...new Set(columns)];
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=${uniqueCols.join(',')}&limit=0`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (res.status >= 300) {
    const body = await res.text();
    throw new Error(
      `schema-check: '${table}' is missing one or more columns this script writes: ${uniqueCols.join(', ')}. ` +
      `A migration in db/ has not been applied to this database yet -- run the pending migration before dispatching this script again. Postgrest: ${body}`
    );
  }
}
