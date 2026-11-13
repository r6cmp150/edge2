// tests/macro-sign-test.test.js -- 2026-11-04. The primary pre-committed macro test
// (phase-10 spec), held before any data exists. Both directions: it passes a table
// that is right, and doesn't pass one that is wrong or says nothing. A test that
// can't fail would certify any table; one that can't pass would waste the wait.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const lib = () => import('../scripts/lib/macro-sign-test.mjs');
const TABLE = { RISK_OFF: { OTHER: -20 }, BROAD_RALLY: { OTHER: 10 }, CHOPPY: { OTHER: 0 } };
const obs = (d, t, o = {}) => ({ trading_date: d, fetched_at: `${d}T${t}Z`, pattern_condition: 'CHOPPY', pattern_incomplete: false, groq_condition: 'RISK_OFF', ...o });
const sig = (d, t, ret, o = {}) => ({ signal_date: d, engine_source: 'EDGE', tier: 'SHOWN', first_shown_at: `${d}T${t}Z`, ret_close: ret, ...o });
// Repeatable noise, so no assertion rests on a lucky draw.
function noise(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; }; }
// Irregular on purpose. Signs repeating exactly every BLOCK_DAYS days can't be told from
// their own shuffles (every block looks alike, so one shuffle in three lines up again and
// p can't fall below about 0.33). Real labels won't be that regular; these aren't either.
const irregular = (n, seed, a = 1, b = -1, share = 1 / 3) => { const u = noise(seed); return Array.from({ length: n }, () => (u() + 0.5 < share ? a : b)); };
const daysOf = (signs, outcome) => signs.map((sign, i) => ({ date: `d${i}`, sign, outcome: outcome(sign, i) }));

run('the predicted sign is the OTHER column\'s; a label the table lacks is null, never a guess', async () => {
  const { predictedSign } = await lib();
  assert.strictEqual(predictedSign('RISK_OFF', TABLE), -1);
  assert.strictEqual(predictedSign('BROAD_RALLY', TABLE), 1);
  assert.strictEqual(predictedSign('CHOPPY', TABLE), 0);
  assert.strictEqual(predictedSign('NEW_THING', TABLE), null);
});

