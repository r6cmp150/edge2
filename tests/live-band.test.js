// tests/live-band.test.js — 2026-11-12. LIVE mode visible all the time (ruled by the reviewer): when the toggle is
// LIVE, a band under the header on every screen; PAPER and unset look as the app always did. A recording light, not
// a warning; it shows the mode this phone last read, and every Add re-reads before it records.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const fn = name => { const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(app); assert.ok(m, name); return app.slice(m.index, app.indexOf('\n}\n', m.index) + 2); };

// A fake DOM with just the header and whatever is inserted after it.
function dom({ header = true } = {}) {
  const els = new Map();
  const make = tag => {
    const attrs = {};
    const e = { tag, id: '', style: {}, textContent: '', setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k] ?? null, attrs,
      remove: () => { if (els.get(e.id) === e) els.delete(e.id); e.removed = true; },
      // every insertion is counted: a map keyed by id would hide a second band behind the first
      insertAdjacentElement: (where, x) => { e.inserted = { where, x }; (e.insertions ||= []).push(x); els.set(x.id, x); } };
    Object.defineProperty(e.style, 'cssText', { set(v) { e.css = v; }, get() { return e.css; } });
    return e;
  };
  const h = header ? Object.assign(make('header'), { id: 'app-header' }) : null;
  if (h) els.set('app-header', h);
  global.document = { getElementById: id => els.get(id) || null, createElement: tag => make(tag) };
  return { els, header: h };
}
// eslint-disable-next-line no-eval
eval(fn('renderLiveBand') + '\nglobal.__band = renderLiveBand;');

(async () => {
await run('LIVE: a band directly under the header, on every screen, saying so in words; a tap opens Settings', () => {
  const d = dom();
  global.state = { settings: { executionMode: 'live' } };
  global.__band();
  const b = d.els.get('live-band');
  assert.ok(b, 'the band exists');
  assert.deepStrictEqual([d.header.inserted.where, d.header.inserted.x], ['afterend', b], 'directly after the header, above every tab');
  assert.strictEqual(b.textContent, '● LIVE · adds recorded as placed at your broker');
  assert.strictEqual(b.attrs.role, 'status');
  assert.strictEqual(b.attrs.onclick, "switchTab('settings')");
  assert.ok(/background:#7a1020/.test(b.css) && /color:#fff/.test(b.css), 'unmistakable: a solid band');
  global.__band();
  global.__band(); global.__band();
  assert.strictEqual(d.header.insertions.length, 1, 'redrawn on every tick: inserted once, never a second band');
});

await run('PAPER and unset: no band at all, the app as it was; switching from LIVE removes it', () => {
  for (const mode of ['paper', null, undefined, 'not_known', 'LIVE']) {
    const d = dom();
    global.state = { settings: { executionMode: mode } };
    global.__band();
    assert.strictEqual(d.els.get('live-band'), undefined, String(mode));
  }
  const d = dom();
  global.state = { settings: { executionMode: 'live' } };
  global.__band();
  const b = d.els.get('live-band');
  global.state.settings.executionMode = 'paper';
  global.__band();
  assert.ok(b.removed && !d.els.get('live-band'), 'gone the moment the mode is not LIVE');
  global.state = {};
  global.__band();
  assert.ok(!d.els.get('live-band'), 'no settings yet: no band, no throw');
});

await run('before the app shell exists (PIN, loading): nothing, and no throw', () => {
  dom({ header: false });
  global.state = { settings: { executionMode: 'live' } };
  global.__band();
});

await run('redrawn wherever the mode this phone holds can change, and on every banner update (startup, the clock tick)', () => {
  assert.ok(fn('updateMarketBanner').startsWith('function updateMarketBanner() {\n  renderLiveBand();'), 'every banner update, first');
  assert.ok(fn('confirmAddPortfolio').includes('state.settings.executionModeSetAt = reread.setAt; renderLiveBand(); }'), 'the Add\'s re-read');
  assert.ok(fn('applyModeAnswer').includes('state.settings.executionModeSetAt = r.at;\n    renderLiveBand();'), 'the prompt\'s answer');
  assert.ok(fn('changeExecutionMode').includes('  renderLiveBand();\n  renderSettingsTab();'), 'Settings');
  assert.ok(!/fetch|supabaseClient|readExecutionMode/.test(fn('renderLiveBand')), 'drawing never reads: it shows the mode last read');
});

await run('the Add button keeps naming its mode (the band is in addition, not instead)', () => {
  assert.ok(fn('addButtonLabel').includes("'+ Add as LIVE · placed at broker'") && fn('addButtonLabel').includes("'+ Add as PAPER · not at broker'"));
});
})();
