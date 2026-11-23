// tests/same-clock-guard.test.js -- 2026-11-22 (the reviewer: "you built that registry today ... add a clock source
// column and the rule becomes mechanical"). Two fields read from ONE clock may not be compared as evidence about timing:
// buy_time against position_id and sell_time against created_at were my #2 and #3 (5104c49), and sell_date against
// created_at's date was the retracted recording-lag audit (7f32ffa).
//
// THE REGISTRY is docs/field-provenance.md's Clock column, read here, so the doc and the guard cannot drift apart.
// THE RULE: in scripts/, no line that compares (=== !== == != < > <= >= a spaced minus, Math.abs) refers to two different
//   fields sharing a clock, directly or through a simple alias (a variable, property or arrow function defined on a line
//   from one field: `sd = String(r.sell_date)`, `sellMs = r => f(r.sell_time)`). Each such line must be an ALLOWED use,
//   with its reason, and each allowed use must match exactly once (an allowance that matches nothing fails).
// WHAT IT CANNOT SEE: an alias more than a few steps deep or built across lines; a comparison split over lines; app.js
//   and SQL (scripts only: that is where timing evidence is argued); and the PURPOSE of a comparison, which is why
//   every match is listed with its reason rather than refused.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, REPO_ROOT, readSource } = require('./_lib');

const doc = readSource('docs/field-provenance.md');
const NON_CLOCKS = new Set(['—', 'typed, or the form opening']); // a typed value is not one clock shared with anything

// field -> clock, from the doc's tables (first backticked name of each row)
function clockRegistry(text) {
  const reg = new Map();
  for (const l of text.split('\n')) {
    if (!/^\| (the )?`/.test(l)) continue;
    const cells = l.split(' | ');
    const field = (cells[0].match(/`([^`]+)`/) || [])[1], clock = (cells[2] || '').trim();
    if (field && !NON_CLOCKS.has(clock)) reg.set(field, clock);
  }
  return reg;
}
const REG = clockRegistry(doc);

const ALLOWED = [
  ["Math.floor(Number(r.position_id) / 60000) * 60000 === buyMinuteUtc(", 'PERMANENT: scripts/measure-entry-price-gap.mjs prints it as a CONVERSION check, "not when the buy was decided" (5104c49); a pre-registered script, kept as run'],
  ['Math.abs(Date.parse(r.created_at) - sellMs(r)) <= 2 * 60000', 'PERMANENT: scripts/measure-exit-price-gap.mjs prints it as a CONVERSION check, "not when the sale was made" (5104c49); a pre-registered script, kept as run'],
  ['sellLate = xs.filter(x => x.saleRec !== x.sd)', 'PERMANENT: scripts/audit-recording-lag.cjs counts an EDITED sell_date, and its output says recording lag is not measured (retracted, 7f32ffa)'],
  ["const inB = b.filter(x => !x.buyRec || x.buyRec !== x.bd || x.saleRec !== x.sd);", 'PERMANENT: scripts/audit-recording-lag.cjs, the same edited-date counts within the 07:00 bucket (retracted, 7f32ffa)'],
  ['if (rec === sd) lag.same++; else if (sd < rec)', 'PERMANENT: scripts/audit-sell-dates-vs-tape.mjs test 1 compares sell_date with the recording date, and its header says "the default or a same-day sale (can\'t tell which)"'],
];
// KNOWN BLIND SPOT, named rather than allowed: audit-recording-lag.cjs's buy half (x.buyRec !== x.bd) is the same
// shape, but buyRec comes from position_id through a Map (addRec.set(k, t)), which is not an assignment this guard
// follows. Its output already says recording lag is not measured (7f32ffa).

// a reading's halves are ONE reading: buy_date + buy_time (+ buy_session) compose the add's recorded moment; comparing them
// with each other is composition, not a comparison. Two DIFFERENT readings of one clock compared is the violation.
const readingOf = field => field.replace(/_(date|time|session)$/, '');
const scriptFiles = () => ['scripts', 'scripts/lib'].flatMap(d => fs.readdirSync(path.join(REPO_ROOT, d)).filter(f => /\.(mjs|cjs|js)$/.test(f)).map(f => `${d}/${f}`));
const CMP = /(===|!==|==|!=|<=|>=|(?<![=<>-])<(?![=<-])|(?<![=-])>(?![=>])|\s-\s)/g;
// one operand of a comparison: from the operator out to the nearest clause boundary (; && || ? , or a template's ${ })
const LEFT_STOP = /(;|&&|\|\||\?|,|\$\{|\})(?![\s\S]*(;|&&|\|\||\?|,|\$\{|\}))/, RIGHT_STOP = /(;|&&|\|\||\?|,|\$\{|\}|`)/;

function hits(files = scriptFiles(), reader = f => readSource(f)) {
  const fields = [...REG.keys()], out = [];
  for (const f of files) {
    const lines = reader(f).split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l));
    const alias = new Map(); // name -> field
    const mentions = seg => fields.filter(x => new RegExp(`(?<![\\w$])${x}(?![\\w$])`).test(seg) || [...alias].some(([n, fx]) => fx === x && new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(seg)));
    for (let pass = 0; pass < 3; pass++) for (const l of lines) {
      const defs = [...l.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|:)\s*/g)];
      defs.forEach((d, i) => {
        const seg = l.slice(d.index + d[0].length, defs[i + 1] ? defs[i + 1].index : l.length);
        const m = mentions(seg);
        // an alias stands for ONE reading (sellMs = r => f(r.sell_date, r.sell_time) is the save's reading)
        // a single-letter name (r, x, a, k, i ...) is a loop or row variable, never an alias
        if (d[1].length > 1 && m.length && new Set(m.map(readingOf)).size === 1 && !fields.includes(d[1])) alias.set(d[1], m[0]);
      });
    }
    lines.forEach((l, i) => {
      for (const op of l.matchAll(CMP)) {
        const before = l.slice(0, op.index), after = l.slice(op.index + op[0].length);
        const lm = before.match(LEFT_STOP), left = lm ? before.slice(lm.index + lm[0].length) : before;
        const rm = after.match(RIGHT_STOP), right = rm ? after.slice(0, rm.index) : after;
        const L = mentions(left), R = mentions(right);
        // one reading on EACH side of the operator, on the same clock, and they are different readings
        const pair = L.flatMap(a => R.filter(b => REG.get(a) === REG.get(b) && readingOf(a) !== readingOf(b)).map(b => [a, b]));
        if (pair.length) { out.push({ file: f, line: i + 1, clock: REG.get(pair[0][0]), fields: [...new Set(pair.flat())], text: l.trim() }); break; }
      }
    });
  }
  return out;
}

run('the registry is read from the doc: the add, the save and the scan each pair the fields they should', () => {
  assert.strictEqual(REG.get('buy_time'), 'the add'); assert.strictEqual(REG.get('position_id'), 'the add');
  assert.strictEqual(REG.get('sell_time'), 'the save'); assert.strictEqual(REG.get('created_at'), 'the save');
  assert.strictEqual(REG.get('sell_date'), 'the save'); assert.strictEqual(REG.get('buy_date'), 'the add');
  assert.ok(!REG.has('filled_at') && !REG.has('shares'), 'a typed value and a non-time are on no clock');
  for (const l of doc.split('\n').filter(x => /^\| (the )?`/.test(x))) assert.ok(l.split(' | ').length >= 4, `a row without a Clock cell: ${l.slice(0, 60)}`);
});

