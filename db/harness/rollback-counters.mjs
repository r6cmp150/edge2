// What does an INSERT that rolls back leave in pg_stat_all_tables? (db/044's behaviour runs insert into
// peak_corrections, then raise so everything rolls back.) Two such runs, then compare with a real insert-and-delete.
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
await db.exec(`create table rolled (id serial primary key, v text); create table deleted (id serial primary key, v text);`);
for (let i = 0; i < 2; i++) {
  try { await db.exec(`do $$ begin insert into rolled (v) values ('x'); raise exception 'raised on purpose so everything rolls back'; end $$;`); } catch (_) {}
}
await db.exec(`insert into deleted (v) values ('a'), ('b'); delete from deleted;`);
try { await db.exec('select pg_stat_force_next_flush()'); } catch (_) {}
const r = (await db.query(`select relname, n_tup_ins, n_tup_del, n_live_tup, n_dead_tup from pg_stat_user_tables where relname in ('rolled', 'deleted') order by relname`)).rows;
for (const x of r) console.log(`${x.relname}: inserted ${x.n_tup_ins}, deleted ${x.n_tup_del}, rows ${x.n_live_tup}, dead_rows ${x.n_dead_tup}`);
const ro = r.find(x => x.relname === 'rolled'), de = r.find(x => x.relname === 'deleted');
const ok = Number(ro.n_tup_ins) === 2 && Number(ro.n_tup_del) === 0 && Number(ro.n_live_tup) === 0 && Number(ro.n_dead_tup) === 2 && Number(de.n_tup_del) === 2;
console.log(`two rolled-back inserts read "inserted 2, rows 0, dead 2" with deleted 0; a real delete shows deleted 2: ${ok}`);
console.log(ok ? 'HARNESS PASS' : 'HARNESS FAIL');
