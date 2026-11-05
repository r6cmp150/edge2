// scripts/lib/read-all.mjs -- every row a PostgREST query matches (2026-11-04).
// PostgREST answers any read with at most 1,000 rows, status 200 and no error,
// so an unpaged read of a table past that silently truncates. fill-outcomes read
// exactly 1,000 of its pending rows this way on 2026-11-03 and 2026-11-05.
// Completeness comes from Postgres's own count, not from a short page. `url` must
// carry an order= with a unique tie-break, or rows can repeat or vanish across pages.
const PAGE_SIZE = 1000;

export async function fetchAllRows(url, headers, label, fetchImpl = fetch) {
  const rows = [];
  for (;;) {
    const res = await fetchImpl(url, { headers: { ...headers, Prefer: 'count=exact', Range: `${rows.length}-${rows.length + PAGE_SIZE - 1}` } });
    if (res.status >= 300) throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
    const total = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (!total) throw new Error(`${label}: no authoritative row count (Content-Range "${res.headers.get('content-range')}")`);
    const page = await res.json();
    rows.push(...page);
    if (rows.length >= Number(total[1]) || !page.length) {
      if (rows.length !== Number(total[1])) throw new Error(`${label}: read ${rows.length} rows of ${total[1]}`);
      console.log(`${label}: read ${rows.length} row(s), matching Postgres's count of ${total[1]}.`);
      return rows;
    }
  }
}

// For a read left unpaged because it can't reach the limit: says so if it did. Exactly
// a page full is what a silently cut read looks like, so it must show in the job's log.
export function warnIfAtPageLimit(label, rows) {
  if (rows.length >= PAGE_SIZE) console.warn(`${label}: READ AT PAGE LIMIT -- ${rows.length} row(s), which is what a cut read looks like.`);
  return rows;
}
