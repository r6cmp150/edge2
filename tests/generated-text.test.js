// tests/generated-text.test.js — 2026-11-02. RULE (phase-10 spec §7.7): any UI
// or schema text that states a threshold, version or count is GENERATED from
// the value, not written beside it. Three false statements sat beside numbers
// (db/027's sell_time comment, the overlay hint, the banner's "score 50+"),
// and the sweep for this item found both scoring legends wrong (Settings:
// volume 0–30, RSI 0–20, "capped 100", labels 80/50/20; the report: RSI <35 =
// 10, "rewards RSI 50-65"). This fails when a value moves and its text doesn't.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const scorer = readSource('core/edge-scoring.js');
function ctx() {
  const c = { console, Math, Date, JSON, Number, String, Array, Object, Infinity, NaN, isFinite, state: { settings: {}, macroContext: null } };
  vm.createContext(c);
  const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
  for (const f of ['core/indicators.js', 'core/market-data.js', 'core/edge-scoring.js']) vm.runInContext(strip(readSource(f)), c);
  const i = app.indexOf('const RAW_SCORE_MAX = '), j = app.indexOf('const MEAN_REV_RSI_MAX = ');
  vm.runInContext(app.slice(i, app.indexOf('\n', j) + 1) + ';Object.assign(globalThis, { RAW_SCORE_MAX, SCORING_LEGEND, LEGEND_NEUTRAL, scoringLegendRows, scoreLabelBands, scoringLegendText, VOL_BUILD_TODAY_MIN, MEAN_REV_BELOW_MA_MIN, MEAN_REV_BELOW_MA_MAX, MEAN_REV_RSI_MAX });', c);
  return c;
}

run('every band boundary the legend states is where the scorer actually changes points', () => {
  const c = ctx();
  let edges = 0;
  for (const comp of c.SCORING_LEGEND) {
    if (comp.discrete) continue;
    const pts = v => c.scoreComponents({ ...c.LEGEND_NEUTRAL, ...comp.input(v) })[comp.field];
    comp.bands.forEach((b, i) => {
      const lo = i ? comp.bands[i - 1].edge : -Infinity;
      assert.ok(b.probe > lo && (b.edge == null || b.probe < b.edge), `${comp.name} ${b.text}: probe outside its band`);
      if (b.edge == null) return;
      const below = pts(b.edge - 1e-6), above = pts(b.edge + 1e-6);
      assert.strictEqual(below, pts(b.probe), `${comp.name}: just below ${b.edge} should score as "${b.text}"`);
      assert.strictEqual(above, pts(comp.bands[i + 1].probe), `${comp.name}: just above ${b.edge} should score as "${comp.bands[i + 1].text}"`);
      assert.notStrictEqual(below, above, `${comp.name}: ${b.edge} is stated as a boundary but nothing changes there`);
      edges++;
    });
  }
  assert.strictEqual(edges, 14, `${edges} boundaries checked (volume 4, momentum 2, RSI 4, MA 1, relative strength 3)`);
});

run('RAW_SCORE_MAX is the sum of each component\'s best band, computed from the scorer', () => {
  const c = ctx();
  const sum = c.scoringLegendRows().reduce((a, r) => a + Math.max(0, r.max), 0);
  assert.strictEqual(c.RAW_SCORE_MAX, sum);
});

run('the label bands come from the version\'s thresholds', () => {
  const c = ctx();
  for (const v of [1, 2]) {
    const t = c.scoreThresholds(v);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(c.scoreLabelBands(v))), [
      { label: 'STRONG BUY', text: `${t.strong}+` }, { label: 'SOFT BUY', text: `${t.soft}–${t.strong - 1}` }, { label: 'WATCH', text: `${t.watch}–${t.soft - 1}` }]);
  }
});

run('the detection thresholds the report states are the literals scoreStock uses', () => {
  const c = ctx();
  const vb = scorer.match(/if \(vols\.length >= 2 && volRatio >= ([\d.]+)\)/);
  const mr = scorer.match(/if \(maPct <= -(\d+) && maPct >= -(\d+) && rsi < (\d+)/);
  assert.ok(vb && mr, 'scoreStock detection lines found');
  assert.strictEqual(c.VOL_BUILD_TODAY_MIN, Number(vb[1]));
  assert.deepStrictEqual([c.MEAN_REV_BELOW_MA_MIN, c.MEAN_REV_BELOW_MA_MAX, c.MEAN_REV_RSI_MAX], [Number(mr[1]), Number(mr[2]), Number(mr[3])]);
});

run('no legend, label, threshold or version is typed into the UI or report text', () => {
  const code = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const typed = [
    /0–30 pts/, /Total \(capped\)/, /80–100/, /50–79/, /20–49/, /<35=10/, /RSI 50-65 with 20/, /score 50\+/, /v1: 116 \/ 73 \/ 29/,
    /Scoring Formula v2 \(/, /ignores market condition adjustments/, /scoring 60\+/, /2000\+ in 8 days/, /'Est\. [0-9]–[0-9] market days'/,
  ].filter(re => re.test(code)).map(String);
  assert.deepStrictEqual(typed, [], 'typed beside the value');
  // A bucket label never retypes its own value.
  const retyped = [...code.matchAll(/bucket\(byPts\('[A-Za-z]+',\s*-?\d+\),\s*'(Got|Yes|No)[^']*\d/g)].map(m => m[0]);
  assert.deepStrictEqual(retyped, [], 'bucket label retypes its value');
  // The Settings table and the report legend are generated.
  assert.ok(/\$\{scoringLegendRows\(\)\.map\(/.test(code) && /\$\{scoreLabelBands\(\)\.map\(/.test(code) && /\$\{scoringLegendText\(\)\}/.test(code));
});

run('each report RSI bucket names every RSI range that scores its points', () => {
  // The bucket filed scoring-v2 RSI <35 trades under "Got 0 (RSI 65-75)". A bucket
  // is keyed by points, so its label has to name all the ranges that score them.
  const c = ctx();
  const pts = rsi => c.scoreComponents({ ...c.LEGEND_NEUTRAL, rsi }).rsiPts;
  const label = p => {
    const m = app.match(new RegExp("byPts\\('rsiPts', " + p + "\\),\\s*`Got \\$\\{legendPts\\(" + p + "\\)\\} \\(([^)]*)\\)"));
    assert.ok(m, 'no RSI bucket for ' + p + ' points');
    return m[1];
  };
  for (const [rsi, text] of [[30, '<35'], [45, '35-55'], [60, '55-65'], [70, '65-75'], [80, '75+']]) {
    assert.ok(label(pts(rsi)).includes(text), `RSI ${rsi} scores ${pts(rsi)}, and that bucket's label is "${label(pts(rsi))}"`);
  }
});

run('the generated legend says what the scorer does today (v2: RSI under 35 scores 0, the volume range is −10..+20)', () => {
  const c = ctx();
  const t = c.scoringLegendText();
  assert.ok(/RSI \(14-day\):\s+−10 to \+20 pts \(under 35 0, 35–55 \+15, 55–65 \+20, 65–75 0, over 75 −10\)/.test(t), t);
  assert.ok(/Volume vs 10-day avg:\s+−10 to \+20 pts/.test(t), t);
});
