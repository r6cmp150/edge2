// scripts/macro-capability-test.mjs -- can the macro classifier give a minority answer? (2026-11-19, the reviewer.)
// Every one of Groq's 19 real answers was "-", and every input it was asked about was a down morning; 9 of them the
// deterministic rule calls CHOPPY. This asks Groq the PRODUCTION question (core/macro.js buildMacroGroqPrompt,
// macroGroqRequestBody, parseMacroGroqReply; app.js GROQ_MODEL) on inputs chosen to call for "+" and "0".
// It writes NOTHING to the database. It reads macro_observations (GET, anon key) only for arms that replay stored asks.
//
// ARMS (declared before any request; arm 4 was cut by the reviewer):
//   1  synthetic, doubled: three declared inputs x two headline conditions (none, the production empty branch; and
//      the 11-16 08:24:52 PT set, headlines hash 5a024fcb) x REPS. Runs first.
//   3  replay as-is: every stored ask, its own moves and headlines, x REPS (repetitions = nondeterminism, headlines
//      held fixed by construction).
//   2  mirror: every stored ask with all five moves' signs flipped, its own headlines, x REPS.
// BUDGET (declared): the worst case per ask is ceil(prompt chars / 3) + 30 template tokens + max_tokens (2,000, the
// production value). The plan is printed and refused if it exceeds --cap (default 150,000 tokens, leaving 50,000 of
// the organisation's 200,000/day for production). Before EVERY ask the worst case is reserved; an ask that would cross
// the cap is not sent and the arm is INCOMPLETE. One ask every --pace ms (default 25,000: a worst case of ~3 asks a
// minute stays under 8,000 TPM). A 429 is retried once after its retry-after (at most 120 s); a second refusal, or any
// other failure, stops the arm as INCOMPLETE. The first and last lines say COMPLETE or INCOMPLETE with the count, and
// the process exits 1 on INCOMPLETE. Everything is printed in full: prompts, raw replies, reasoning, usage, failures.
// The key (GROQ_API_KEY) is read from the environment and never printed.
//   GROQ_API_KEY=... node scripts/macro-capability-test.mjs --arm 1
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { predictedSign } from './lib/macro-sign-test.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPS = 3;
export const TEMPLATE_TOKENS = 30;
export const CHARS_PER_TOKEN = 3;
export const SYNTHETIC = [ // SPY XLE XLK XBI XLF, in % (declared 2026-11-19)
  { label: 'up day', moves: { SPY: 1.50, XLE: 1.00, XLK: 2.00, XBI: 1.20, XLF: 1.10 } },
  { label: 'flat', moves: { SPY: 0.05, XLE: -0.05, XLK: 0.08, XBI: -0.03, XLF: 0.02 } },
  { label: 'up-tech', moves: { SPY: 0.60, XLE: -0.40, XLK: 1.80, XBI: 0.30, XLF: 0.20 } },
];
export const HEADLINE_SET_AT = '2026-11-16T16:24:52'; // the declared held headline set: this ask's, hash 5a024fcb
export const HEADLINE_SET_HASH = '5a024fcb';
export const headlineHash = hs => crypto.createHash('sha256').update(JSON.stringify((hs || []).map(h => h.headline))).digest('hex').slice(0, 8);

// The production code, loaded for real (never restated).
export function loadProduction(root = ROOT) {
  const c = {};
  vm.createContext(c);
  const app = readFileSync(path.join(root, 'app.js'), 'utf8');
  const model = app.match(/^const GROQ_MODEL = '([^']+)';$/m);
  if (!model) throw new Error('GROQ_MODEL not found in app.js');
  c.GROQ_MODEL = model[1];
  vm.runInContext(readFileSync(path.join(root, 'core/macro.js'), 'utf8') + ';globalThis.__p = { buildMacroGroqPrompt, macroGroqRequestBody, parseMacroGroqReply, classifyMacroCondition, MACRO_GROQ_URL, MACRO_GROQ_MAX_TOKENS };', c);
  const edge = readFileSync(path.join(root, 'core/edge-scoring.js'), 'utf8');
  const at = edge.indexOf('const MACRO_ADJUSTMENTS = {');
  vm.runInContext(edge.slice(at, edge.indexOf('\n};\n', at) + 4) + ';globalThis.__adj = MACRO_ADJUSTMENTS;', c);
  return { ...c.__p, GROQ_MODEL: c.GROQ_MODEL, adjustments: c.__adj };
}
export const signOf = (cond, adj) => { if (!cond) return 'none'; const s = predictedSign(cond, adj); return s == null ? '?' : s > 0 ? '+' : s < 0 ? '-' : '0'; };

