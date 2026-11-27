// Does an UPDATE that rolls back still count in pg_stat_all_tables.n_tup_upd? (2026-11-27: trades_v2 reads 51,025
// updates on 920 rows over its life; db/035-045's behaviour runs rewrite the table and then raise on purpose.)
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
await db.exec(`create table t (id serial primary key, v text); insert into t (v) select 'x' from generate_series(1, 100);`);
try { await db.exec(`do $$ begin update t set v = 'y'; raise exception 'raised on purpose so everything rolls back'; end $$;`); } catch (_) {}
try { await db.exec('select pg_stat_force_next_flush()'); } catch (_) {}
const r = (await db.query(`select n_tup_upd, n_live_tup, (select count(*) from t where v = 'y') as changed from pg_stat_user_tables where relname = 't'`)).rows[0];
console.log(`100 rows updated in a transaction that rolled back: n_tup_upd ${r.n_tup_upd}, rows ${r.n_live_tup}, rows actually changed ${r.changed}`);
const ok = Number(r.n_tup_upd) === 100 && Number(r.changed) === 0;
console.log(`a rolled-back UPDATE still counts in n_tup_upd: ${ok}`);
console.log(ok ? 'HARNESS PASS' : 'HARNESS FAIL');