run('THE RULE: no analysis script compares two fields of one clock, except the allowed uses', () => {
  if (process.env.SAME_CLOCK_LIST) for (const h of hits()) console.log(`  ${h.file}:${h.line} ${h.fields.join('/')} | ${h.text.slice(0, 120)}`);
  for (const h of hits()) assert.ok(ALLOWED.some(([t]) => h.text.includes(t)), `${h.file}:${h.line} compares ${h.fields.join(' and ')} (both ${h.clock}): ${h.text.slice(0, 140)}`);
});

run('each allowed use matches exactly once: an allowance that matches nothing fails', () => {
  const hs = hits();
  for (const [t, why] of ALLOWED) { assert.ok(why.length > 20); assert.ok(why.startsWith('PERMANENT: '), `an allowance that is not permanent: ${why.slice(0, 60)}`); assert.strictEqual(hs.filter(h => h.text.includes(t)).length, 1, `allowed use not found exactly once: ${t}`); }
});

run('it sees the shapes it exists for: direct, through a variable, and through an arrow function', () => {
  const fake = { 'x.mjs': "const ok = Number(r.position_id) === toMs(r.buy_date, r.buy_time);", 'y.mjs': "const sd = String(r.sell_date).slice(0, 10), rec = ptDate(r.created_at);\nif (rec !== sd) n++;", 'z.mjs': "const sMs = r => f(r.sell_time);\nconst lag = Date.parse(r.created_at) - sMs(r);", 'w.mjs': "const lag = Number(r.position_id) - Number(s.first_shown_at);" };
  const hs = hits(Object.keys(fake), f => fake[f]);
  assert.deepStrictEqual(hs.map(h => h.file).sort(), ['x.mjs', 'y.mjs', 'z.mjs'], 'different clocks (w) pass');
});