run('the label is the same rule as the app\'s, on every fixture', async () => {
  const { firstLabel } = await lib();
  const app = readSource('app.js');
  const grab = n => { const i = app.search(new RegExp(`^function ${n}\\(`, 'm')); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
  const c = {};
  vm.createContext(c);
  vm.runInContext(grab('macroRuleStance') + grab('macroGroqDayLabel') + ';globalThis.f = macroGroqDayLabel;', c);
  const d = '2026-12-01';
  for (const rows of [
    [obs(d, '15:00:00', { groq_condition: 'BROAD_RALLY' }), obs(d, '14:00:00')],
    [obs(d, '13:00:00', { pattern_condition: null, pattern_incomplete: true, groq_condition: 'BROAD_RALLY' }), obs(d, '14:00:00')],
    [obs(d, '13:00:00', { pattern_condition: null, pattern_incomplete: true }),],
    [obs(d, '14:00:00', { groq_condition: null }), obs(d, '15:00:00', { groq_condition: 'CHOPPY' })],
  ]) {
    const mine = firstLabel(rows);
    assert.strictEqual(mine ? mine.condition : null, c.f(rows.map(r => ({ pattern_matched: [], ...r }))));
  }
});

run('look-ahead: a signal shown before the label is not in the outcome', async () => {
  const { buildDays } = await lib();
  const d = '2026-12-01';
  const { days, dropped } = buildDays([obs(d, '15:00:00')], [sig(d, '14:59:59', 0.5), sig(d, '15:00:00', 0.1), sig(d, '16:00:00', 0.3)], TABLE);
  assert.strictEqual(days.length, 1);
  assert.strictEqual(days[0].signals, 2, 'the one before the label is out; one at the label instant is in');
  assert.ok(Math.abs(days[0].outcome - 20) < 1e-9, 'in points: ' + days[0].outcome);
  assert.strictEqual(days[0].sign, -1);
  assert.strictEqual(dropped.length, 0);
  const all = buildDays([obs(d, '15:00:00')], [sig(d, '14:00:00', 0.5)], TABLE);
  assert.strictEqual(all.days.length, 0);
  assert.ok(/first shown before the label/.test(all.dropped[0].reason), 'dropped, and said why');
});

run('only the logger\'s shown signals with a real close return count', async () => {
  const { buildDays } = await lib();
  const d = '2026-12-01';
  const { days } = buildDays([obs(d, '15:00:00')], [
    sig(d, '16:00:00', 9, { tier: 'BELOW_THRESHOLD' }), sig(d, '16:00:00', 9, { engine_source: 'WARRIOR' }),
    sig(d, '16:00:00', 9, { ret_close_split_in_window: true }), sig(d, '16:00:00', null), sig(d, '16:00:00', 0.2),
  ], TABLE);
  assert.strictEqual(days[0].signals, 1);
  assert.strictEqual(days[0].outcome, 20);
  const none = buildDays([obs(d, '15:00:00', { pattern_condition: null, pattern_incomplete: true })], [sig(d, '16:00:00', 1)], TABLE);
  assert.ok(/no Groq answer given the moves/.test(none.dropped[0].reason), 'headlines alone labels nothing');
  const unknown = buildDays([obs(d, '15:00:00', { groq_condition: 'NEW_THING' })], [sig(d, '16:00:00', 1)], TABLE);
  assert.ok(/not in the table/.test(unknown.dropped[0].reason));
});

run('the bar needs the sign to vary, not every sign to appear', async () => {
  const { barState, signTest } = await lib();
  const of = (p, m, z) => [...Array(p).fill(1), ...Array(m).fill(-1), ...Array(z).fill(0)].map((sign, i) => ({ date: `d${i}`, sign, outcome: i % 3 }));
  assert.strictEqual(barState(of(5, 14, 0)).met, false, '19 days');
  assert.strictEqual(barState(of(4, 16, 0)).met, false, '4 away from the common sign');
  assert.strictEqual(barState(of(5, 15, 0)).met, true);
  assert.strictEqual(barState(of(0, 6, 14)).met, true, 'the rule-like split, no + days at all, can still run');
  assert.strictEqual(barState(of(3, 2, 15)).met, true, '5 away, spread over two signs');
  assert.strictEqual(barState(of(0, 0, 30)).met, false, 'every day CHOPPY: nothing to correlate');
  assert.deepStrictEqual(barState(of(0, 6, 14)).signsSupported, ['-'], 'a pass could not speak for + days');
  assert.deepStrictEqual(barState(of(4, 16, 0)).signsSupported, ['-']);
  assert.deepStrictEqual(barState(of(5, 15, 0)).signsSupported, ['+', '-']);
  assert.strictEqual(signTest(of(5, 14, 0)).state, 'NOT_ENOUGH_DAYS', 'below the bar there is no result, not a weak one');
});

run('it passes a table that is right, and not one pointing the wrong way', async () => {
  const { signTest } = await lib();
  const n = noise(7);
  const signs = irregular(30, 21);
  const right = signTest(daysOf(signs, s => s * 1 + n()));
  assert.ok(right.pass && right.r > 0.5 && right.state === 'RESULT', JSON.stringify(right));
  const wrong = signTest(daysOf(signs, s => -s * 1 + n()));
  assert.ok(!wrong.pass && wrong.p > 0.9 && wrong.r < 0, 'one-sided: strong the wrong way is a fail, not a pass ' + JSON.stringify(wrong));
});

run('on noise it passes about as often as alpha says (the control), and a seed repeats', async () => {
  const { signTest, ALPHA } = await lib();
  const worlds = 400;
  let passed = 0;
  for (let w = 0; w < worlds; w++) {
    const n = noise(1000 + w);
    const signs = Array.from({ length: 25 }, (_, i) => (i % 4 === 0 ? 1 : i % 4 === 1 ? 0 : -1));
    if (signTest(daysOf(signs, () => n()), { shuffles: 500, seed: w + 1 }).pass) passed++;
  }
  const rate = passed / worlds;
  assert.ok(rate > ALPHA / 2 && rate < ALPHA * 2, `false positive rate ${rate}`);
  const n = noise(3);
  const days = daysOf(Array.from({ length: 25 }, (_, i) => (i % 2 ? 1 : -1)), () => n());
  assert.strictEqual(signTest(days, { shuffles: 300, seed: 5 }).p, signTest(days, { shuffles: 300, seed: 5 }).p);
});

run('a miss reads as pre-registered: nothing about information, smaller effects unmeasured', async () => {
  const { signTest, MISS_READING } = await lib();
  const n = noise(11);
  const miss = signTest(daysOf(irregular(25, 22), s => -s + n() * 0.1));
  assert.strictEqual(miss.pass, false);
  assert.strictEqual(miss.earnsReview, false);
  assert.strictEqual(miss.reading, MISS_READING);
  assert.ok(/about 2 points or larger/.test(MISS_READING) && /UNMEASURED/.test(MISS_READING) && /does not mean the condition carries no information/.test(MISS_READING));
  const spec = readSource('docs/phase-10-entry-gate-spec.md');
  assert.ok(spec.includes('no effect of about 2 points or larger was detected; smaller effects remain UNMEASURED'), 'the spec states it in the same words');
  assert.ok(spec.includes('cannot support\n    applying `MACRO_ADJUSTMENTS` as written'), 'and what the test cannot support');
});

run('a pass below the minimum effect earns nothing; at or above it, it earns a review, for the signs seen', async () => {
  const { signTest, MIN_EFFECT_POINTS } = await lib();
  const n = noise(5);
  const signs = irregular(60, 23);
  const small = signTest(daysOf(signs, s => s * 0.2 + n() * 0.05));
  assert.ok(small.pass && small.gap < MIN_EFFECT_POINTS && !small.earnsReview && /under the 1-point minimum/.test(small.reading), JSON.stringify(small));
  const big = signTest(daysOf(signs, s => s * 1 + n() * 0.05));
  assert.ok(big.pass && big.gap >= MIN_EFFECT_POINTS && big.earnsReview && Math.abs(big.gap - 2) < 0.1, JSON.stringify(big));
  assert.ok(/Speaks only for: \+ and -/.test(big.reading) && /not from the table/.test(big.reading), big.reading);
  // No + days at all: a pass may speak for the negative conditions only.
  const negative = signTest(daysOf(irregular(30, 24, -1, 0), s => s * 2 + n() * 0.05));
  assert.ok(negative.earnsReview && /Speaks only for: -\./.test(negative.reading), negative.reading);
  // Too few on the other side: a gap can't be measured, so nothing is earned.
  const lopsided = signTest(daysOf(Array.from({ length: 25 }, (_, i) => ([2, 9, 17].includes(i) ? 1 : [5, 21].includes(i) ? 0 : -1)), s => s * 2 + n() * 0.05));
  assert.ok(lopsided.pass && lopsided.gap === null && !lopsided.earnsReview && /not measurable/.test(lopsided.reading), JSON.stringify(lopsided));
});

run('block shuffle: the same signs, runs kept, and no false-positive inflation where day shuffling has it', async () => {
  const { shuffleBlocks, signTest } = await lib();
  const rand = (() => { let i = 0; const v = [0.37, 0.11, 0.83, 0.59, 0.27, 0.71, 0.93, 0.05]; return () => v[i++ % v.length]; })();
  const signs = Array.from({ length: 25 }, (_, i) => (i < 9 ? 1 : i < 16 ? 0 : -1));
  const out = shuffleBlocks(signs, 3, rand);
  assert.deepStrictEqual(out.slice().sort(), signs.slice().sort(), 'a shuffle only moves signs');
  assert.notDeepStrictEqual(out, signs, 'and it does move them');
  const changes = a => a.slice(1).filter((s, i) => s !== a[i]).length;
  assert.ok(changes(out) <= 2 * Math.ceil(25 / 3), 'whole blocks move: at most one or two changes per block edge');
  // Long runs in the signs and the outcomes, no relation between them.
  const worlds = 300;
  let passed = 0;
  for (let w = 0; w < worlds; w++) {
    const n = noise(4000 + w), runs = noise(9000 + w);
    let sign = 1, level = 0;
    const days = Array.from({ length: 25 }, (_, i) => { if (runs() > 0.25) sign = -sign; level = 0.8 * level + n(); return { date: `d${i}`, sign, outcome: level }; });
    if (signTest(days, { shuffles: 300, seed: w + 1 }).pass) passed++;
  }
  assert.ok(passed / worlds < 0.14, `false positive rate ${passed / worlds} with strong runs in both`);
});

run('THE UNIT: ret_close is a fraction, and 1 point of the minimum effect is 1 percentage point', async () => {
  const { execFileSync } = require('child_process');
  const { REPO_ROOT } = require('./_lib');
  const { retToPoints, buildDays, signTest, MIN_EFFECT_POINTS } = await lib();
  // The writer: (price - reference) / reference, with no 100.
  const writer = readSource('scripts/fill-outcomes.mjs');
  const i = writer.indexOf('function ret(basePrice, targetPrice) {');
  const fn = writer.slice(i, writer.indexOf('\n  }\n', i));
  assert.ok(i >= 0 && /\(targetPrice - basePrice\) \/ basePrice/.test(fn) && !/100/.test(fn), 'fill-outcomes ret(): ' + fn);
  // Real rows at a pin: a fraction applied to the reference price lands on a whole cent.
  // In percent these moves would be sub-cent, and the largest move in the table 0.16%.
  const rows = JSON.parse(execFileSync('git', ['show', '8535a85:data/backups/signal_log.json'], { cwd: REPO_ROOT, maxBuffer: 4e9, encoding: 'utf8' }));
  const edge = rows.filter(s => s.engine_source === 'EDGE' && s.ret_close != null);
  for (const [symbol, date, cents] of [['EMAT', '2026-10-28', 168], ['AVD', '2026-10-16', 106], ['CCOI', '2026-10-30', 674]]) {
    const r = edge.find(s => s.symbol === symbol && s.signal_date === date);
    assert.ok(r, symbol);
    assert.ok(Math.abs(100 * r.reference_price * (1 + r.ret_close) - cents) < 1e-6, `${symbol}: ${r.reference_price} * (1 + ${r.ret_close}) is not ${cents} cents`);
  }
  const abs = edge.map(s => Math.abs(s.ret_close)).sort((x, y) => x - y);
  const median = abs[Math.floor(abs.length / 2)];
  assert.ok(median > 0.002 && median < 0.03, `median |ret_close| ${median}: a typical move of 0.2-3% as a fraction`);
  // So: a 1-point gap is ret_close differing by 0.01, and only that clears the minimum.
  assert.strictEqual(retToPoints(0.01), 1);
  assert.strictEqual(MIN_EFFECT_POINTS, 1);
  const d = '2026-12-01';
  assert.ok(Math.abs(buildDays([obs(d, '15:00:00')], [sig(d, '16:00:00', 0.012)], TABLE).days[0].outcome - 1.2) < 1e-9, '0.012 is 1.2 points');
  const n = noise(31), signs = irregular(60, 32);
  const justUnder = signTest(daysOf(signs, s => retToPoints(s * 0.0049) + n() * 0.01));
  assert.ok(justUnder.pass && justUnder.gap < 1 && !justUnder.earnsReview, 'ret_close 0.0098 apart is 0.98 points, under the minimum: ' + JSON.stringify(justUnder));
  const justOver = signTest(daysOf(signs, s => retToPoints(s * 0.0051) + n() * 0.01));
  assert.ok(justOver.pass && justOver.gap >= 1 && justOver.earnsReview, 'ret_close 0.0102 apart is 1.02 points: ' + JSON.stringify(justOver));
  // The planning table uses the same conversion, so its gaps are these points.
  const h = readSource('scripts/macro-sign-horizon.mjs');
  assert.ok(/push\(retToPoints\(s\.ret_close\)\)/.test(h) && !/100 \* s\.ret_close/.test(h), 'the power table is in the same units');
  assert.ok(!/100 \* /.test(readSource('scripts/lib/macro-sign-test.mjs').replace('export const retToPoints = ret => 100 * ret;', '')), 'one conversion, not two');
});

run('blocked p decides; the day-shuffled p is reported and never read', async () => {
  const { signTest } = await lib();
  const n = noise(41), signs = irregular(30, 42);
  const r = signTest(daysOf(signs, s => s + n()));
  assert.ok(r.p > 0 && r.supportingDayShuffledP > 0 && r.blockDays === 3, JSON.stringify(r));
  const src = readSource('scripts/lib/macro-sign-test.mjs');
  const after = src.slice(src.indexOf('const supportingDayShuffledP ='));
  assert.ok(!/pass[^\n]*supportingDayShuffledP|supportingDayShuffledP[^\n,]*(<|>|\?)/.test(after), 'nothing decides on it');
  // Pass follows the blocked p where the two disagree: periodic signs, strong effect.
  const periodic = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 1 : -1));
  const p = signTest(daysOf(periodic, s => s + n() * 0.1));
  assert.ok(p.supportingDayShuffledP < 0.05 && p.p > 0.05 && p.pass === false, 'the blocked p decided: ' + JSON.stringify(p));
});

