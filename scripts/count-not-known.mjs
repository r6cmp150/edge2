#!/usr/bin/env node
// scripts/count-not-known.mjs — 2026-11-12. db/042's not_known count, logged daily for history by
// backup-tables.yml (the app shows the same count in Settings; a workflow log alone is not a warning). The
// classification is core/execution-mode-count.js, run here unchanged (never re-implemented), so the log and the
// app cannot disagree. READ-ONLY: GET with the anon key, which has SELECT on both tables.
//
// Exit codes: 0 = counted, no defect; 1 = a defect (a not_known row written by a build that records the mode),
// or a read that failed or came back incomplete -- either way the run shows red, with the reason printed above.
//   node scripts/count-not-known.mjs            the live tables (not quotable without its time)
//   node scripts/count-not-known.mjs --rev <c>  data/backups at a commit
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backupRowsAtRev } from './lib/backup-shards.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';

export function loadCounter() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'core/execution-mode-count.js'), 'utf8')
    + '\n;globalThis.__c = { FIRST_MODE_BUILD, countNotKnown, notKnownLines };', ctx);
  return ctx.__c;
}

// Every not_known row of a table, paged; the total from Content-Range must match what was read.
async function liveRows(table, columns, fetchImpl = fetch) {
  const out = [];
  let total = null;
  for (let from = 0; ; from += 1000) {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/${table}?select=${columns}&execution_mode=eq.not_known&order=id.asc`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Range: `${from}-${from + 999}`, Prefer: 'count=exact' } });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`);
    const m = String(r.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (!m) throw new Error(`${table}: no row count back, so completeness is unknown`);
    total = Number(m[1]);
    const page = await r.json();
    out.push(...page);
    if (out.length >= total || page.length < 1000) break;
  }
  const unique = new Map(out.map(x => [x.id, x]));
  if (unique.size !== total) throw new Error(`${table}: read ${unique.size} rows of ${total}`);
  return [...unique.values()];
}

export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, log = console.log } = {}) {
  const i = argv.indexOf('--rev'), rev = i < 0 ? null : argv[i + 1];
  const c = loadCounter();
  let portfolio, trades;
  try {
    if (rev) {
      const nk = rows => rows.filter(r => r.execution_mode === 'not_known');
      portfolio = nk(backupRowsAtRev(rev, 'portfolio', ROOT));
      trades = nk(backupRowsAtRev(rev, 'trades_v2', ROOT));
    } else {
      // CONTROL: trades_v2 is never empty; a total of 0 is a denied or broken read, never "no defects".
      const all = await fetchImpl(`${SUPABASE_URL}/rest/v1/trades_v2?select=id&limit=1`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Prefer: 'count=exact' } });
      if (!all.ok) throw new Error(`trades_v2 control: HTTP ${all.status}`);
      const totalM = String(all.headers.get('content-range') || '').match(/\/(\d+)$/);
      if (!totalM || !Number(totalM[1])) throw new Error('trades_v2 reads back empty, so the count cannot be trusted');
      [portfolio, trades] = await Promise.all([
        liveRows('portfolio', 'id,ticker,execution_mode,execution_mode_source,code_version', fetchImpl),
        liveRows('trades_v2', 'id,ticker,execution_mode,execution_mode_source,sale_code_version', fetchImpl),
      ]);
    }
  } catch (e) {
    log(`not_known count: COULD NOT READ (${e.message}) -- whether any trade was recorded without Live/Paper is unknown.`);
    return 1;
  }
  const counts = c.countNotKnown({ portfolio, trades });
  log(`not_known count, ${rev ? `data/backups at ${rev}` : `live at ${new Date().toISOString()}`}; not_known rows read: ${portfolio.length} positions, ${trades.length} sales; first build that records the mode: ${c.FIRST_MODE_BUILD}`);
  for (const l of c.notKnownLines(counts)) log(`  ${l.bad ? 'DEFECT ' : ''}${l.text}`);
  return counts.defect.positions + counts.defect.sales > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
