// tests/sell-fill-time.test.js — 2026-11-05, db/038. The sell form takes the fill, as the buy
// form does, and it goes in its own column: sell_time keeps meaning "recorded at", so reading one
// as the other is impossible rather than guarded.
'use strict';
const assert = require('assert');
const { readSource, run, evalModule } = require('./_lib');

global.ptWallClockToInstant = (d, h, m) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-07:00`);
evalModule(readSource('core/orders.js'), { expose: ['readSaleFill'] });
const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const atNine = fn => () => { const n = Date.now; Date.now = () => Date.parse('2026-10-08T16:00:00Z'); try { fn(); } finally { Date.now = n; } };

run('readSaleFill: the entered time; missing, future, or before the buy filled is refused', atNine(() => {
  const ok = global.readSaleFill('2026-10-08', '07:31', '2026-10-07T14:00:00Z');
  assert.strictEqual(ok.filledAt, '2026-10-08T14:31:00.000Z');
  assert.strictEqual(ok.at, Date.parse('2026-10-08T14:31:00Z'));
  for (const [d, t] of [['2026-10-08', ''], ['', '07:31'], ['2026-10-08', '7:31'], ['2026-10-08', null]])
    assert.match(global.readSaleFill(d, t, null).error, /or tick "Time not known"/, `${d} ${t}`);
  assert.match(global.readSaleFill('2026-10-08', '09:10', null).error, /in the future/);
  assert.ok(global.readSaleFill('2026-10-08', '09:00', null).filledAt, 'the minute it is now is fine');
  assert.match(global.readSaleFill('2026-10-08', '07:00', '2026-10-08T14:30:00Z').error, /before the buy filled/);
  assert.ok(global.readSaleFill('2026-10-08', '07:30', '2026-10-08T14:30:00Z').filledAt, 'the same minute as the buy is fine');
  assert.ok(global.readSaleFill('2026-10-08', '07:00', null).filledAt, 'a position from before db/027 has no fill to compare');
}));

run('three states: entered, the default accepted, not known', atNine(() => {
  assert.strictEqual(global.readSaleFill('2026-10-08', '07:31', null, { defaultTime: '09:00' }).source, 'entered');
  assert.strictEqual(global.readSaleFill('2026-10-08', '09:00', null, { defaultTime: '09:00' }).source, 'default');
  assert.strictEqual(global.readSaleFill('2026-10-08', '07:31', null).source, 'entered', 'no default to compare: it was typed');
  const unknown = global.readSaleFill('2026-10-08', '', null, { notKnown: true });
  assert.strictEqual(unknown.filledAt, null, 'null, never a guess');
  assert.strictEqual(unknown.at, null);
  assert.strictEqual(unknown.source, 'not_known');
  assert.strictEqual(unknown.error, undefined, 'and it is never blocked');
  assert.strictEqual(global.readSaleFill('2026-10-08', '09:10', null, { notKnown: true }).filledAt, null, 'not known wins over a time left in the box');
}));

run('the form asks for it, and a date other than today clears the time', () => {
  const modal = grab('openMarkSoldModal');
  assert.ok(/<label class="form-label">Fill time \(PT\)<\/label>\s*<input id="sold-time" class="form-input" type="time" value="\$\{hhmm\}" data-default="\$\{hhmm\}">/.test(modal), 'labelled as the buy form labels it');
  assert.ok(modal.includes("if (this.value !== '${today}') document.getElementById('sold-time').value = ''"), 'changing the date clears the time');
  assert.ok(/id="sold-time-unknown"[^>]*type="checkbox"[^>]*> Time not known/.test(modal), 'an explicit way to say not known');
  assert.ok(modal.includes("t.value = this.checked ? '' : t.dataset.default"), 'ticking it clears the time on screen: a time that will not be stored must not show');
});

run('the fill goes in its own column; sell_time stays the clock at recording', () => {
  const confirm = grab('confirmMarkSold');
  assert.ok(confirm.includes("readSaleFill(saleDate, soldTimeEl.value, pos.filledAt, { notKnown: document.getElementById('sold-time-unknown').checked, defaultTime: soldTimeEl.dataset.default })"), 'reads the form');
  assert.ok(/if \(saleFill\.error\) \{ showAlert\(saleFill\.error\); return; \}/.test(confirm), 'a refusal stops the sale');
  assert.ok(confirm.includes('sellFilledAt: saleFill.filledAt'), 'stored');
  assert.ok(confirm.includes('sellFilledAtSource: saleFill.source'), 'with how it was decided');
  assert.ok(/sellTime: \(\(\) => \{\s*const pt = getPT\(\);/.test(confirm), 'sell_time is still the clock');
  const write = grab('writeTradeToSupabase');
  assert.ok(write.includes('sell_filled_at: record.sellFilledAt ?? null'), 'written');
  assert.ok(write.includes('sell_filled_at_source: record.sellFilledAtSource ?? null'), 'written');
  const start = confirm.indexOf('readSaleFill('), firstWrite = confirm.indexOf('deletePositionFromSupabase');
  assert.ok(firstWrite < 0 || start < firstWrite, 'refused before anything is written');
  assert.ok(confirm.includes('computeSaleVerdictFields(pos, saleDate, saleFill.at)'), 'the last scan is placed against the fill');
  assert.ok(grab('signalBeforeSale').includes('sig.scannedAt < saleAt'), 'by its own instant');
});

run('db/038 adds both columns, keeps them consistent, and corrects sell_time\'s comment', () => {
  const sql = readSource('db/038_macro_observe_only_and_settings.sql');
  assert.ok(sql.includes('add column sell_filled_at timestamptz'));
  assert.ok(sql.includes("add column sell_filled_at_source text check (sell_filled_at_source is null or sell_filled_at_source in ('entered', 'default', 'not_known'))"));
  // revision b: coalesce, so a fill time with no source is refused rather than NULL (the harness found it)
  assert.ok(/check \(\s*\(sell_filled_at_source is null and sell_filled_at is null\)\s*or \(coalesce\(sell_filled_at_source, ''\) = 'not_known' and sell_filled_at is null\)\s*or \(coalesce\(sell_filled_at_source, ''\) in \('entered', 'default'\) and sell_filled_at is not null\)\)/.test(sql), 'consistent, and definite');
  assert.ok(/comment on column trades_v2\.sell_time is 'When the sale was RECORDED/.test(sql), 'corrected');
  assert.ok(/has_column_privilege\('anon', 'public\.trades_v2', 'sell_filled_at', 'INSERT'\)/.test(sql), 'the guard');
  assert.ok(/has_column_privilege\('anon', 'public\.trades_v2', 'sell_filled_at_source', 'INSERT'\)/.test(sql), 'the guard');
  assert.ok(!sql.includes('sell_time_source') && !readSource('app.js').includes('sell_time_source'), 'no leftover');
  assert.ok(/REVISED 2026-11-05/.test(sql), 'earlier copies are void');
});

run('the spec states it', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes("The sell form's fill: `sell_filled_at`, from db/038"));
  assert.ok(spec.includes('`sell_time` is never an input'));
  assert.ok(spec.includes('Yes, with the gap distribution beside the figure'), 'what each state supports');
  assert.ok(spec.includes("a default's own error can't be measured"), 'and the limit on it');
  assert.ok(spec.includes('a cautious upper bound on `default` rows'), 'in those terms');
  assert.ok(spec.includes('selection bias'), 'named');
});