run('the blind spot is said in the result, not left to read as "nothing there"', async () => {
  const { signTest, signAutocorrelation } = await lib();
  const n = noise(51);
  const periodic = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 1 : -1));
  assert.ok(Math.abs(signAutocorrelation(periodic)[2]) > 0.5, 'period 3 shows at lag 3');
  assert.ok(Math.abs(signAutocorrelation(periodic)[0]) < Math.abs(signAutocorrelation(periodic)[2]), 'and less at lag 1: same-as-yesterday would not see it');
  const blind = signTest(daysOf(periodic, s => s + n() * 0.1));
  assert.ok(blind.blindSpot && /CAUTION: the signs show structure at lag 3/.test(blind.reading), blind.reading);
  // Long runs: strong at lag 1, flat at lag 3. Not the blind spot, so not flagged.
  const longRuns = Array.from({ length: 36 }, (_, i) => (i % 12 < 6 ? 1 : -1));
  const ac = signAutocorrelation(longRuns);
  assert.ok(Math.abs(ac[0]) > 0.5 && Math.abs(ac[2]) < 0.2, 'the fixture: ' + ac);
  assert.strictEqual(signTest(daysOf(longRuns, s => s + n() * 0.1)).blindSpot, false, 'lag 3 is what is checked');
  const fine = signTest(daysOf(irregular(30, 43), s => s + n() * 0.1));
  assert.ok(!fine.blindSpot && !/CAUTION/.test(fine.reading), fine.reading);
});

