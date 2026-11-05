// tests/sell-fill-time.test.js — 2026-11-04. sell_time was the moment a sale was
// recorded (it equals created_at to the minute on 286 of 292 rows at b4620bc), under a
// column that says "SELL FILL time". The sell form now takes the fill, as the buy form does.
'use strict';
const assert = require('assert');
const { readSource, run, evalModule, REPO_ROOT } = require('./_lib');

global.ptWallClockToInstant = (d, h, m) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-07:00`);
evalModule(readSource('core/orders.js'), { expose: ['readSaleFill'] });
const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

run('readSaleFill: the entered time; missing, future, or before the buy filled is refused', () => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-08T16:00:00Z'); // 09:00 at -07:00
  try {
    const ok = global.readSaleFill('2026-10-08', '07:31', '2026-10-07T14:00:00Z');
    assert.strictEqual(ok.hhmm, '07:31');
    assert.strictEqual(ok.at, Date.parse('2026-10-08T14:31:00Z'));
    for (const [d, t] of [['2026-10-08', ''], ['', '07:31'], ['2026-10-08', '7:31'], ['2026-10-08', null]])
      assert.match(global.readSaleFill(d, t, null).error, /Enter the time the sale filled \(PT\), or tick "Time not known"/, `${d} ${t}`);
    assert.match(global.readSaleFill('2026-10-08', '09:10', null).error, /in the future/);
    assert.ok(global.readSaleFill('2026-10-08', '09:00', null).hhmm, 'the minute it is now is fine');
    assert.match(global.readSaleFill('2026-10-08', '07:00', '2026-10-08T14:30:00Z').error, /before the buy filled/);
    assert.ok(global.readSaleFill('2026-10-08', '07:30', '2026-10-08T14:30:00Z').hhmm, 'the same minute as the buy is fine');
    assert.ok(global.readSaleFill('2026-10-08', '07:00', null).hhmm, 'a position from before db/027 has no fill to compare');
  } finally { Date.now = realNow; }
});

run('three states: entered, the default accepted, not known', () => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-08T16:00:00Z');
  try {
    assert.strictEqual(global.readSaleFill('2026-10-08', '07:31', null, { defaultTime: '09:00' }).source, 'entered');
    assert.strictEqual(global.readSaleFill('2026-10-08', '09:00', null, { defaultTime: '09:00' }).source, 'default');
    assert.strictEqual(global.readSaleFill('2026-10-08', '07:31', null).source, 'entered', 'no default to compare: it was typed');
    const unknown = global.readSaleFill('2026-10-08', '', null, { notKnown: true });
    assert.strictEqual(unknown.hhmm, null, 'null, never a guess');
    assert.strictEqual(unknown.at, null);
    assert.strictEqual(unknown.source, 'not_known');
    assert.strictEqual(unknown.error, undefined, 'and it is never blocked');
    assert.strictEqual(global.readSaleFill('2026-10-08', '09:10', null, { notKnown: true }).hhmm, null, 'not known wins over a time left in the box');
  } finally { Date.now = realNow; }
});

run('the form asks for it, and a date other than today clears the time rather than keeping today\'s clock', () => {
  const modal = grab('openMarkSoldModal');
  assert.ok(/<label class="form-label">Fill time \(PT\)<\/label>\s*<input id="sold-time" class="form-input" type="time" value="\$\{hhmm\}" data-default="\$\{hhmm\}">/.test(modal), 'labelled as the buy form labels it');
  assert.ok(modal.includes("if (this.value !== '${today}') document.getElementById('sold-time').value = ''"), 'changing the date clears the time');
  assert.ok(modal.includes('data-default="${hhmm}"'), 'the form remembers what it started at');
  assert.ok(/id="sold-time-unknown"[^>]*type="checkbox"[^>]*> Time not known/.test(modal), 'an explicit way to say not known');
});

run('what is stored and judged is the entered fill, never the clock at recording', () => {
  const confirm = grab('confirmMarkSold');
  assert.ok(confirm.includes("readSaleFill(saleDate, soldTimeEl.value, pos.filledAt, { notKnown: document.getElementById('sold-time-unknown').checked, defaultTime: soldTimeEl.dataset.default })"), 'reads the form');
  assert.ok(/if \(saleFill\.error\) \{ showAlert\(saleFill\.error\); return; \}/.test(confirm), 'a refusal stops the sale');
  assert.ok(confirm.includes('sellTime: saleFill.hhmm'), 'stored');
  assert.ok(confirm.includes('sellTimeSource: saleFill.source'), 'with how it was decided');
  assert.ok(confirm.includes('computeUnifiedSaleFields(pos, salePrice, saleDate, saleFill.at)'), 'judged');
  const start = confirm.indexOf('readSaleFill('), firstWrite = confirm.indexOf('deletePositionFromSupabase');
  assert.ok(firstWrite < 0 || start < firstWrite, 'refused before anything is written');
  assert.ok(!/sellTime:\s*\(\(\) =>/.test(confirm), 'the clock read is gone');
  const sale = grab('computeUnifiedSaleFields');
  assert.ok(sale.includes('evaluateExit(pos, { price: salePrice, at: saleAt })'), 'the exit rules get the fill');
  assert.ok(!sale.includes('Date.now()'), 'not the recording moment');
});

run('a row\'s era is read from its stored build, never from a date', async () => {
  const { pathToFileURL } = require('url');
  const path = require('path');
  const { sellTimeEra, SELL_FILL_FROM_APP: from } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/sell-time-era.mjs')).href);
  const row = app => ({ sale_code_version: { app, scoring: 2 } });
  assert.strictEqual(sellTimeEra(row(from)), 'fill', 'the first build');
  assert.strictEqual(sellTimeEra(row('20991231000000')), 'fill', 'a later one');
  assert.strictEqual(sellTimeEra(row('20261103040000')), 'recording_moment', 'an earlier one');
  assert.strictEqual(sellTimeEra({ sale_code_version: null, sell_date: '2099-01-01' }), 'recording_moment', 'before db/028, whatever its date says');
  assert.strictEqual(sellTimeEra({ sale_code_version: { app: '20261103040000' }, sell_date: '2099-01-01' }), 'recording_moment', 'a cached old build, whatever its date says');
  const stamp = readSource('index.html').match(/app\.js\?v=(\d+)/)[1];
  assert.ok(stamp >= from, `this tree's build (${stamp}) writes fill times, so it can't be before ${from}`);
  assert.ok(app.includes('sale_code_version: currentCodeVersion(),'), 'and the sale stamps its build');
});

run('the two eras of sell_time are marked in the spec', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('TWO ERAS OF sell_time'), 'marked');
  assert.ok(spec.includes('sale_code_version.app') && spec.includes('never reconstructed from a date'), 'read from the row');
  assert.ok(spec.includes('sell_time_source'), 'and the source that settles it');
});
