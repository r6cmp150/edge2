// tests/settings-sources.test.js — 2026-11-02, db/038. Every setting records
// where its value came from: Supabase, this phone, or the built-in default.
// Defaults are inert and the app says when it runs on them; a default nobody
// chose is never written as a stored setting; the four formerly phone-only
// settings are read from the phone only for a value Supabase doesn't hold,
// and their read no longer swallows errors (catch(e) {}).
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, settingLabelsSrc } = require('./_lib');

const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

function store({ row, phoneRaw = null, phoneThrows = false, updateRows = r => [{ id: 3 }] } = {}) {
  const sent = [];
  const c = {
    console, JSON, Date, Math, Object, Array, String, Promise, Error, Number, Set,
    localStorage: { getItem: () => { if (phoneThrows) throw new Error('storage blocked'); return phoneRaw; }, setItem() { throw new Error('nothing may write the phone copy'); } },
    window: { supabase: { createClient: () => ({
      from: () => ({
        select: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: row ?? null, error: null }) }) }) }),
        update: payload => ({ eq: () => ({ select: async () => { sent.push(payload); return { data: updateRows(payload), error: null }; } }) }),
        insert: () => { throw new Error('settings insert'); },
      }),
    }) } },
    state: { settings: {}, settingsSource: {}, settingsProblems: [] },
  };
  vm.createContext(c);
  vm.runInContext(readSource('core/store.js') + '\n;globalThis.__s = { loadSettingsFromSupabase, saveSettingsToSupabase, loadLocalOnlySettings, SETTINGS_COLUMNS };', c);
  return { c, s: c.__s, sent };
}
const ROW = { id: 3, budget: 1500, include_under2: true, show_watch: true, min_volume: 100000, force_pre_market_mode: false,
  disable_macro_overlay: false, risk_per_trade_pct: null, float_threshold_shares: null, max_loss_pct: null, developer_tools: null };

run('the load returns only what Supabase holds: NULL columns stay absent, and disable_macro_overlay is never read back', async () => {
  const { s } = store({ row: ROW });
  const got = await s.loadSettingsFromSupabase();
  // CHANGED 2026-11-12, declared (carve of (c) onto main): the load also returns db/042's execution mode, always, null
  // meaning "never set" (a value, not an absence; tests/execution-mode.test.js holds it). Every other key is as before.
  assert.deepStrictEqual(Object.keys(got).sort(), ['budget', 'executionMode', 'executionModeSetAt', 'forcePreMarketMode', 'includeUnder2', 'minVolume', 'showWatch']);
  assert.strictEqual(got.disableMacroOverlay, undefined, 'macro is pinned by the build, not loaded');
});

