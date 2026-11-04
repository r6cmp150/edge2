// tests/macro-classifier.test.js — 2026-11-02, observe-only part 4. The
// deterministic macro rule (classifyMacroCondition) gets fixtures for every
// condition it can name, the four contexts stored on 10-29/10-30 with what
// the rule said then, and boundary cases; and the replay's list of rule
// thresholds (scripts/replay-macro-firing.mjs RULE_EDGES) is checked against
// the rule's own source so the input-precision test can't drift from it. A
// classifier that always returns one value, drops a rule, or flips a
// comparison fails here (mutation set in the 2026-11-02 report).
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const i = app.search(/^function classifyMacroCondition\(/m);
const src = app.slice(i, app.indexOf('\n}\n', i) + 3);
const c = {};
vm.createContext(c);
vm.runInContext(src + ';globalThis.cls = classifyMacroCondition;', c);
const m = (o) => ({ SPY: 0, XLE: 0, XLK: 0, XBI: 0, XLF: 0, ...o });
const got = o => { const r = c.cls(m(o)); return { condition: r.condition, matched: [...r.matched] }; };

run('every condition the rule can name has a case that produces it, alone', () => {
  const cases = {
    RISK_OFF: { SPY: -2.5, XLE: -1, XLK: -1, XBI: -1, XLF: 0.2 },
    GEOPOLITICAL: { SPY: -1.2, XLE: 1.5 },
    // Alone only with SPY <= -1: above that, XLK <= -1.5 also fires
    // SECTOR_WEAKNESS_TECH, so the rule is ambiguous and the app asks Groq.
    TECH_ROTATION_OUT: { SPY: -1.2, XLK: -1.8, XLE: 0.6 },
    BROAD_RALLY: { SPY: 1.2, XLE: 0.3, XLK: 0.5, XBI: 0.4, XLF: -0.1 },
    MOMENTUM_DAY: { SPY: 1.6, XLK: 1.6, XLE: -0.5, XBI: -0.5, XLF: -0.5 },
    SECTOR_WEAKNESS_BIOTECH: { XBI: -1.6 },
    SECTOR_WEAKNESS_ENERGY: { XLE: -1.6 },
    SECTOR_WEAKNESS_TECH: { XLK: -1.6 },
    CHOPPY: {},
  };
  for (const [want, o] of Object.entries(cases)) {
    const r = got(o);
    assert.strictEqual(r.condition, want, `${want}: got ${r.condition} [${r.matched}]`);
    assert.ok(want === 'CHOPPY' ? r.matched.length === 0 : r.matched.length === 1, `${want}: matched ${r.matched}`);
  }
});

run('the four contexts stored on 10-29 / 10-30 give what the rule gave then', () => {
  const stored = [
    [{ SPY: 0.0741, XLE: 0.8647, XLK: 0.1794, XBI: 1.0430, XLF: 0.3937 }, 'CHOPPY', []],
    [{ SPY: -0.35, XLE: 0.38, XLK: -1.11, XBI: 1.28, XLF: 1.69 }, 'CHOPPY', []],
    [{ SPY: -0.62, XLE: -0.13, XLK: -1.52, XBI: -0.53, XLF: 1.33 }, 'TECH_ROTATION_OUT', ['TECH_ROTATION_OUT', 'SECTOR_WEAKNESS_TECH']],
    [{ SPY: -1.48, XLE: 1.60, XLK: -4.33, XBI: -1.55, XLF: -0.56 }, 'GEOPOLITICAL', ['GEOPOLITICAL', 'TECH_ROTATION_OUT']],
  ];
  for (const [o, cond, matched] of stored) assert.deepStrictEqual(got(o), { condition: cond, matched }, JSON.stringify(o));
});

run('boundaries are inclusive exactly where the source says', () => {
  assert.strictEqual(got({ SPY: -1, XLE: 1 }).condition, 'GEOPOLITICAL', 'SPY -1 and XLE 1 both count');
  assert.strictEqual(got({ SPY: -0.99, XLE: 1 }).condition, 'CHOPPY');
  assert.strictEqual(got({ XLK: -1.5 }).condition, 'SECTOR_WEAKNESS_TECH', 'XLK -1.5 counts');
  assert.strictEqual(got({ SPY: -1, XLK: -1.6 }).matched.includes('SECTOR_WEAKNESS_TECH'), false, 'sector weakness needs SPY > -1, so -1 excludes it');
  assert.strictEqual(got({ SPY: -2, XLE: -0.1, XLK: -0.1, XBI: -0.1, XLF: 0.1 }).condition, 'RISK_OFF', 'three of four sectors negative is enough');
  assert.notStrictEqual(got({ SPY: -2, XLE: -0.1, XLK: -0.1, XBI: 0.1, XLF: 0.1 }).condition, 'RISK_OFF', 'two is not');
});

run("the replay's threshold list is exactly the rule's comparisons (so the input-precision test covers every edge)", async () => {
  const { RULE_EDGES } = await import('../scripts/replay-macro-firing.mjs');
  const fromSrc = new Set([...src.matchAll(/\b(spy|xle|xlk|xbi|xlf) (<=|>=|>|<) (-?[\d.]+)/g)].map(x => `${x[1].toUpperCase()} ${x[2]} ${Number(x[3])}`));
  const fromList = new Set(RULE_EDGES.map(([, s, op, v]) => `${s} ${op} ${v}`));
  assert.deepStrictEqual([...fromList].sort(), [...fromSrc].sort());
});
