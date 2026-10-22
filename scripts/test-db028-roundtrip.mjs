// scripts/test-db028-roundtrip.mjs -- the REAL round trip for db/028's
// write-once trigger against the live portfolio table (phase-10 spec §7.7
// trip-wire). Not a mock of the intended shape: the real core/store.js
// mapper and insert/update functions, the real supabase-js client, the real
// PostgREST endpoint, the real trigger.
//
//   npm install --no-save @supabase/supabase-js@2.45.4   (once; not a repo dep)
//   node scripts/test-db028-roundtrip.mjs
//
// A. insertPositionToSupabase writes code_version; re-select shows it.
// B. A background save (savePositionToSupabase -> mapPositionToSupabaseRow,
//    the path every peak-price save takes) SUCCEEDS, its own field lands,
//    and code_version is unchanged on re-select.
// C. Negative control: an update that nulls code_version is REFUSED by the
//    trigger, and re-select shows the value intact. This proves the
//    trigger is live, so B passing means the mapper really doesn't touch
//    the column (and isn't passing only because nothing checks).
// D. Cleanup: the row is deleted (anon can delete on portfolio) and the
//    re-select is empty. It always runs, even after a failure.
//
// Uses ticker ZZDB028 and position_id db028-<timestamp>, so it can't be
// mistaken for a real position. It exists for about a second.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => readFileSync(path.join(ROOT, f), 'utf8');

const stampTag = read('index.html').match(/<script src="(app\.js\?v=[^"]+)"/)[1];
// Minimal document: currentCodeVersion() reads the loaded app.js tag, and
// this gives it the real one from index.html.
const ctx = { console, Date, JSON, Math, Number, String, Object, Array, Error, Promise,
  // core/store.js builds its OWN client at load from window.supabase, with its
  // own URL and key, exactly as in the browser; nothing is hard-coded here.
  window: { supabase: { createClient: (url, key) => createClient(url, key, { auth: { persistSession: false } }) } },
  document: { querySelector: sel => (sel === 'script[src*="app.js?v="]' ? { getAttribute: () => stampTag } : null) } };
vm.createContext(ctx);
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
vm.runInContext(strip(read('core/edge-scoring.js')) + ';globalThis.__SV = SCORING_VERSION; globalThis.__SH = SCORING_HASH;', ctx);
vm.runInContext(read('core/store.js') + '\n;globalThis.__store = { insertPositionToSupabase, savePositionToSupabase, deletePositionFromSupabase, mapPositionToSupabaseRow, client: supabaseClient, url: SUPABASE_URL };', ctx);
const S = ctx.__store;
const client = S.client;
console.log(`target: ${S.url} (core/store.js's own client)`);

const id = `db028-${Date.now()}`;
const today = new Date().toISOString().slice(0, 10);
const position = {
  id, ticker: 'ZZDB028', company: 'db/028 round-trip test', shares: 1, buyPrice: 1.23, buyDate: today, buyTime: '09:30',
  scoreAtBuy: 50, rsiAtBuy: 50, volRatioAtBuy: 1, peakPrice: 1.23, peakPriceDate: today,
  engineSource: 'EDGE', orderType: 'market', filledAt: new Date().toISOString(),
};
const select = async () => {
  const { data, error } = await client.from('portfolio').select('position_id, peak_price, code_version').eq('position_id', id);
  if (error) throw new Error(`re-select failed: ${error.message}`);
  return data;
};
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failures++; };

try {
  // A
  await S.insertPositionToSupabase(position);
  let rows = await select();
  check(rows.length === 1 && rows[0].code_version && rows[0].code_version.app === stampTag.split('=')[1]
    && rows[0].code_version.scoring === ctx.__SV && rows[0].code_version.scoring_hash === ctx.__SH,
    `A: insert wrote code_version ${JSON.stringify(rows[0]?.code_version)}`);
  const written = JSON.stringify(rows[0]?.code_version);
  check(!('code_version' in S.mapPositionToSupabaseRow(position)), 'A: the shared mapper does not emit code_version');

  // B
  position.peakPrice = 1.5;
  let bError = null;
  try { await S.savePositionToSupabase(position); } catch (e) { bError = e; }
  rows = await select();
  check(bError == null, `B: background save through the real mapper succeeded${bError ? ` (threw: ${bError.code || ''} ${bError.message})` : ''}`);
  check(rows[0]?.peak_price == 1.5, `B: the save's own field landed (peak_price ${rows[0]?.peak_price})`);
  check(JSON.stringify(rows[0]?.code_version) === written, 'B: code_version unchanged after the save');

  // C
  const { error: cError } = await client.from('portfolio').update({ code_version: null }).eq('position_id', id);
  rows = await select();
  check(!!cError && /write-once/.test(cError.message), `C: nulling code_version was refused by the trigger (${cError ? cError.message : 'NOT refused'})`);
  check(JSON.stringify(rows[0]?.code_version) === written, 'C: code_version intact after the refused update');
} catch (e) {
  check(false, `unexpected: ${e.message}`);
} finally {
  // D
  try { await S.deletePositionFromSupabase(id); } catch (e) { console.log(`cleanup delete threw: ${e.message}`); }
  const left = await select().catch(e => { console.log(e.message); return null; });
  check(Array.isArray(left) && left.length === 0, `D: test row deleted (re-select returned ${left ? left.length : 'error'})`);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
