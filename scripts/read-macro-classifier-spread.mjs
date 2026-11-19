// scripts/read-macro-classifier-spread.mjs -- is the macro classifier capable of a minority answer? (2026-11-19, the
// reviewer: "All 3 labelled days are '-'" has two causes, the market or a near-constant classifier, and three labelled
// days cannot tell them apart; every observation on disk can.) READ-ONLY: GET with the anon key, paged, nothing written.
// It prints COUNTS, not conclusions (the reviewer: "counts first, interpretation second").
//
// What a row's groq_condition is: most rows CARRY the day's last answer (groq_asked false), so they are not classifier
// outputs. A classifier output is a row where Groq was ASKED and ANSWERED (groq_asked, groq_failed false). Both are
// counted, apart. The sign is what the sign test uses: predictedSign(condition, MACRO_ADJUSTMENTS) for OTHER, from
// scripts/lib/macro-sign-test.mjs and core/edge-scoring.js, read here, not restated.
//   node scripts/read-macro-classifier-spread.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { fetchAllRows } from './lib/read-all.mjs';
import { predictedSign } from './lib/macro-sign-test.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = readFileSync(path.join(ROOT, 'core/store.js'), 'utf8');
const SUPABASE_URL = store.match(/const SUPABASE_URL = '([^']+)'/)[1];
const KEY = store.match(/const SUPABASE_ANON_KEY = '([^']+)'/)[1];
const edge = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8');
const at = edge.indexOf('const MACRO_ADJUSTMENTS = {');
const c = {};
vm.createContext(c);
vm.runInContext(edge.slice(at, edge.indexOf('\n};\n', at) + 4) + ';globalThis.T = MACRO_ADJUSTMENTS;', c);
const signOf = cond => { if (cond == null) return 'none'; const s = predictedSign(cond, c.T); return s == null ? '?' : s > 0 ? '+' : s < 0 ? '-' : '0'; };

const cols = 'id,fetched_at,trading_date,source,groq_asked,groq_ask_reason,groq_failed,groq_condition,pattern_condition,pattern_matched,pattern_incomplete,etf_moves,path,condition';
const rows = await fetchAllRows(`${SUPABASE_URL}/rest/v1/macro_observations?select=${cols}&order=fetched_at.asc,id.asc`,
  { apikey: KEY, Authorization: `Bearer ${KEY}` }, 'macro_observations');
const tally = (list, f) => { const t = {}; for (const r of list) { const k = f(r); t[k] = (t[k] || 0) + 1; } return Object.entries(t).sort((a, b) => b[1] - a[1]); };
const line = t => t.map(([k, n]) => `${k} ${n}`).join(' | ');
console.log(`read live at ${new Date().toISOString()}: ${rows.length} row(s)`);

console.log('\n1. groq_condition on ALL rows (carried answers included):');
console.log(`   ${line(tally(rows, r => `${r.groq_condition ?? 'NULL'} [${signOf(r.groq_condition)}]`))}`);
const asks = rows.filter(r => r.groq_asked);
const answers = asks.filter(r => r.groq_failed === false && r.groq_condition);
console.log(`\n2. Groq ASKED: ${asks.length}; answered: ${answers.length}; failed: ${asks.filter(r => r.groq_failed).length}`);
console.log(`   answers by condition: ${line(tally(answers, r => `${r.groq_condition} [${signOf(r.groq_condition)}]`))}`);
console.log(`   answers by sign: ${line(tally(answers, r => signOf(r.groq_condition)))}`);
console.log(`   asks with the full moves (pattern not incomplete): ${asks.filter(r => !r.pattern_incomplete).length}`);

console.log('\n3. the deterministic pattern rule on ALL rows (pattern_condition), for comparison:');
console.log(`   ${line(tally(rows, r => `${r.pattern_condition ?? 'NULL (incomplete)'} [${signOf(r.pattern_condition)}]`))}`);

console.log('\n4. per trading day: rows, asks, distinct Groq answers, distinct pattern answers');
const days = [...new Set(rows.map(r => r.trading_date))].sort();
for (const d of days) {
  const dr = rows.filter(r => r.trading_date === d), da = answers.filter(r => r.trading_date === d);
  console.log(`   ${d}: ${dr.length} row(s), ${dr.filter(r => r.groq_asked).length} ask(s), Groq answers [${[...new Set(da.map(r => r.groq_condition))].join(', ')}], pattern answers [${[...new Set(dr.map(r => r.pattern_condition ?? 'NULL'))].join(', ')}]`);
}

console.log('\n5. every Groq answer with the moves it was given (PT time, SPY XLE XLK XBI XLF in %, pattern answer):');
const pt = s => new Date(s).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles', hour12: false }).replace(',', '');
const f = v => (v == null ? '   null' : (v >= 0 ? '+' : '') + Number(v).toFixed(2)).padStart(7);
for (const r of answers) {
  const m = r.etf_moves || {};
  console.log(`   ${pt(r.fetched_at)}  ${r.groq_condition.padEnd(24)} [${signOf(r.groq_condition)}]  ${['SPY', 'XLE', 'XLK', 'XBI', 'XLF'].map(t => f(m[t])).join(' ')}  pattern ${r.pattern_condition ?? 'NULL'} (${r.groq_ask_reason})`);
}
