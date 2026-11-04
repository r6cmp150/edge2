// scripts/lib/readable.mjs — 2026-11-02, auth plan step 4½. Row-level
// security answers a read it won't allow with an EMPTY LIST, not an error, so
// "no rows" from a table is ambiguous: none exist, or this credential can't
// see them. Call this only where the table CANNOT be empty, and say why at the
// call site: its rows are never deleted (the backup's floors in scripts/lib/
// backup-rules.mjs), or this run has just inserted into it. setup_triggers is
// the second kind: it held 0 rows live on 2026-11-04, so its control runs only
// after a successful insert. One row must come back before anything read from
// the table is acted on. If it doesn't, the run stops, red, and says why: it
// never writes a resolution, fires a scan, or reports a check passed on the
// strength of an empty read (tests/empty-read-sites.test.js).
export async function assertReadable(baseUrl, headers, table, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseUrl}/rest/v1/${table}?select=*&limit=1`, { headers });
  if (res.status >= 300) throw new Error(`${table}: positive-control read failed (${res.status} ${await res.text()}); nothing read from it this run can be trusted`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`${table} reads back EMPTY where it can't be empty, so this is a denied or broken read (RLS answers a denied read with an empty list, not an error). Refusing to act on anything read from ${table} this run.`);
  }
}

// A re-read after a write must find every row the write reported: fewer is a
// write that didn't land, or a read that can't see it. Either way not a pass.
export function assertReReadComplete(label, expected, found) {
  if (found !== expected) throw new Error(`${label}: re-read found ${found} of ${expected} row(s); a verification that sees fewer than it wrote is not a pass`);
}
