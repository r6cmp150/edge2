// scripts/lib/select-by-ids.mjs -- re-select rows by id, in chunks.
//
// Fill outcomes failed its first run on five evenings (10-26 to 10-30 PT)
// with "TypeError: fetch failed" after every PATCH had succeeded: the
// verification re-select put every touched id in one URL,
// `?id=in.(<all ids>)`. Measured 2026-11-01 against signal_log: 371 ids
// (a 13,806-character URL) answers 200; 400 ids fails with
// UND_ERR_HEADERS_OVERFLOW. The touched count crossed that line on 10-26
// (452) and grows with the logger's row volume, so it would fail more
// often, not less. CHUNK ids per request keeps each URL under 4,000
// characters (UUID 36 + comma = 37 per id), a quarter of the measured
// ceiling.
export const SELECT_BY_IDS_CHUNK = 100;

export async function selectByIds(baseUrl, table, ids, select, headers, fetchImpl = fetch) {
  const rows = [];
  for (let i = 0; i < ids.length; i += SELECT_BY_IDS_CHUNK) {
    const chunk = ids.slice(i, i + SELECT_BY_IDS_CHUNK);
    const res = await fetchImpl(`${baseUrl}/rest/v1/${table}?id=in.(${chunk.join(',')})&select=${select}`, { headers });
    if (res.status >= 300) throw new Error(`${table} re-select of ${chunk.length} id(s) failed: ${res.status} ${await res.text()}`);
    rows.push(...await res.json());
  }
  return rows;
}
