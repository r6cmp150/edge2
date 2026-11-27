// Harness run of db/inspect-dead-space-read-only.sql in PGlite, inside a READ ONLY transaction (the database refuses any
// write, so a pass proves the file writes nothing). Two tables of the same rows: one rewritten in full by an UPDATE
// (as db/044-045 did to trades_v2), one never touched. The rewritten one must show the space its old versions hold.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const sqlFile = readFileSync(process.argv[2], 'utf8');
const db = new PGlite();
const v = (await db.query('select version()')).rows[0].version;
await db.exec(`
  create table trades_v2 (id serial primary key, ticker text, signal_before_sale jsonb, peak_rsi_provenance text);
  create table untouched (id serial primary key, ticker text, signal_before_sale jsonb, peak_rsi_provenance text);
  insert into trades_v2 (ticker, signal_before_sale) select 'T' || g, jsonb_build_object('bars', (select jsonb_agg(random()) from generate_series(1, 400))) from generate_series(1, 819) g;
  insert into untouched select * from trades_v2;
  update trades_v2 set peak_rsi_provenance = 'not_sampled';
`);
try { await db.exec('select pg_stat_force_next_flush()'); } catch (_) { /* older server: stats flush at commit */ }
await db.exec('begin transaction read only');
const res = await db.query(sqlFile.replace(/;\s*$/, ''));
await db.exec('commit');
const cell = JSON.parse(Object.values(res.rows[0])[0]);
const by = Object.fromEntries(cell.public_tables.map(t => [t.table, t]));
console.log(`PGlite ${v.split(',')[0]}; one row, one column: ${res.rows.length === 1 && Object.keys(res.rows[0]).length === 1}`);
let ok = true;
for (const t of ['trades_v2', 'untouched']) {
  const r = by[t], disk = r.heap_bytes + r.toast_bytes, gap = disk - r.live_data_bytes;
  console.log(`  ${t}: rows ${r.rows}, dead_rows ${r.dead_rows}, updated ${r.updated}; heap ${r.heap_bytes} + toast ${r.toast_bytes} = ${disk}; live data ${r.live_data_bytes}; space without a live row ${gap} (${(100 * gap / disk).toFixed(0)}%)`);
}
const tv = by.trades_v2, un = by.untouched;
const gapOf = r => r.heap_bytes + r.toast_bytes - r.live_data_bytes;
if (!(tv.live_data_bytes > 0 && un.live_data_bytes > 0)) { ok = false; console.log('  FAIL: live bytes not measured'); }
if (!(gapOf(tv) > gapOf(un))) { ok = false; console.log('  FAIL: the rewritten table does not show more space without a live row'); }
if (!(tv.dead_rows >= 819 || tv.updated >= 819)) console.log(`  NOTE: counters not populated in PGlite (dead ${tv.dead_rows}, updated ${tv.updated}); the byte comparison stands alone here`);
await db.exec('begin transaction read only');
let refused = null; try { await db.exec("insert into trades_v2 (ticker) values ('Y')"); } catch (e) { refused = e.message; }
await db.exec('rollback');
console.log(`  control: a write inside READ ONLY is refused: ${refused ? 'yes (' + refused.slice(0, 60) + ')' : 'NO'}`);
console.log(ok && refused ? 'HARNESS PASS' : 'HARNESS FAIL');
