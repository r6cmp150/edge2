// scripts/run-macro-sign-test.mjs -- runs the primary pre-committed macro test
// (phase-10 spec) on the db/038 log, and nothing else. Committed before the log has a
// row, so the procedure can't be shaped by what the data shows. Read-only.
//   node scripts/run-macro-sign-test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { assertReadable } from './lib/readable.mjs';
import { buildDays, signTest } from './lib/macro-sign-test.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = readFileSync(path.join(ROOT, 'core/store.js'), 'utf8');
const SUPABASE_URL = store.match(/const SUPABASE_URL = '([^']+)'/)[1];
const KEY = store.match(/const SUPABASE_ANON_KEY = '([^']+)'/)[1];
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const edge = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8');
const at = edge.indexOf('const MACRO_ADJUSTMENTS = {');
const c = {};
vm.createContext(c);
vm.runInContext(edge.slice(at, edge.indexOf('\n};\n', at) + 4) + ';globalThis.T = MACRO_ADJUSTMENTS;', c);

async function readAll(table, query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&order=id&limit=1000&offset=${offset}`, { headers });
    if (res.status >= 300) throw new Error(`${table}: read failed (${res.status} ${await res.text()})`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// signal_log can't be empty (tests/empty-read-controls.test.js has the evidence).
// macro_observations truly can, so it gets no positive control: empty here is not a
// result of any kind, and says it can't tell which empty it is.
await assertReadable(SUPABASE_URL, headers, 'signal_log');
const observations = await readAll('macro_observations', 'select=id,trading_date,fetched_at,pattern_condition,pattern_incomplete,groq_condition');
if (!observations.length) {
  console.log('macro_observations read back empty: nothing logged yet, or a denied read, and this script cannot tell which. Not a result.');
  process.exit(1);
}
const signals = await readAll('signal_log', 'select=id,signal_date,engine_source,tier,first_shown_at,ret_close,ret_close_split_in_window&engine_source=eq.EDGE&tier=eq.SHOWN');
const { days, dropped } = buildDays(observations, signals, c.T);
const result = signTest(days);
console.log(`Read live ${new Date().toISOString()}: ${observations.length} observations, ${signals.length} shown signals.`);
console.log(JSON.stringify(result, null, 2));
if (result.reading) console.log(`\nREADING (pre-registered, phase-10 spec): ${result.reading}`);
console.log(`Dropped ${dropped.length} day(s):`);
for (const d of dropped) console.log(`  ${d.date}  ${d.reason}`);
