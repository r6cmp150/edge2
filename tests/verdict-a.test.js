// tests/verdict-a.test.js — 2026-11-05. Verdict A: what the card showed, captured, not recomputed. It audits
// the app's output, so it records the app's errors faithfully. Also db/038's revision stamp.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { readSource, run, evalModule } = require('./_lib');

evalModule(readSource('core/orders.js'), { expose: ['capturedDisplay', 'saleDisplayFields'] });
const { capturedDisplay, saleDisplayFields } = global;
const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const capture = capturedDisplay({ label: 'HOLD' }, { rsi: 50 }, '2026-10-08T14:30:00.000Z');
const fill = (source, iso = '2026-10-08T14:31:00.000Z') => ({ source, at: Date.parse(iso), filledAt: iso });

run('it is what the card showed, verbatim, errors included', () => {
  const v = { label: 'SELL SOON', composite: -40, factors: [{ name: 'RSI declining from peak (92 → 92)', points: -30 }] };
  const c = capturedDisplay(v, { rsi: 92, prev_rsi: 92 }, 'x');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.verdict)), v, 'a factor that describes nothing is kept: it is what the app said');
  v.factors[0].points = 99;
  assert.strictEqual(c.verdict.factors[0].points, -30, 'and the stored copy cannot move with the live object');
});

run('the card\'s verdict is the object the banner got, and nothing recomputes it at sale', () => {
  const src = grab('renderPortfolioTab').replace(/\r\n/g, '\n');
  assert.ok(/portBanner = buildUnifiedPortfolioBanner\(unifiedResult, earlierCloseTag\);[^\n]*\n\s*displayedVerdict = unifiedResult;/.test(src), 'EDGE');
  assert.ok(/portBanner = buildRegisteredEngineExitBanner\(exitResult, earlierCloseTag\);[^\n]*\n\s*displayedVerdict = exitResult;/.test(src), 'a registered engine');
  assert.ok(src.includes('state.displayedVerdicts[p.id] = capturedDisplay(displayedVerdict,'));
  for (const k of ['price:', 'rsi:', 'prev_rsi:', 'peak_price:', 'momentum_protection:', 'score:', 'scanned_at:', 'macro_condition:', 'hold_closes:']) assert.ok(src.includes(k), `input ${k}`);
  const confirm = grab('confirmMarkSold');
  assert.ok(confirm.includes('saleDisplayFields(state.displayedVerdicts?.[pos.id], saleDate, ptDateStr(getPT()), saleFill)'), 'the sale reads the capture');
  assert.ok(!/calcUnifiedRecommendation|evaluateExit/.test(confirm), 'and computes no verdict');
  const write = grab('writeTradeToSupabase');
  assert.ok(write.includes('verdict_displayed_at_sale: record.verdictDisplayedAtSale ?? null'));
  assert.ok(write.includes('verdict_display_state: record.verdictDisplayState ?? null'));
  assert.ok(!/'displayedVerdicts'/.test(app.slice(0, app.indexOf('function ') + 8000).match(/\['sold','analysisPeriods'[^\]]*\]/)?.[0] || ''), 'session only, never persisted');
});

run('four states; only a typed fill can place the card', () => {
  const s = (c, f, d = '2026-10-08') => saleDisplayFields(c, d, '2026-10-08', f).verdictDisplayState;
  assert.strictEqual(s(capture, fill('entered')), 'CAPTURED_BEFORE_FILL');
  assert.strictEqual(s(capture, fill('entered', '2026-10-08T14:30:00.000Z')), 'CAPTURED_BEFORE_FILL', 'the same instant is before');
  assert.strictEqual(s(capture, fill('entered', '2026-10-08T14:20:00.000Z')), 'CAPTURED_AFTER_FILL');
  assert.strictEqual(s(capture, fill('default')), 'CAPTURED_FILL_UNKNOWN', 'a default would always say BEFORE, falsely');
  assert.strictEqual(s(capture, { source: 'not_known', at: null, filledAt: null }), 'CAPTURED_FILL_UNKNOWN', 'the card was on screen, so NOT_DISPLAYED would be false');
  assert.strictEqual(s(null, fill('entered')), 'NOT_DISPLAYED');
  assert.strictEqual(s(capture, fill('entered'), '2026-10-07'), 'NOT_DISPLAYED', 'recorded on a later day');
  assert.strictEqual(saleDisplayFields(null, '2026-10-08', '2026-10-08', fill('entered')).verdictDisplayedAtSale, null);
  assert.strictEqual(saleDisplayFields(capture, '2026-10-08', '2026-10-08', fill('default')).verdictDisplayedAtSale, capture, 'verbatim');
});

