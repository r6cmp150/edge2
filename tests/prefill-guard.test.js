// tests/prefill-guard.test.js -- 2026-11-22 (the reviewer approved it: "build it, both directions, with the allowed-uses
// list also checked both ways"). A pre-filled form value compared with the value it was pre-filled from can only see
// whether Roman edited the field: entry_vs_signal_price_pct was exactly that (the self-referential-guard sweep, #1).
//
// THE REGISTRY, both directions:
//   (a) every <input ... value="${...}"> in app.js is registered, as a PRE-FILL (with what it carries and what it was
//       filled from) or as an EXEMPT settings field (with its reason); a new pre-fill fails until it is registered;
//   (b) every registered id is still a pre-filled input: an entry that matches nothing fails.
// THE RULE: no expression in app.js or core/ compares a pre-fill's CARRIER (the variables its value travels in, through
//   every function it is passed to) with its SOURCE (what it was filled from), with - / === !== == != < > <= >=. Each
//   match must be an ALLOWED use with its reason, and each allowed use must match exactly once (an allowance that
//   matches nothing fails, so a fix forces its removal).
// WHAT IT CANNOT CATCH (said in the proposal, kept here): a carrier renamed in a way the registry does not list; the
//   source re-read under another name; comparisons in scripts/ or SQL; and two readings of ONE CLOCK, which is not a
//   pre-fill (tests/same-clock-guard.test.js covers that, from docs/field-provenance.md's clock column).
'use strict';
const assert = require('assert');
const { run, readSource } = require('./_lib');

const app = readSource('app.js');
const code = { 'app.js': app, 'core/orders.js': readSource('core/orders.js'), 'core/store.js': readSource('core/store.js'), 'core/edge-scoring.js': readSource('core/edge-scoring.js') };

const PREFILLS = {
  'pf-price':   { carriers: ['price'], sources: ['sig\\??\\.price'] },
  'pf-date':    { carriers: ['date'], sources: ['today'] },
  'mf-date':    { carriers: ['fillDate'], sources: ['today'] },
  'mf-time':    { carriers: ['fillTime'], sources: ['hhmm'] },
  'mf-price':   { carriers: ['fillPrice'], sources: ['p\\.buyPrice'] },
  'sold-price': { carriers: ['salePrice'], sources: ['currentPrice'] },
  'sold-date':  { carriers: ['saleDate', 'this\\.value'], sources: ['today', 'todayPT', "'\\$\\{today\\}'"] },
  'sold-time':  { carriers: ['saleTime', 'soldTimeEl\\.value'], sources: ['defaultTime', 'hhmm', 'soldTimeEl\\.dataset\\.default'] },
};
const EXEMPT = { // settings fields: the form shows the current value so it can be edited; it is not a measurement
  'set-alpaca-key': 'settings', 'set-alpaca-secret': 'settings', 'set-groq-key': 'settings', 'set-budget': 'settings',
  'set-risk-per-trade': 'settings', 'set-float-threshold': 'settings', 'set-max-loss-pct': 'settings',
};
// each: [the exact text that must appear once, the reason it is allowed or why it stands]
const ALLOWED = [
  ["source: saleTime === defaultTime ? 'default' : 'entered'", 'DETECTS the default: the correct use (core/orders.js readSaleFill)'],
  ["oninput=\"if (this.value !== '${today}')", 'DETECTS an edit of the date, to clear the time: the correct use (openMarkSoldModal)'],
  ['((price - sig.price) / sig.price) * 100', 'KNOWN VIOLATION, the sweep\'s #1: entry_vs_signal_price_pct measures only an edit (docs/field-provenance.md: can be fabricated). Remove this line when it is fixed.'],
  ['if (!capture || saleDate !== todayPT) return', 'KNOWN, found by this guard 2026-11-22: the "same-day display" gate compares the sale date with today, its default, so a late recording left at the default reads as same-day. Flagged to the reviewer; remove when ruled on.'],
];

function prefilledInputs(src) {
  const ids = new Map();
  for (const m of src.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\bvalue="\$\{/.test(tag)) continue;
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    assert.ok(id, `a pre-filled input without an id: ${tag.slice(0, 80)}`);
    ids.set(id, (ids.get(id) || 0) + 1);
  }
  return ids;
}

run('(a) every pre-filled input is registered, as a pre-fill or an exempt settings field', () => {
  for (const id of prefilledInputs(app).keys()) assert.ok(PREFILLS[id] || EXEMPT[id], `unregistered pre-fill: ${id} -- register it in tests/prefill-guard.test.js`);
});

run('(b) every registered id is still exactly one pre-filled input: an entry that matches nothing fails', () => {
  const found = prefilledInputs(app);
  for (const id of [...Object.keys(PREFILLS), ...Object.keys(EXEMPT)]) assert.strictEqual(found.get(id), 1, `registered but not a pre-filled input (once): ${id}`);
});

const OPS = '(?:-|\\/|===|!==|==|!=|<=|>=|<|>)';
function comparisons() {
  const hits = [];
  for (const [file, src] of Object.entries(code)) {
    const lines = src.split('\n');
    for (const [id, { carriers, sources }] of Object.entries(PREFILLS)) for (const c of carriers) for (const s of sources) {
      const re = new RegExp(`(?<![.\\w$])(?:${c}\\s*${OPS}\\s*${s}|${s}\\s*${OPS}\\s*${c})(?![\\w$])`);
      lines.forEach((l, i) => { if (re.test(l) && !/^\s*\/\//.test(l)) hits.push({ id, file, line: i + 1, text: l.trim() }); });
    }
  }
  return hits;
}

run('THE RULE: no carrier is compared with its source, except the allowed uses', () => {
  for (const h of comparisons()) assert.ok(ALLOWED.some(([t]) => h.text.includes(t)), `${h.file}:${h.line} compares ${h.id}'s pre-filled value with its source: ${h.text.slice(0, 120)}`);
});

run('each allowed use matches exactly once: an allowance that matches nothing fails, so a fix forces its removal', () => {
  const hits = comparisons();
  for (const [t, why] of ALLOWED) {
    assert.ok(why.length > 20, 'every allowance has its reason');
    assert.strictEqual(hits.filter(h => h.text.includes(t)).length, 1, `allowed use not found exactly once: ${t}`);
  }
});

run('every registered carrier and source occurs in the code: a dead name would let a renamed carrier pass silently', () => {
  const all = Object.values(code).join('\n');
  for (const [id, { carriers, sources }] of Object.entries(PREFILLS)) for (const n of [...carriers, ...sources])
    assert.ok(new RegExp(`(?<![.\\w$])${n}(?![\\w$])`).test(all), `${id}: "${n}" occurs nowhere`);
});

run('the guard sees the shape it exists for (a synthetic violation is caught)', () => {
  const saved = code['app.js'];
  code['app.js'] = saved + '\nconst slip = (salePrice - currentPrice) / currentPrice;\n';
  try { assert.ok(comparisons().some(h => h.id === 'sold-price'), 'a sale price compared with its pre-fill must be caught'); }
  finally { code['app.js'] = saved; }
});