run('where a constant and the spec have to agree, they do', async () => {
  const { MIN_DAYS, MIN_DAYS_AWAY_FROM_COMMON_SIGN, MIN_DAYS_TO_SUPPORT_A_SIGN, BLOCK_DAYS, MIN_EFFECT_POINTS, ALPHA, SHUFFLES, MISS_READING } = await lib();
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  const say = s => assert.ok(spec.includes(s), 'the spec should say: ' + s);
  say(`at least ${MIN_DAYS} trading days, at least ${MIN_DAYS_AWAY_FROM_COMMON_SIGN} of them away from the most common predicted sign`);
  say(`BLOCKS OF ${BLOCK_DAYS} CONSECUTIVE DAYS`);
  say(`${SHUFFLES.toLocaleString('en-US')} shuffles, p < ${ALPHA}`);
  say(`MINIMUM EFFECT WORTH ACTING ON: ${MIN_EFFECT_POINTS} PERCENTAGE POINT`);
  say(`at least ${MIN_EFFECT_POINTS} percentage point`);
  say(`signs seen on at least ${MIN_DAYS_TO_SUPPORT_A_SIGN} days`);
  say('`MACRO_ADJUSTMENTS` IS DEAD AS A SPECIFICATION');
  say('Nothing in it survives as a number we apply');
  say(MISS_READING.replace(/^No effect/, 'no effect').replace(/ This does not mean.*$/, ''));
});

run('the report\'s bar is the test\'s bar', async () => {
  const { MIN_DAYS, MIN_DAYS_AWAY_FROM_COMMON_SIGN, ALPHA, SHUFFLES, BLOCK_DAYS, MIN_EFFECT_POINTS } = await lib();
  const app = readSource('app.js');
  assert.strictEqual(Number(app.match(/^const MACRO_TEST_MIN_DAYS = (\d+);$/m)[1]), MIN_DAYS);
  assert.strictEqual(Number(app.match(/^const MACRO_TEST_MIN_AWAY_DAYS = (\d+);$/m)[1]), MIN_DAYS_AWAY_FROM_COMMON_SIGN);
  assert.strictEqual(ALPHA, 0.05);
  assert.strictEqual(SHUFFLES, 10000);
  assert.strictEqual(BLOCK_DAYS, 3);
  assert.strictEqual(MIN_EFFECT_POINTS, 1);
});