// The asks an arm makes, in order: { id, input, headlines label, rep, moves, headlines, prompt }.
export function planArm(arm, { prod, stored = [], heldHeadlines = null }) {
  const asks = [];
  const add = (input, hlabel, moves, headlines) => { for (let rep = 1; rep <= REPS; rep++) asks.push({ id: asks.length + 1, input, hlabel, rep, moves, headlines, prompt: prod.buildMacroGroqPrompt(moves, headlines) }); };
  if (arm === 1) {
    if (!heldHeadlines) throw new Error('arm 1 needs the declared headline set');
    for (const s of SYNTHETIC) { add(s.label, 'no headlines', s.moves, []); add(s.label, `held set ${HEADLINE_SET_HASH}`, s.moves, heldHeadlines); }
  } else if (arm === 3 || arm === 2) {
    for (const r of stored) {
      const moves = arm === 3 ? r.etf_moves : Object.fromEntries(Object.entries(r.etf_moves).map(([k, v]) => [k, v == null ? v : -v]));
      add(`${r.fetched_at} (${arm === 3 ? 'as stored' : 'mirrored'}; stored answer ${r.groq_condition})`, `own (${(r.groq_headlines || []).length})`, moves, r.groq_headlines || []);
    }
  } else throw new Error(`no arm ${arm} (arms: 1, 3, 2)`);
  return asks;
}
export const worstCase = (prompt, maxTokens) => Math.ceil(prompt.length / CHARS_PER_TOKEN) + TEMPLATE_TOKENS + maxTokens;

