// Harness run of db/inspect-sizes-read-only.sql in PGlite (Postgres in WASM), inside a READ ONLY transaction: the
// database itself refuses any write, so a pass proves the file writes nothing. Known row counts, checked exactly.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const sqlFile = readFileSync(process.argv[2], 'utf8');
const db = new PGlite();
const v = (await db.query('select version()')).rows[0].version;
await db.exec(`
  create table rating_snapshots (id bigserial primary key, ticker text, captured_at timestamptz, rsi numeric, tier text);
  create index on rating_snapshots (captured_at);
  create table "Mixed Case" (id int);
  create table trades_v2 (id uuid primary key default gen_random_uuid(), ticker text);
  insert into rating_snapshots (ticker, captured_at, rsi, tier) select 'T' || g, now(), 50, 'SHOWN' from generate_series(1, 1234) g;
  insert into trades_v2 (ticker) select 'X' from generate_series(1, 17);
  insert into "Mixed Case" values (1), (2);
`);
await db.exec('begin transaction read only');
const res = await db.query(sqlFile.replace(/;\s*$/, ''));
await db.exec('commit');
const cell = JSON.parse(Object.values(res.rows[0])[0]);
console.log(`PGlite ${v.split(',')[0]}; one row, one column: ${res.rows.length === 1 && Object.keys(res.rows[0]).length === 1}`);
const by = Object.fromEntries(cell.public_tables.map(t => [t.table, t]));
const want = { rating_snapshots: 1234, trades_v2: 17, 'Mixed Case': 2 };
let ok = true;
for (const [t, n] of Object.entries(want)) { const got = by[t]?.rows; console.log(`  ${t}: rows ${got} (want ${n}), total_bytes ${by[t]?.total_bytes}, index_bytes ${by[t]?.index_bytes}`); if (got !== n) ok = false; }
console.log(`  cluster_total ${cell.cluster_total} (${cell.cluster_total_bytes} bytes); this_database_bytes ${cell.this_database_bytes}; ordered largest first: ${cell.public_tables[0].table === 'rating_snapshots'}`);
// The read-only transaction really refuses a write (the control: the guarantee is the database's, not ours).
await db.exec('begin transaction read only');
let refused = null; try { await db.exec("insert into trades_v2 (ticker) values ('Y')"); } catch (e) { refused = e.message; }
await db.exec('rollback');
console.log(`  control: a write inside READ ONLY is refused: ${refused ? 'yes (' + refused.slice(0, 60) + ')' : 'NO'}`);
console.log(ok && refused ? 'HARNESS PASS' : 'HARNESS FAIL');