run('the report states the normal case neutrally, as a gap in minutes, and says why a distribution is absent', () => {
  const vm = require('vm');
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(grab('buildVerdictCaptureSection') + ';globalThis.f = buildVerdictCaptureSection;', ctx);
  const none = ctx.f([{ sellFilledAtSource: 'default', sellFilledAt: 'x', recordedAt: 'y', verdictDisplayState: 'CAPTURED_FILL_UNKNOWN' }]);
  assert.ok(none.includes('not shown yet'), 'absent, with why');
  assert.ok(none.includes('accepted defaults would sit near zero by construction'));
  assert.ok(!/warning|defect|⚠/i.test(none));
  const row = (mins, st = 'CAPTURED_AFTER_FILL') => ({ sellFilledAtSource: 'entered', sellFilledAt: '2026-10-08T14:00:00Z', recordedAt: new Date(Date.parse('2026-10-08T14:00:00Z') + mins * 60000).toISOString(), verdictDisplayState: st, verdictDisplayedAtSale: { rendered_at: new Date(Date.parse('2026-10-08T14:00:00Z') + mins * 60000).toISOString() } });
  const some = ctx.f([row(2), row(4), row(30), { verdictDisplayState: 'NOT_DISPLAYED' }, {}]);
  assert.ok(some.includes('Card rendered after the fill: 3 (median 4 min'), some);
  assert.ok(some.includes('Selection bias'), 'in those terms');
  assert.ok(some.includes('a cautious upper bound on default rows'));
  assert.ok(some.includes('4 of 5 sales carry a capture state'));
  assert.ok(!/warning|defect|⚠/i.test(some), 'neutral');
});

// The revision stamp is tied to the contents: change the file and this fails until the stamp moves too.
const sql = readSource('db/038_macro_observe_only_and_settings.sql').replace(/\r\n/g, '\n');
const run2 = readSource('db/038-run-2-behaviour.sql').replace(/\r\n/g, '\n');
const STAMP = '2026-11-06-e';
const SHA = '930c509506b8a47ae6717faea7b633200c9fc95fe22bec1d48e7a0d5c5c3346b';

run('db/038 carries a revision, run 2 reads it back from the database, and the stamp moves with the file', () => {
  assert.ok(sql.includes(`-- REVISION ${STAMP}.`));
  assert.ok(sql.includes(`db038_revision=${STAMP}`), 'stored in the database');
  assert.ok(run2.includes(`expected_revision constant text := '${STAMP}'`), 'the check expects the same one');
  assert.ok(/obj_description\('public\.macro_observations'::regclass\)/.test(run2), 'read back, not assumed');
  assert.ok(/applied_revision is distinct from expected_revision/.test(run2), 'and it fails on any other');
  assert.strictEqual(crypto.createHash('sha256').update(sql).digest('hex'), SHA, 'db/038 changed: change its REVISION in both files, then this pin, and say earlier copies are void');
});

run('run 2 verifies each part on its own, so a failure names which', () => {
  for (const p of ['macro', 'settings', 'sell_filled_at', 'capture and scoring', 'verdict A']) assert.ok(run2.includes(`('${p}', '`), p);
  // Each column under its own part, and every column db/038 adds to an existing table is under one.
  const partOf = {};
  for (const m of run2.matchAll(/\('(macro|settings|sell_filled_at|capture and scoring|verdict A)', '([a-z_0-9]+)', '([a-z_0-9]+)'\)/g)) partOf[`${m[2]}.${m[3]}`] = m[1];
  for (const [col, part] of [['trades_v2.verdict_display_state', 'verdict A'], ['trades_v2.verdict_displayed_at_sale', 'verdict A'], ['trades_v2.sell_filled_at_source', 'sell_filled_at'], ['rating_snapshots.scoring_hash', 'capture and scoring'], ['rating_snapshots.tier', 'capture and scoring'], ['settings.max_loss_pct', 'settings'], ['trades_v2.macro_path', 'macro']]) assert.strictEqual(partOf[col], part, col);
  const added = [];
  for (const block of sql.matchAll(/alter table ([a-z_0-9]+)\n([\s\S]*?);/g)) for (const m of block[2].matchAll(/add column ([a-z_0-9]+)/g)) added.push(`${block[1]}.${m[1]}`);
  assert.ok(added.length >= 15, `found ${added.length} columns`);
  assert.deepStrictEqual(added.filter(c => !partOf[c]), [], 'every column db/038 adds is verified under a part');
  for (const c of ['sell_filled_at-consistent', 'sell_filled_at-needs-source', 'verdict-consistent', 'verdict-needs-state', 'verdict-state', 'verdict-write-once']) assert.ok(run2.includes(c), c);
  // revision d: the new table's grants are explicit, and run 2 probes its whole grid by behaviour
  assert.ok(sql.includes('revoke all on macro_observations from anon, authenticated;\ngrant select, insert on macro_observations to anon;'), 'explicit grants on macro_observations, not the default ACL');
  assert.ok(run2.includes("g_exp := g_role = 'anon' and g_priv in ('SELECT', 'INSERT');") && run2.includes("format(' macro_observations-grid(%s/24)', g_ok)"), 'the 24-probe grid');
  assert.ok(run2.includes("when sqlstate = '42501' and sqlerrm like 'permission denied for table%' then 'refused'"), 'a refusal only counts as the table privilege\'s own');
  assert.ok(run2.includes("exception when raise_exception then constrained := constrained || ' verdict-write-once'"), 'write-once counts only the trigger\'s own error');
  assert.ok(sql.includes("execute function trades_v2_reject_provenance_change('verdict_displayed_at_sale', 'verdict_display_state')"), 'write-once');
  assert.ok(sql.includes('so db/035 has not run'), 'guarded: the trigger function is db/035\'s');
});

run('the spec says what A is, and that step 2.5 is its own decision', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('A is an audit of the app\'s output, so it records the errors faithfully.'));
  assert.ok(spec.includes('Do not "improve" A by cleaning up what it captures.'));
  assert.ok(spec.includes('Step 2.5 is its own decision, not a follow-on.'));
});
