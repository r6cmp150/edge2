// tests/field-provenance.test.js -- 2026-11-22. docs/field-provenance.md is a named list in three states and nothing
// else. This holds its shape: every table row has exactly one of the three states; the entries the reviewer named are
// present; and the code each "can be fabricated" row cites for a default still reads that way (so a fix shows up here
// as a row to update, and the list cannot quietly go stale in the safe-looking direction).
'use strict';
const assert = require('assert');
const { run, readSource } = require('./_lib');

const doc = readSource('docs/field-provenance.md');
const STATES = ['provenanced', 'can be fabricated', 'not established'];
const rows = doc.split('\n').filter(l => /^\| `/.test(l) || /^\| the `/.test(l));

run('every row is in exactly one of the three states', () => {
  assert.ok(rows.length >= 40, `rows: ${rows.length}`);
  for (const r of rows) {
    const state = r.split('|')[2].trim();
    assert.ok(STATES.includes(state), `not one of the three: ${r.slice(0, 80)}`);
  }
});

run('the entries the reviewer named are on the list', () => {
  for (const s of ['`targetDriftPct` is 0', 'IPST, 2026-11-05', 'NOT ESTABLISHED: neither snapshot has `appShowedAtBuy`', 'The pre-fill limit', 'unrecorded before 2026-11-10', 'The scan is the decision (a product observation, not a defect)', 'The stale daily bar, three states'])
    assert.ok(doc.includes(s), s);
});

run('each cited default still reads that way in the code (a fix must update its row)', () => {
  const app = readSource('app.js');
  // 2026-11-23 (scoring version 3): the latest trade first, null when none; the rows that cited the stale-first order
  // were rewritten in the same change
  assert.ok(readSource('core/market-data.js').includes("const price = trade ? { value: trade.p, source: 'latestTrade', asOf: trade.t }"), 'getLivePrice: the latest trade first');
  for (const s of ["target:   sig?.target || price * 1.10,", "stop:     sig?.stop   || price * 0.92,", "duration: sig?.duration || '3-DAY',", 'const currentPrice = getLivePrice(snap) || p.buyPrice;', 'const entryVsSignalPricePct = (sig && sig.price) ? ((price - sig.price) / sig.price) * 100 : null;'])
    assert.ok(app.includes(s), s);
  // version 3: null with a reason, never 1 (volume_ratio_at_buy moved to provenanced with this line); the modal's
  // display-only fallback still builds a 1, cited in that row
  assert.ok(readSource('core/edge-scoring.js').includes('const volRatio = volume == null || !(avgVol10 > 0) ? null : volume / avgVol10;'));
  assert.ok(app.includes('const volRatio = avgVol10 > 0 ? ((sorted[sorted.length-1]?.v||0) / avgVol10) : 1;'), 'the modal fallback, cited in the volume_ratio_at_buy row');
  assert.ok(readSource('scripts/log-signals-edge.mjs').includes('reference_price: global.getLivePrice(snapshots[r.ticker]) ?? null,'));
});