run('the phone copy fills only what Supabase lacks, as source phone; an unreadable copy is a problem on the banner, not silence', async () => {
  const h = store({ row: ROW, phoneRaw: JSON.stringify({ maxLossPct: 4, riskPerTradePct: 1.5, junk: 1 }) });
  h.s.loadLocalOnlySettings();
  assert.strictEqual(h.c.state.settings.maxLossPct, 4);
  assert.strictEqual(h.c.state.settingsSource.maxLossPct, 'phone');
  assert.strictEqual(h.c.state.settings.junk, undefined, 'only the four known keys');
  const bad = store({ row: ROW, phoneRaw: '{not json' });
  bad.s.loadLocalOnlySettings();
  assert.ok(/unreadable/.test(bad.c.state.settingsProblems[0] || ''), 'parse failure recorded');
  const blocked = store({ row: ROW, phoneThrows: true });
  blocked.s.loadLocalOnlySettings();
  assert.ok(/couldn't read/.test(blocked.c.state.settingsProblems[0] || ''), 'read failure recorded');
});

run('a save writes real values (supabase, phone, user), NEVER a default, writes macro as pinned, and marks what it wrote as supabase', async () => {
  const { s, sent } = store({ row: ROW });
  await s.loadSettingsFromSupabase();
  const settings = { budget: 1500, includeUnder2: true, showWatch: true, minVolume: 100000, forcePreMarketMode: false, maxLossPct: 4, riskPerTradePct: 2, floatThresholdShares: 1e7, developerTools: false };
  const sources = { budget: 'supabase', includeUnder2: 'supabase', showWatch: 'supabase', minVolume: 'supabase', forcePreMarketMode: 'supabase', maxLossPct: 'phone', riskPerTradePct: 'default', floatThresholdShares: 'default', developerTools: 'user' };
  const written = await s.saveSettingsToSupabase(settings, sources);
  const row = sent[0];
  assert.strictEqual(row.max_loss_pct, 4, 'the phone value goes up');
  assert.strictEqual(row.developer_tools, false, 'a user choice goes up');
  assert.ok(!('risk_per_trade_pct' in row) && !('float_threshold_shares' in row), 'defaults nobody chose are not written');
  assert.strictEqual(row.disable_macro_overlay, true, 'macro pinned off');
  assert.ok(!written.includes('riskPerTradePct'));
  assert.strictEqual(sources.maxLossPct, 'supabase');
  assert.strictEqual(sources.riskPerTradePct, 'default', 'unwritten stays default');
});

run('the banner line: problems, then phone-only (with Save), then defaults (with Save), else nothing', () => {
  const c = { state: {} };
  vm.createContext(c);
  vm.runInContext(settingLabelsSrc() + '\n' + grab('settingsBannerLine') + ';globalThis.f = settingsBannerLine;', c);
  const all = v => Object.fromEntries(['budget', 'includeUnder2', 'showWatch', 'minVolume', 'forcePreMarketMode', 'riskPerTradePct', 'floatThresholdShares', 'maxLossPct', 'developerTools'].map(k => [k, v]));
  c.state.settingsSource = all('supabase'); c.state.settingsProblems = [];
  assert.strictEqual(c.f(), null, 'all saved: no line');
  c.state.settingsSource = { ...all('supabase'), maxLossPct: 'phone', riskPerTradePct: 'default' };
  let l = c.f();
  assert.ok(/1 setting only on this phone/.test(l.title) && /max loss floor/.test(l.detail) && l.button, JSON.stringify(l));
  c.state.settingsSource = { ...all('supabase'), riskPerTradePct: 'default' };
  l = c.f();
  assert.ok(/on built-in defaults/.test(l.title) && /risk per trade/.test(l.detail) && l.button, JSON.stringify(l));
  c.state.settingsProblems = ['the settings stored on this phone are unreadable (x)'];
  l = c.f();
  assert.ok(/could not be read/.test(l.title) && !l.button, JSON.stringify(l));
});

run('an invalid entry is refused and says so: never replaced by a default and called saved', () => {
  const alerts = [];
  const c = { showAlert: m => alerts.push(m), document: { getElementById: () => ({ value: '' }) }, Number, String };
  vm.createContext(c);
  vm.runInContext(grab('readSettingNumber') + ';globalThis.r = readSettingNumber;', c);
  assert.strictEqual(c.r('x', { min: 0, max: 100, label: 'Risk per trade' }), null);
  assert.ok(/Nothing was saved/.test(alerts[0]), alerts[0]);
  c.document.getElementById = () => ({ value: '150' });
  assert.strictEqual(c.r('x', { min: 0, max: 100, label: 'Risk per trade' }), null, 'out of range refused');
  c.document.getElementById = () => ({ value: '1.5' });
  assert.strictEqual(c.r('x', { min: 0, max: 100, label: 'Risk per trade' }), 1.5);
  assert.ok(!/\|\|\s*(2|10000000|DEFAULT_MAX_LOSS_PCT|500)\b/.test(['saveBudget', 'saveRiskPerTrade', 'saveFloatThreshold', 'saveMaxLossPct'].map(grab).join('\n')), 'no `|| default` fallback in a saver');
});

run('every user setting starts as source default (inert), and nothing writes the phone copy any more', () => {
  const ls = app.slice(app.indexOf('state.settings = Object.assign({'), app.indexOf('state.settingsProblems = [];'));
  assert.ok(/state\.settingsSource = Object\.fromEntries\(Object\.keys\(SETTINGS_COLUMNS\)\.map\(k => \[k, 'default'\]\)\)/.test(ls));
  for (const f of ['app.js', 'core/store.js']) assert.ok(!/localStorage\.setItem\('edge_localOnlySettings'|setItem\(PHONE_ONLY_SETTINGS_KEY/.test(readSource(f)), `${f} writes the phone copy`);
  assert.ok(!/function persistLocalOnlySettings/.test(readSource('core/store.js')));
});