// Runs an arm. fetchImpl, sleep and print are injected (tests drive it with a fake Groq).
export async function runArm({ arm, asks, prod, key, cap, paceMs, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), print = console.log }) {
  const scrub = s => (key ? String(s).split(key).join('<key>') : String(s));
  const out = s => print(scrub(s));
  const worst = asks.map(a => worstCase(a.prompt, prod.MACRO_GROQ_MAX_TOKENS));
  const total = worst.reduce((a, b) => a + b, 0);
  const results = [];
  let reserved = 0, stop = null;
  const status = () => `ARM ${arm} ${stop ? 'INCOMPLETE' : 'COMPLETE'}: ${results.length} of ${asks.length}${stop ? ` (${stop})` : ''}`;
  out(`ARM ${arm} PLAN: ${asks.length} asks; worst case ${total} tokens (per ask: ceil(prompt chars / ${CHARS_PER_TOKEN}) + ${TEMPLATE_TOKENS} + max_tokens ${prod.MACRO_GROQ_MAX_TOKENS}); cap ${cap}; one ask every ${paceMs} ms; model ${prod.GROQ_MODEL}`);
  if (total > cap) { stop = `the plan's worst case ${total} exceeds the cap ${cap}: nothing sent`; out(status()); return { complete: false, results, line: status() }; }
  for (let i = 0; i < asks.length; i++) {
    const a = asks[i];
    if (reserved + worst[i] > cap) { stop = `ask ${a.id} would reserve ${reserved + worst[i]} > cap ${cap}: not sent`; break; }
    reserved += worst[i];
    if (i > 0) await sleep(paceMs);
    const body = prod.macroGroqRequestBody(a.prompt);
    let res = null, attempt = 0, failure = null;
    for (;;) {
      attempt++;
      try { res = await fetchImpl(prod.MACRO_GROQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) }); }
      catch (e) { failure = `request did not complete: ${e?.message || e}`; break; }
      if (res.status === 429 && attempt === 1) {
        const wait = Math.min(120, Number(res.headers.get('retry-after')) || 30);
        out(`ask ${a.id}: 429, retrying once after ${wait} s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) failure = `HTTP ${res.status}${attempt > 1 ? ' after one retry' : ''}: ${await res.text()}`;
      break;
    }
    out(`\n--- ask ${a.id} of ${asks.length} | ${a.input} | headlines: ${a.hlabel} | rep ${a.rep}`);
    out(`prompt (in full):\n${a.prompt}`);
    if (failure) { out(`FAILED: ${failure}`); stop = `ask ${a.id} failed: ${failure.slice(0, 120)}`; break; }
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    const raw = msg.content ?? '';
    const parsed = prod.parseMacroGroqReply(raw);
    out(`raw reply (in full): ${raw}`);
    if (msg.reasoning != null) out(`reasoning (in full): ${msg.reasoning}`);
    out(`usage: ${JSON.stringify(data.usage ?? null)}`);
    out(`parsed: ${parsed ? `${parsed.condition} [${signOf(parsed.condition, prod.adjustments)}]` : 'NAMES NO CONDITION'}`);
    results.push({ ...a, raw, condition: parsed ? parsed.condition : null, usage: data.usage ?? null });
  }
  // the summary: by input, sign first, condition second, and the deterministic rule beside it
  out(`\n${status()}`); // first line of the report; the last line repeats it
  out('SUMMARY (per input: answers by sign, then by condition; the pattern rule\'s answer beside):');
  const byInput = new Map();
  for (const r of results) { const k = `${r.input} | headlines: ${r.hlabel}`; if (!byInput.has(k)) byInput.set(k, []); byInput.get(k).push(r); }
  const tally = xs => { const t = {}; for (const x of xs) t[x] = (t[x] || 0) + 1; return Object.entries(t).map(([k, n]) => `${k} ${n}`).join(', '); };
  for (const [k, rs] of byInput) {
    const pattern = prod.classifyMacroCondition(rs[0].moves).condition;
    out(`  ${k}\n    sign: ${tally(rs.map(r => signOf(r.condition, prod.adjustments)))} | condition: ${tally(rs.map(r => r.condition || 'NONE'))} | pattern rule: ${pattern} [${signOf(pattern, prod.adjustments)}]`);
  }
  const used = results.map(r => r.usage?.total_tokens).filter(n => Number.isFinite(n));
  out(`usage reported: ${used.length} ask(s), total ${used.reduce((a, b) => a + b, 0)} tokens, max per ask ${used.length ? Math.max(...used) : '-'}, reserved ${reserved}`);
  out(status());
  return { complete: !stop, results, line: status() };
}

async function readAsks() {
  const store = readFileSync(path.join(ROOT, 'core/store.js'), 'utf8');
  const U = store.match(/const SUPABASE_URL = '([^']+)'/)[1], K = store.match(/const SUPABASE_ANON_KEY = '([^']+)'/)[1];
  const { fetchAllRows } = await import('./lib/read-all.mjs');
  return fetchAllRows(`${U}/rest/v1/macro_observations?select=id,fetched_at,etf_moves,groq_headlines,groq_condition&groq_asked=eq.true&groq_failed=eq.false&order=fetched_at.asc,id.asc`,
    { apikey: K, Authorization: `Bearer ${K}` }, 'macro_observations (the stored asks)');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
  const arm = Number(opt('--arm', ''));
  const cap = Number(opt('--cap', 150000)), paceMs = Number(opt('--pace', 25000));
  const key = process.env.GROQ_API_KEY;
  if (!key) { console.log(`ARM ${arm} INCOMPLETE: 0 of ? (no GROQ_API_KEY in the environment: nothing sent)`); process.exit(1); }
  const prod = loadProduction();
  const stored = await readAsks();
  const held = stored.find(r => r.fetched_at.startsWith(HEADLINE_SET_AT));
  if (!held || headlineHash(held.groq_headlines) !== HEADLINE_SET_HASH) { console.log(`ARM ${arm} INCOMPLETE: 0 of ? (the declared headline set ${HEADLINE_SET_HASH} at ${HEADLINE_SET_AT} was not found as declared: nothing sent)`); process.exit(1); }
  const asks = planArm(arm, { prod, stored, heldHeadlines: held.groq_headlines });
  const r = await runArm({ arm, asks, prod, key, cap, paceMs });
  console.log(r.line); // the last line, again, after everything
  process.exit(r.complete ? 0 : 1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
