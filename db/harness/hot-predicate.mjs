// Does signal_log's partial index (db/001: signal_log_pending_outcomes_idx, WHERE ret_* is null) block HOT updates of
// the ret_* columns? And does a ret_*-only update (fill-outcomes PATCHes only currently-null ret columns) rewrite the
// TOASTed snapshot? Two identical tables in PGlite, one with the predicate index and one without; fillfactor 90 on
// both so page space is not the variable. Read the counters after each fill.
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const setup = (t, withPredicateIdx) => `
  create table ${t} (id serial primary key, signal_date date, symbol text, signal_snapshot jsonb,
    ret_5m numeric, ret_15m numeric, ret_close numeric) with (fillfactor = 90);
  create index on ${t} (signal_date);
  ${withPredicateIdx ? `create index ${t}_pending on ${t} (signal_date) where ret_5m is null or ret_15m is null or ret_close is null;` : ''}
  insert into ${t} (signal_date, symbol, signal_snapshot) select current_date, 'S' || g,
    jsonb_build_object('bars', (select jsonb_agg(random()) from generate_series(1, 600))) from generate_series(1, 300) g;`;
await db.exec(setup('with_pred', true) + setup('no_pred', false));
const size = async t => (await db.query(`select pg_relation_size(c.reltoastrelid) as toast from pg_class c where relname = '${t}'`)).rows[0].toast;
const toastBefore = { with_pred: await size('with_pred'), no_pred: await size('no_pred') };
for (const col of ['ret_5m', 'ret_15m', 'ret_close']) for (const t of ['with_pred', 'no_pred']) await db.exec(`update ${t} set ${col} = 0.01`);
try { await db.exec('select pg_stat_force_next_flush()'); } catch (_) {}
const st = (await db.query(`select relname, n_tup_upd, n_tup_hot_upd from pg_stat_user_tables where relname in ('with_pred', 'no_pred') order by relname`)).rows;
for (const r of st) console.log(`${r.relname}: updated ${r.n_tup_upd}, HOT ${r.n_tup_hot_upd}; TOAST ${toastBefore[r.relname]} -> ${await size(r.relname)} bytes`);
const w = st.find(r => r.relname === 'with_pred'), n = st.find(r => r.relname === 'no_pred');
const toastSame = toastBefore.with_pred === await size('with_pred') && toastBefore.no_pred === await size('no_pred');
const ok = Number(w.n_tup_hot_upd) === 0 && Number(n.n_tup_hot_upd) > 0 && toastSame;
console.log(`predicate index blocks HOT: ${Number(w.n_tup_hot_upd) === 0}; without it some fills are HOT: ${Number(n.n_tup_hot_upd) > 0}; TOAST untouched by ret-only updates: ${toastSame}`);
console.log(ok ? 'HARNESS PASS' : 'HARNESS FAIL');
