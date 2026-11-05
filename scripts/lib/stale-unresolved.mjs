// scripts/lib/stale-unresolved.mjs -- what a stale-unresolved failure says (2026-11-04).
// On 11-03 and 11-05 the check failed and no log said whether Pass 2 had seen the rows,
// so the cause had to be inferred. Now the failure itself says which case it is.
export function describeStale(stuck, pendingRows) {
  const read = new Set(pendingRows.map(r => r.id));
  const notRead = stuck.filter(r => !read.has(r.id)).length;
  return `${notRead} of them weren't in this run's pending read of ${pendingRows.length} row(s), so Pass 2 never saw them; ${stuck.length - notRead} were read and not resolved`;
}
