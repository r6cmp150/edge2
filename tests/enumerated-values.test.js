// tests/enumerated-values.test.js — 2026-11-11. A CHECK's value list is a contract the app has to satisfy, and until
// now nothing tied the two together: db/042 enumerated three execution_mode_source values and the sale needed a fourth,
// caught only by reading the live constraint before writing the code (db/043). live-columns.json records columns, not
// constraints. This is the class fix (ruled by the reviewer, 2026-11-11).
//
// Two sources for each CHECK's values, and both must agree for a migration declared applied:
//   the committed SQL      what the migration SAYS (db/NNN_*.sql, in order: add/drop constraint, column checks)
//   the capture            what the database HAS (db/live-columns.json "checks", generated from the capture)
// For a migration declared NOT applied they are meant to differ; its values count as permitted only once applied.
//
// Every CHECK in the capture is in exactly one state: PARSED (a value list per column), EXCLUDED (named below with its
// reason and pinned to its text, so a rewrite fails until someone looks), or UNKNOWN, which FAILS.
// Every value the app writes to a governed column (the write sites tests/live-columns.test.js finds, through the same
// walker, tests/_write-walker.js) is: ENUMERATED (literals the walker resolves; each must be permitted by BOTH lists),
// NULL (listed), CARRIED (copied from another governed column: declared below, the expression pinned, and the source's
// values must be a subset of the target's), or NOT ENUMERABLE, which FAILS.
// Every permitted value is: written by the app, written externally (declared, naming who writes it), pending (declared,
// naming the change that will write it), or none of those, which FAILS. The pending list is printed on every run.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { run, readSource, REPO_ROOT } = require('./_lib');
const W = require('./_write-walker');

const CAPTURE = JSON.parse(readSource('db/live-columns.json'));
const M = CAPTURE._migrations;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// ---- reading a CHECK into value lists ------------------------------------------------------------------------------
// Input: a CHECK body as the server spells it (capture) or as a migration wrote it. Output: { col: { values: Set,
// patterns: Set } } for every column the expression compares against text literals, or null if it compares none.
function vocab(def) {
  const t = def.replace(/::[a-z_]+(?: varying)?(\[\])?/gi, '').replace(/\s+/g, ' ');
  const out = {};
  // a column compared as itself: not a function's argument (jsonb_typeof(x) = 'object' says nothing about x's text),
  // not a JSON path's key (x ->> 'state'); "(x) = ..." is the server's own parenthesising and is the column itself
  // (a function call has its "(" against its name; "OR (" / "AND (" / "NOT (" are grouping, not calls)
  const bare = (m, c) => { const b = t.slice(0, m.index + m[0].indexOf(c)); return !/->>?\s*$/.test(b) && !(/[a-z_0-9]\(\s*\(?$/i.test(b) && !/\b(and|or|not)\s*\(\s*\(?$/i.test(b)); };
  const add = (c, kind, v) => { c = c.toLowerCase(); (out[c] ||= { values: new Set(), patterns: new Set() })[kind].add(v); };
  const lits = s => [...s.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
  const un = s => s.replace(/''/g, "'");
  for (const m of t.matchAll(/\b([a-z_][a-z_0-9]*)\)? = any \(\s*\(?array\[([^\]]*)\]\)?\s*\)/gi)) if (bare(m, m[1])) for (const v of lits(m[2])) add(m[1], 'values', v);
  for (const m of t.matchAll(/\b([a-z_][a-z_0-9]*)\)? in \(([^()]*)\)/gi)) if (bare(m, m[1])) for (const v of lits(m[2])) add(m[1], 'values', v);
  for (const m of t.matchAll(/\b([a-z_][a-z_0-9]*)\)? = '((?:[^']|'')*)'/gi)) if (bare(m, m[1])) add(m[1], 'values', un(m[2]));
  for (const m of t.matchAll(/coalesce\(\(?([a-z_][a-z_0-9]*)\)?, ''\) = '((?:[^']|'')*)'/gi)) add(m[1], 'values', un(m[2]));
  for (const m of t.matchAll(/\b([a-z_][a-z_0-9]*)\)? ~ '((?:[^']|'')*)'/gi)) if (bare(m, m[1])) add(m[1], 'patterns', un(m[2]));
  return Object.keys(out).length ? out : null;
}
const permits = (v, x) => x.values.has(v) || [...x.patterns].some(p => new RegExp(p).test(v));

// ---- the committed SQL: each migration's CHECKs, in order ----------------------------------------------------------
function sqlChecks(nums) {
  const state = {}; // table -> name -> body
  const files = fs.readdirSync(path.join(REPO_ROOT, 'db')).filter(f => /^\d{3}_.*\.sql$/.test(f));
  const order = [];
  for (const n of [...nums].sort((a, b) => a - b)) {
    order.push(files.find(x => Number(x.slice(0, 3)) === n));
    for (const c of CORRECTIONS.filter(c => c.after === n)) order.push(c.file);
  }
  for (const f of order) {
    if (!f) continue;
    // one pass, so a "--" inside a string literal is not a comment (a raise message in a CORRECTION has one), then
    // names lowered and literals kept
    const sql = W.stripSql(readSource(`db/${f}`))
      .replace(/'(?:[^']|'')*'|[^']+/g, x => (x.startsWith("'") ? x : x.toLowerCase()));
    // statements in source order: create table, alter table (add/drop constraint, add column ... check), drop table
    const stmts = [...sql.matchAll(/\b(create\s+table|alter\s+table|drop\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?(?:public\.)?([a-z_0-9]+)/g)];
    for (const s of stmts) {
      const table = s[2], kind = s[1].split(/\s+/)[0];
      const T = (state[table] ||= {});
      if (kind === 'drop') { delete state[table]; continue; }
      if (kind === 'create') {
        const open = sql.indexOf('(', s.index + s[0].length);
        const body = W.balanced(sql, open);
        if (!body) continue;
        for (const e of W.entries(`{${body.slice(1, -1)}}`)) {
          let m;
          if ((m = e.match(/^constraint\s+([a-z_0-9]+)\s+check\s*\(/))) T[m[1]] = W.balanced(e, e.indexOf('(', m[0].length - 1)).slice(1, -1);
          else if ((m = e.match(/^([a-z_][a-z_0-9]*)\s[^]*?\bcheck\s*\(/)) && !/^(constraint|primary|unique|foreign)$/.test(m[1])) T[`${table}_${m[1]}_check`] = W.balanced(e, m[0].length - 1).slice(1, -1);
        }
        continue;
      }
      const stmt = sql.slice(s.index, sql.indexOf(';', s.index));
      for (const part of W.entries(`{${stmt.slice(s[0].length)}}`)) {
        let m;
        if ((m = part.match(/drop\s+constraint\s+(?:if\s+exists\s+)?([a-z_0-9]+)/))) delete T[m[1]];
        else if ((m = part.match(/add\s+constraint\s+([a-z_0-9]+)\s+check\s*\(/))) T[m[1]] = W.balanced(part, m.index + m[0].length - 1).slice(1, -1);
        else if ((m = part.match(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_0-9]+)\s[^]*?\bcheck\s*\(/))) T[`${table}_${m[1]}_check`] = W.balanced(part, m.index + m[0].length - 1).slice(1, -1);
      }
    }
  }
  return state;
}

// ---- declarations --------------------------------------------------------------------------------------------------
// Committed SQL outside the numbered migrations that changes a CHECK: read in order, after the migration named. Closed:
// a db/CORRECTION_*.sql that touches a constraint and is not listed here fails.
const CORRECTIONS = [
  { file: 'CORRECTION_2026-10-09_forced_test_scan.sql', after: 27, why: 'adds FORCED_TEST to scan_runs.session (drops the one session CHECK by a looked-up name, re-adds scan_runs_session_check); dated 2026-10-09, db/028 the next migration written; the capture shows it applied' },
];
// Tables in this database that belong to another project (no SQL for them in this repo): their CHECKs are parsed, but
// the committed SQL cannot govern them and nothing here writes them. Closed: a write to one fails.
const FOREIGN = {
  incidents: 'Shark Analytics (another project sharing this Supabase database)',
  regions: 'Shark Analytics',
  risk_estimates: 'Shark Analytics',
  shark_migrations: 'Shark Analytics',
};
// CHECKs that constrain something other than a text vocabulary (a JSON shape, a number, a relation between columns),
// each pinned to the capture's text: if the live text changes, this fails until the entry is looked at again.
const EXCLUDED = {
  'analysis_periods.analysis_periods_change_description_check': { sha256: 'bfe4cadd226ee836bca512eba6e73b38f3184e3a37b6198493fcf15912644aac', why: 'a non-empty text length, not a vocabulary' },
  'analysis_periods.analysis_periods_name_check': { sha256: '1e9c14ebb67a1eac1a4db848b9677cb2acb6b876933573c6f21941d2db46d135', why: 'a non-empty text length, not a vocabulary' },
  'incidents.incidents_confidence_score_check': { sha256: 'e6f01ac6cf01fa4aebffd84068474d09881bf6a19d35688c9160472c3fa6d4e4', why: 'a numeric range (Shark Analytics table)' },
  'incidents.incidents_motivation_confidence_check': { sha256: '0dde58a535b2f7613cde3577114d129e377b49500089ceb0dd64bcf2bc851686', why: 'a numeric range (Shark Analytics table)' },
  'macro_observations.macro_observations_applied_check': { sha256: 'cd5877f46c3a1adc428d576dfab5bdb2a8d613f03a67399311e7b8f017887f84', why: 'a boolean fixed at false (observe-only), not a text vocabulary' },
  'macro_observations.macro_observations_check': { sha256: 'ad91d2d6a4e435e4f0c99322b96f44a70d36d5d2275e63529e93f1f4f0c795f9', why: 'a relation between two columns (groq_asked iff a reason)' },
  'macro_observations.macro_observations_check1': { sha256: '59faa2c68644fa992b107a09080b64b3f131c6b8aaf814cedd29ea66476044ed', why: 'a relation between two columns (asked implies groq_failed recorded)' },
  'portfolio.portfolio_code_version_shape_chk': { sha256: 'a607068f5ec1558e00f5f52f6a96df57624d31b3f09c8299dd41845c22ff607b', why: 'a JSON shape: {app: string, scoring: number, scoring_hash: string} (db/028, made definite by db/040)' },
  'risk_estimates.risk_estimates_estimation_confidence_check': { sha256: '202e76c60c71bed6e116f4c1b6015ec5cceb82a47d196945d98e4c0193ed091e', why: 'a numeric range (Shark Analytics table)' },
  'scan_runs.scan_runs_code_version_shape_chk': { sha256: 'a607068f5ec1558e00f5f52f6a96df57624d31b3f09c8299dd41845c22ff607b', why: 'a JSON shape: {app: string, scoring: number, scoring_hash: string} (db/028, made definite by db/040)' },
  'scan_runs.scan_runs_prefilter_rejections_shape_chk': { sha256: '6b21fb63b78da03b950fd83f207782d054c49c201ac623a49fa11f3f4deb6420', why: 'a JSON shape (an array)' },
  'scan_runs.scan_runs_prefilter_rule_shape_chk': { sha256: '80e6b71a11a2b26b2f767ca786d5b0157c4d4d43934e804c22bbc547a0b8d200', why: 'a JSON shape (db/032, made definite by db/040)' },
  'settings.settings_float_threshold_shares_check': { sha256: '430746fe674979e65286e13f4b12fff889e024289806590dc522c5efc37c0283', why: 'a numeric range' },
  'settings.settings_max_loss_pct_check': { sha256: '6f77469765494b0d26c9b4ef6fab500015636bc9d18cbbd736ab984ef8778a8b', why: 'a numeric range' },
  'settings.settings_risk_per_trade_pct_check': { sha256: '42ead1d386c9a725457c1ad2e9f7739ad8ef7b3f6b704aac70e5ae0f6b2f982d', why: 'a numeric range' },
  'shark_migrations.shark_migrations_month_check': { sha256: 'f6108e6b22ce6bff23d36b632a28a87e8e6fc319a6ff06972863c4bf54e41c23', why: 'a numeric range (Shark Analytics table)' },
  'signal_log.ret_1d_split_exclusive': { sha256: '4dadd3eba69bb55ccee7ea115d124041412c5c2d3c153bce42d429908a33a2c7', why: 'a relation between two columns (a return and its split flag)' },
  'signal_log.ret_3d_split_exclusive': { sha256: 'cab91070baaa99bd31ddc481421620f10edd4323fb06be6c0f078af6f36e53c1', why: 'a relation between two columns (a return and its split flag)' },
  'signal_log.ret_5d_split_exclusive': { sha256: 'c42d2f522e848d5e606a22f3c7cd15b46439cfc073c66d30b60278395c96c20c', why: 'a relation between two columns (a return and its split flag)' },
  'signal_log.ret_close_split_exclusive': { sha256: 'be66f98f7d4997df7cf389dad81af79792c592e1e2cbd0c4b668d2a92c6895f1', why: 'a relation between two columns (a return and its split flag)' },
  'signal_log.signal_log_code_version_shape_chk': { sha256: 'a607068f5ec1558e00f5f52f6a96df57624d31b3f09c8299dd41845c22ff607b', why: 'a JSON shape: {app: string, scoring: number, scoring_hash: string} (db/028, made definite by db/040)' },
  'signal_snapshot_at_buy.signal_snapshot_at_buy_one_state_chk': { sha256: '51ddb6340c0c87d060d87cae964d434a6e83cc540bd77f73c9cb6493fdbefa0b', why: 'a JSON shape with a relation to absent_reason (db/033): a snapshot object or a reason, never both' },
  'trades_v2.trades_v2_code_version_shape_chk': { sha256: 'a607068f5ec1558e00f5f52f6a96df57624d31b3f09c8299dd41845c22ff607b', why: 'a JSON shape: {app: string, scoring: number, scoring_hash: string} (db/028, made definite by db/040)' },
  'trades_v2.trades_v2_sale_code_version_shape_chk': { sha256: 'd1c22d25477e69bfe6f7eb4e6c3ccdd5b08da419f58acd9b8622899705eb35ba', why: 'a JSON shape: {app: string, scoring: number, scoring_hash: string} (db/028, made definite by db/040)' },
  'trades_v2.trades_v2_signal_before_sale_shape_chk': { sha256: '6cf8557f979de14efa9bfa3234abf8c2d7903cc7cf9c7c5e0f2eb39c8badf45b', why: 'a JSON shape: {state: PREDATES_SALE, ...} or NOT_RECORDED with a reason (db/035, made definite by db/040); its state values are a JSON key, not a column' },
};
// Values copied from another governed column rather than written as literals: the expression exactly as written at
// the site, and the column it comes from.
// Keyed by the write site's enclosing function and the column.
const SALE_POS = 'the position being sold, state.portfolio.find(p => p.id === posId) in confirmMarkSold: a portfolio row read back by mapSupabasePortfolioRowToPosition';
const SAVED_POS = 'a held position (state.portfolio) being re-saved: the values it was read back with, by mapSupabasePortfolioRowToPosition';
const CARRIED = {
  'writeTradeToSupabase trades_v2.engine_source': { expr: 'record.engineSource || null', from: 'portfolio.engine_source', why: `record.engineSource is pos.engineSource; ${SALE_POS}` },
  'writeTradeToSupabase trades_v2.exit_rule_id': { expr: 'pos.exitRuleId ?? null', from: 'portfolio.exit_rule_id', why: SALE_POS },
  'writeTradeToSupabase trades_v2.order_type': { expr: 'pos.orderType ?? null', from: 'portfolio.order_type', why: SALE_POS },
  'savePositionToSupabase portfolio.engine_source': { expr: 'position.engineSource || null', from: 'portfolio.engine_source', why: SAVED_POS },
  'savePositionToSupabase portfolio.exit_rule_id': { expr: 'position.exitRuleId ?? null', from: 'portfolio.exit_rule_id', why: SAVED_POS },
  'savePositionToSupabase portfolio.order_type': { expr: 'position.orderType ?? null', from: 'portfolio.order_type', why: SAVED_POS },
};
// Expressions the code can only fill from a list it holds. Values read from the list's literal; every pin must be in
// the file named, or the leaf fails.
const LEAVES = {
  "document.getElementById('sold-order-type')?.value": {
    file: 'core/orders.js', list: 'ORDER_TYPES',
    why: 'the sale form\'s <select>, whose options are built from ORDER_TYPES and nothing else; a <select> submits only an option\'s value',
    pins: [['app.js', 'const sellTypeOpts = ORDER_TYPES.map(([v, l]) => `<option value="${v}"'], ['app.js', '<select id="sold-order-type" class="form-input">${sellTypeOpts}</select>']],
  },
  'document.getElementById(`${prefix}-order-type`).value': {
    file: 'core/orders.js', list: 'ORDER_TYPES',
    why: 'the add forms\' order-type <select>; readOrderEntry refuses any value not in ORDER_TYPE_LABEL, which is ORDER_TYPES',
    pins: [['core/orders.js', "if (!ORDER_TYPE_LABEL[orderType]) return { error: 'Choose an order type.' };"], ['core/orders.js', 'const ORDER_TYPE_LABEL = Object.fromEntries(ORDER_TYPES);']],
  },
  "(process.argv.find(a => a.startsWith('--session=')) || '').split('=')[1]": {
    unreachable: true,
    why: 'a test override: with --write the script exits before any write unless --write is its only argument (scripts/lib/test-override-guard.mjs, an allowlist), so this never reaches scan_runs.session',
    pins: [['scripts/log-signals-warrior.mjs', "try { refuseTestOverridesWithWrite('log-signals-warrior'); }"], ['scripts/lib/test-override-guard.mjs', "allowedArgs = ['--write']"], ['scripts/lib/test-override-guard.mjs', 'const badArgs = argv.filter(a => !allowedArgs.includes(a));']],
  },
};
// Calls that replay an earlier call's arguments (a retry): skipped when tracing a parameter to its callers, because
// the values are those the first call passed, which the trace already reads.
const REPLAYS = {
  writeTradeToSupabase: { call: 'writeTradeToSupabase(...f.args)', why: 'retrySaleWrite replays the arguments the failed first attempt stored (saleWriteFailures); the first attempt is the confirmMarkSold path, which the trace reads. A stored record from an OLDER build is what saleVerdictProvenance classifies, and its literals are read from that function.' },
};
// Permitted values the app does not write. Each is exactly one of (ruled by the reviewer, 2026-11-11):
//   external: who writes it         default: the column's DEFAULT writes it (verified against the capture)
//   pending: the change that will   reserved: the decision it waits on, with a review date
const each = (vals, d) => Object.fromEntries(vals.map(v => [v, d]));
const MACRO = ['pattern', 'groq', 'pattern_groq_failed', 'unclassified', 'not_fetched'];
const GATED = 'the macro-gated branch (worktree edge2-gated), whose commits write it; db/038 is applied, so they ship when cleared';
// The app side of db/042 shipped 2026-11-12: every value it was pending on is now written by the app and read here as
// such, so its pending entries are gone. What it does not write is declared below by name.
const DB_PATTERNS = {
  '~^derived_from_robinhood_export_[0-9]{4}-[0-9]{2}-[0-9]{2}$': { external: 'hand-run SQL from a match against Roman\'s Robinhood export (STATUS.md, waiting on Roman)' },
  '~^declared_by_roman_[0-9]{4}-[0-9]{2}-[0-9]{2}$': { external: 'hand-run SQL recording Roman\'s testimony, labelled as such' },
};
const MACRO_PATHS = { ...each(MACRO, { pending: GATED }), unknown: { default: 'a row written before, or without, a macro classification (db/038)' } };
const DECLARED = {
  // a buy is live or paper, never not_known, from this build (core/store.js recordedModeColumns refuses it); every
  // portfolio row from before the app side has not_known by the column DEFAULT
  'portfolio.execution_mode': { not_known: { default: 'a position nobody recorded a mode for: added before the app side of db/042 shipped (db/042)' } },
  // a sale copies its position's mode (copied_from_position), so nothing records a mode AT a sale
  'trades_v2.execution_mode_source': { recorded_at_trade: { reserved: 'a trade recorded directly as closed, with no position (a manual entry, or a Warrior sale): no such path exists; if none is commissioned by the review, the value comes out of the trades_v2 CHECK', review: '2026-12-31' }, ...DB_PATTERNS },
  'portfolio.execution_mode_source': DB_PATTERNS,
  'trades_v2.macro_path': MACRO_PATHS,
  'rating_snapshots.macro_path': MACRO_PATHS,
  'portfolio.macro_path_at_buy': MACRO_PATHS,
  'macro_observations.path': each(MACRO, { pending: GATED }),
  'macro_observations.feed': each(['iex', 'sip'], { pending: GATED }),
  'macro_observations.groq_ask_reason': each(['daily', 'pattern_changed'], { pending: GATED }),
  'macro_observations.source': each(['browser', 'logger'], { pending: GATED }),
  'rating_snapshots.tier': each(['SHOWN', 'BELOW_THRESHOLD'], { pending: GATED }),
  'rating_snapshots.outcome_selection': each(['first_in_30min', 'not_selected'], { pending: 'db/039 (not applied) and its app commit (d) on the macro-gated branch' }),
  'trades_v2.sell_filled_at_source': each(['entered', 'default', 'not_known'], { pending: `${GATED} (the sale form's fill time)` }),
  'trades_v2.verdict_display_state': each(['CAPTURED_BEFORE_FILL', 'CAPTURED_AFTER_FILL', 'CAPTURED_FILL_UNKNOWN', 'NOT_DISPLAYED'], { pending: `${GATED} (verdict A)` }),
  'trades_v2.verdict_provenance': { sale_moment: { reserved: 'verdict B (a verdict computed at the sale moment), not commissioned; if it is still not commissioned at the review, the value comes out of the CHECK', review: '2026-12-31' } },
  'scan_runs.session': { FORCED_TEST: { external: 'db/CORRECTION_2026-10-09_forced_test_scan.sql, one row (scan 3da6957d); no code may write it (the test-override guard refuses --session with --write)' } },
  'signal_log.taken_resolution': { unresolved: { default: 'a signal not yet resolved; fill-outcomes.mjs moves it to the other four' } },
  'setup_triggers.engine_source': { EDGE: { reserved: 'the decision whether Warrior continues at all (STATUS.md, the 2026-12-31 Warrior review): db/013 made setup_triggers engine-agnostic, and the engine that writes it has never produced a setup', review: '2026-12-31' } },
};

// ---- reading a value expression ------------------------------------------------------------------------------------
// The walker's own resolvers do the work (W.strings, W.named, W.callsOf); this adds four forms, each read from the
// code: a || b / a ?? b (both sides), a property of an object literal (x.prop), a function's return values, and a
// `let x;` assigned on several branches. Returns { values: Set, nullable } or throws W.NotEnumerable naming why.
const NE = why => new W.NotEnumerable(why);
// A call of a plain function name: not part of a longer name and not a property access (x.fn), but a spread (...fn) is.
const CALL = '(?<![\\w$])(?<![^.]\\.)';
function topSplit(expr, ops) { // the first top-level occurrence of one of ops, outside strings and brackets
  let depth = 0, q = null;
  for (let j = 0; j < expr.length; j++) {
    const ch = expr[j];
    if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '`') { j = W.templateEnd(expr, j); if (j < 0) return null; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0) for (const op of ops) if (expr.startsWith(op, j)) return [expr.slice(0, j), expr.slice(j + op.length)];
  }
  return null;
}
function fnSource(name, ctx) { // the function declared as `function name(`, in this file first, then any
  const files = [ctx.file, ...[...ctx.sources.keys()].filter(f => f !== ctx.file)];
  for (const f of files) {
    const s = ctx.sources.get(f), m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(s || '');
    if (!m) continue;
    const params = W.balanced(s, m.index + m[0].length - 1), open = s.indexOf('{', m.index + m[0].length - 1 + params.length);
    return { file: f, src: s, start: open, body: W.balanced(s, open) };
  }
  throw NE(`no function ${name}`);
}
// The function's parameters bound to THIS call's arguments (W.named honours ctx.bind first), so its returns are read
// along the call being followed, not unioned over every caller of the function. A missing argument is its default,
// else undefined. Spread arguments: no binding (the parameter is then traced to every caller, as before).
function callBind(name, callExpr, src, at, ctx) {
  const fn = fnSource(name, ctx), head = W.enclosingFunction(fn.src, fn.start + 1);
  const args = W.entries(`{${W.balanced(callExpr, callExpr.indexOf('(')).slice(1, -1)}}`);
  if (!head || args.some(a => a.startsWith('...'))) return null;
  return {
    file: fn.file, start: fn.start, end: fn.start + fn.body.length,
    args: Object.fromEntries(head.params.filter(p => p.name).map((p, k) => [p.name,
      args[k] != null ? { expr: args[k], src, at, file: ctx.file }
        : { expr: p.dflt ?? 'undefined', src: p.dflt != null ? fn.src : src, at: p.dflt != null ? fn.start : at, file: p.dflt != null ? fn.file : ctx.file }])),
  };
}
function returnsOf(name, ctx) { // [{ expr, src, at, file }] for every `return <expr>` in the function's own body
  const fn = fnSource(name, ctx), out = [];
  for (const m of fn.body.matchAll(/\breturn\s+/g)) {
    const at = fn.start + m.index + m[0].length;
    if (W.enclosingFunction(fn.src, at)?.start !== fn.start) continue; // a nested function's return is not this one's
    out.push({ expr: W.statementAt(fn.src, at).trim(), src: fn.src, at, file: fn.file });
  }
  if (!out.length) throw NE(`function ${name} returns nothing readable`);
  return out;
}
const union = rs => ({ values: new Set(rs.flatMap(r => [...r.values])), nullable: rs.some(r => r.nullable) });
function objects(expr, src, at, ctx, depth) { // the object literals an expression can be: [{ text, src, at, ctx }]
  if (depth > 12) throw NE(`too deep: ${expr.slice(0, 40)}`);
  expr = expr.trim().replace(/^global\./, '');
  let m;
  if (expr.startsWith('{') && W.balanced(expr, 0) === expr) return [{ text: expr, src, at, ctx }];
  const t = W.ternary(expr);
  if (t) return [...objects(t[1], src, at, ctx, depth + 1), ...objects(t[2], src, at, ctx, depth + 1)];
  if ((m = expr.match(/^([A-Za-z_$][\w$]*)\(/)) && W.balanced(expr, m[0].length - 1).length === expr.length - m[0].length + 1) {
    const bind = callBind(m[1], expr, src, at, ctx);
    return returnsOf(m[1], ctx).flatMap(r => objects(r.expr, r.src, r.at, { ...ctx, file: r.file, bind }, depth + 1));
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return named(expr, src, at, ctx, depth, (e, s, a, c, d) => objects(e, s, a, c, d));
  throw NE(`an object the walker can't read: ${expr.slice(0, 50)}`);
}
// W.named, and, when it finds no caller for a parameter, the callers in every source: the app's scripts share globals
// (app.js calls core/store.js without importing it), which W.callsOf cannot see. A call passing spread arguments is a
// replay of an earlier call: declared in REPLAYS, or NOT ENUMERABLE.
// A parameter of the enclosing function, not redeclared in it before here, is traced to its callers BEFORE any earlier
// declaration of the same name in the file: W.named takes the nearest preceding declaration anywhere in the file, and
// an unrelated `const position = ...` above a function whose parameter is `position` is not its value.
function named(name, src, at, ctx, depth, how) {
  const b = ctx.bind, bound = b && b.file === ctx.file && at >= b.start && at < b.end && name in b.args;
  const fn = W.enclosingFunction(src, at), i = fn ? fn.params.findIndex(p => p.name === name) : -1;
  const shadowed = fn && new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).test(src.slice(fn.start, at));
  if (bound || i < 0 || shadowed) return W.named(name, src, at, ctx, depth, how);
  {
    const out = [];
    for (const [f, s] of ctx.sources) for (const c of s.matchAll(new RegExp(`${CALL}${fn.name}\\(`, 'g'))) {
      if (/function\s+$/.test(s.slice(Math.max(0, c.index - 9), c.index))) continue;
      const args = W.entries(`{${W.balanced(s, c.index + c[0].length - 1).slice(1, -1)}}`);
      if (args.some(a => a.startsWith('...'))) {
        if (REPLAYS[fn.name] && REPLAYS[fn.name].call === `${fn.name}(${args.join(', ')})`) continue;
        throw NE(`${f}: ${fn.name}(${args.join(', ')}) passes spread arguments and is not a declared replay`);
      }
      if (args[i] == null) throw NE(`${f}: ${fn.name}() passes no ${name}`);
      out.push(...how(args[i], s, c.index, { ...ctx, file: f, bind: null }, depth + 1));
    }
    if (!out.length) throw NE(`parameter ${name} of ${fn.name}: no caller found in any source`);
    return out;
  }
}
// Property p of one object literal: its own entry (the last wins, as in JS), else the spreads in it, else undefined
// (a missing property reads as undefined, so NULL and nothing else).
function prop(o, p, depth) {
  const es = W.entries(o.text), here = o.src.indexOf(o.text) >= 0 ? o.src.indexOf(o.text) : o.at;
  const own = es.filter(x => new RegExp(`^['"]?${p}['"]?\\s*(:|$)`).test(x)).pop();
  if (own) return values(own.includes(':') ? own.slice(own.indexOf(':') + 1) : p, o.src, here, o.ctx, depth + 1);
  const spreads = es.filter(x => x.startsWith('...'));
  if (!spreads.length) return { values: new Set(), nullable: true };
  return union(spreads.map(x => union(objects(x.slice(3), o.src, here, o.ctx, depth + 1).map(q => prop(q, p, depth + 1)))));
}
// A declared leaf: an expression the code can only fill from a list it holds (a <select>'s value, whose options the
// code builds from that list), read from the list's own literal, with the lines that make it so pinned.
function leaf(expr, ctx) {
  const d = LEAVES[expr];
  for (const [f, text] of d.pins) if (!ctx.sources.get(f)?.includes(text)) throw NE(`LEAVES "${expr}": ${f} no longer contains "${text}"`);
  if (d.unreachable) return { values: new Set(), nullable: false }; // never reaches a write: contributes no value
  const s = ctx.sources.get(d.file), m = new RegExp(`const\\s+${d.list}\\s*=\\s*`).exec(s || '');
  if (!m) throw NE(`LEAVES "${expr}": no const ${d.list} in ${d.file}`);
  const arr = W.balanced(s, m.index + m[0].length);
  const vals = W.entries(`{${arr.slice(1, -1)}}`).map(e => { const x = e.match(/^\[\s*'([^']*)'/); if (!x) throw NE(`${d.list}: an entry that is not ['value', ...]: ${e.slice(0, 30)}`); return x[1]; });
  return { values: new Set(vals), nullable: false };
}
function values(expr, src, at, ctx, depth = 0) {
  if (depth > 12) throw NE(`too deep: ${expr.slice(0, 40)}`);
  expr = expr.trim();
  if (expr === 'null' || expr === 'undefined') return { values: new Set(), nullable: true };
  if (LEAVES[expr]) return leaf(expr, ctx);
  if (/^'([^'\\]*)'$|^"([^"\\]*)"$/.test(expr) || (expr.startsWith('`') && W.templateEnd(expr, 0) === expr.length - 1)) {
    return { values: new Set(W.strings(expr, src, at, ctx, depth)), nullable: false };
  }
  const t = W.ternary(expr);
  if (t) return union([values(t[1], src, at, ctx, depth + 1), values(t[2], src, at, ctx, depth + 1)]);
  const or = topSplit(expr, ['||', '??']);
  if (or) return union([values(or[0], src, at, ctx, depth + 1), values(or[1], src, at, ctx, depth + 1)]);
  let m;
  if ((m = expr.match(/^([A-Za-z_$][\w$]*)\??\.([A-Za-z_$][\w$]*)$/))) { // x.prop: the prop of every object x can be
    return union(objects(m[1], src, at, ctx, depth + 1).map(o => prop(o, m[2], depth + 1)));
  }
  if ((m = expr.match(/^([A-Za-z_$][\w$]*)\(/)) && W.balanced(expr, m[0].length - 1).length === expr.length - m[0].length + 1) {
    const bind = callBind(m[1], expr, src, at, ctx);
    return union(returnsOf(m[1], ctx).map(r => values(r.expr, r.src, r.at, { ...ctx, file: r.file, bind }, depth + 1)));
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    // `let a, x, b;` with no value, then assigned on branches: every assignment in the enclosing function
    const fn = W.enclosingFunction(src, at);
    const scope = fn ? src.slice(fn.start, fn.end) : src;
    if (new RegExp(`\\blet\\s+(?:[\\w$]+\\s*,\\s*)*${expr}\\s*[,;]`).test(scope)) {
      const as = [...scope.matchAll(new RegExp(`(?<![\\w$.])${expr}\\s*=(?![=>])\\s*`, 'g'))];
      if (!as.length) throw NE(`let ${expr}: never assigned`);
      return union(as.map(a => values(W.statementAt(scope, a.index + a[0].length), scope, a.index, ctx, depth + 1)));
    }
    return union(named(expr, src, at, ctx, depth, (e, s, a, c, d) => [values(e, s, a, c, d)]));
  }
  throw NE(`a value the walker can't read: ${expr.slice(0, 50)}`);
}

// ---- the app's writes ----------------------------------------------------------------------------------------------
function writes() {
  const found = []; // { where, table, col, expr, src, at, ctx }
  // The walker reports an entry read inside a builder (fnReturn) at the builder's name, outside its body. Move it to
  // where the expression is, and bind the builder's parameters to the call inside the site's own function, so the
  // insert and the update that share a mapper are read along their own paths, not each other's.
  const sites = W.enumerate((site, col, expr, src, at, ctx) => {
    const file = [...ctx.sources].find(([, s]) => s === src)?.[0] ?? ctx.file;
    const siteSrc = ctx.sources.get(site.file), siteFn = W.enclosingFunction(siteSrc, site.at);
    const i = src.indexOf(expr, at), here = i >= 0 ? i : at;
    const entryFn = W.enclosingFunction(src, here);
    let bind = null;
    if (entryFn && siteFn && (file !== site.file || entryFn.start !== siteFn.start)) {
      const body = siteSrc.slice(siteFn.start, siteFn.end), call = new RegExp(`${CALL}${entryFn.name}\\(`).exec(body);
      if (call) {
        const args = W.entries(`{${W.balanced(body, call.index + call[0].length - 1).slice(1, -1)}}`);
        bind = { file, start: entryFn.start, end: entryFn.end, args: Object.fromEntries(entryFn.params.map((p, k) => [p.name, args[k] != null ? { expr: args[k], src: siteSrc, at: siteFn.start + call.index, file: site.file } : null])) };
      }
    }
    found.push({ where: site.where, table: site.table, col, expr, src, at: here, ctx: { ...ctx, file, bind }, siteFn: siteFn ? siteFn.name : '(top level)' });
  });
  // A column a site writes by property assignment (p.col = ..., fn(..).col = ...) reaches no payload entry. Its values
  // are every `.col = <expr>` in the site's file: an over-reading, so it can only fail more, never pass more.
  const { sources } = W.sites();
  for (const s of sites) if (s.state === 'ENUMERATED' && !('workflowBody' in s)) {
    for (const col of s.cols) {
      if (found.some(f => f.where === s.where && f.col === col)) continue;
      const src = sources.get(s.file);
      for (const m of src.matchAll(new RegExp(`\\.${col}\\s*=(?![=>])\\s*`, 'g'))) {
        const fn = W.enclosingFunction(src, m.index);
        found.push({ where: s.where, table: s.table, col, expr: W.statementAt(src, m.index + m[0].length).trim(), src, at: m.index, ctx: { sources, aliases: W.ALIASES, file: s.file, bind: null }, siteFn: W.enclosingFunction(src, s.at)?.name ?? '(top level)', assignedIn: fn ? fn.name : '(top level)' });
      }
    }
  }
  for (const s of sites) if (s.state === 'ENUMERATED' && 'workflowBody' in s) {
    for (const m of s.workflowBody.matchAll(/\\"([a-z_]\w*)\\"\s*:\s*([^,}]*)/g)) found.push({ where: s.where, table: s.table, col: m[1], workflowValue: m[2].trim() });
  }
  return { sites, found };
}
function valuesOf(w) {
  if ('workflowValue' in w) {
    const m = w.workflowValue.match(/^\\"([^"\\$]*)\\"$/);
    if (m) return { state: 'ENUMERATED', values: [m[1]] };
    if (w.workflowValue === 'null') return { state: 'NULL', values: [] };
    return { state: 'NOT ENUMERABLE', why: `a workflow value: ${w.workflowValue.slice(0, 40)}` };
  }
  // a carry is declared per enclosing function: the insert and the update of a position share expression text
  const fn = w.siteFn;
  const c = CARRIED[`${fn} ${w.table}.${w.col}`];
  if (c) {
    if (c.expr !== w.expr) return { state: 'NOT ENUMERABLE', why: `declared CARRIED as "${c.expr}", but the code now reads "${w.expr}"` };
    return { state: 'CARRIED', from: c.from, fn };
  }
  try {
    const r = values(w.expr, w.src, w.at, { ...w.ctx, aliases: w.ctx.aliases || {} });
    if (!r.values.size) return { state: 'NULL', values: [], fn };
    return { state: 'ENUMERATED', values: [...r.values], nullable: r.nullable, fn };
  } catch (err) {
    if (!(err instanceof W.NotEnumerable)) throw err;
    return { state: 'NOT ENUMERABLE', why: err.message, fn };
  }
}

// table.col -> { values: Set, patterns: Set }, merged across that table's CHECKs; from a { table: { name: body } } map
function governedBy(checks, skip = () => false) {
  const out = {};
  for (const [t, cs] of Object.entries(checks)) for (const [n, def] of Object.entries(cs)) {
    if (skip(t, n)) continue;
    const v = vocab(def);
    if (!v) continue;
    for (const [c, x] of Object.entries(v)) {
      const g = (out[`${t}.${c}`] ||= { values: new Set(), patterns: new Set() });
      x.values.forEach(y => g.values.add(y)); x.patterns.forEach(y => g.patterns.add(y));
    }
  }
  return out;
}
const show = x => [...[...x.values].sort(), ...[...x.patterns].sort().map(p => `~${p}`)].join(' | ');
const excluded = (t, n) => `${t}.${n}` in EXCLUDED || t in FOREIGN;

(async () => {
const LIVE = governedBy(CAPTURE.checks, excluded);
const SQL_APPLIED = governedBy(sqlChecks(M.applied), excluded);
const SQL_ALL = governedBy(sqlChecks([...M.applied, ...M.not_applied]), excluded);

await run('every CHECK in the capture is PARSED or EXCLUDED (pinned to its text); none UNKNOWN', () => {
  const bad = [];
  for (const [t, cs] of Object.entries(CAPTURE.checks)) for (const [n, def] of Object.entries(cs)) {
    const x = EXCLUDED[`${t}.${n}`];
    if (x) { if (x.sha256 !== sha(def)) bad.push(`EXCLUDED ${t}.${n}: its text changed (now ${sha(def)}); look at it again`); continue; }
    if (!vocab(def)) bad.push(`UNKNOWN ${t}.${n}: ${def}`);
  }
  for (const k of Object.keys(EXCLUDED)) { const [t, n] = k.split('.'); if (!CAPTURE.checks[t] || !(n in CAPTURE.checks[t])) bad.push(`EXCLUDED ${k}: not in the capture`); }
  assert.deepStrictEqual(bad, []);
});

await run('every committed CORRECTION that touches a constraint is listed, with its place and reason; FOREIGN tables exist', () => {
  const touching = fs.readdirSync(path.join(REPO_ROOT, 'db')).filter(f => /^CORRECTION_.*\.sql$/.test(f))
    .filter(f => /\b(add|drop)\s+constraint\b|\bcheck\s*\(/i.test(readSource(`db/${f}`).replace(/--[^\n]*/g, '')));
  assert.deepStrictEqual(touching.sort(), CORRECTIONS.map(c => c.file).sort());
  for (const c of CORRECTIONS) assert.ok(M.applied.includes(c.after) && c.why, `${c.file}: placed after an applied migration, with a reason`);
  for (const t of Object.keys(FOREIGN)) assert.ok(CAPTURE.tables[t], `FOREIGN ${t}: not in the capture; remove it`);
});

await run('for the migrations declared applied, the committed SQL and the capture permit the same values', () => {
  const bad = [];
  for (const k of new Set([...Object.keys(LIVE), ...Object.keys(SQL_APPLIED)])) {
    const a = LIVE[k] ? show(LIVE[k]) : '(not governed)', b = SQL_APPLIED[k] ? show(SQL_APPLIED[k]) : '(not governed)';
    if (a !== b) bad.push(`${k}\n      the database has:  ${a}\n      the SQL says:      ${b}`);
  }
  assert.deepStrictEqual(bad, []);
});

const { sites, found } = writes();
const judged = found.filter(w => SQL_ALL[`${w.table}.${w.col}`] || LIVE[`${w.table}.${w.col}`]).map(w => ({ ...w, ...valuesOf(w) }));

await run('every value the app writes to a governed column is enumerable', () => {
  const holes = judged.filter(w => w.state === 'NOT ENUMERABLE').map(w => `${w.where}  ${w.table}.${w.col} = ${w.expr ?? w.workflowValue}  -- ${w.why}`);
  assert.deepStrictEqual(holes, []);
});

await run('every value the app writes is permitted by the database AND by the committed SQL', () => {
  const bad = [];
  for (const w of judged) {
    const k = `${w.table}.${w.col}`;
    const vs = w.state === 'ENUMERATED' ? w.values : w.state === 'CARRIED' ? [...(LIVE[w.from]?.values || [])] : [];
    for (const v of vs) {
      if (!LIVE[k] || !permits(v, LIVE[k])) bad.push(`${w.where}  ${k} = '${v}': the database does not permit it${LIVE[k] ? ` (${show(LIVE[k])})` : ''}`);
      if (!SQL_ALL[k] || !permits(v, SQL_ALL[k])) bad.push(`${w.where}  ${k} = '${v}': the committed SQL does not permit it`);
    }
    if (w.state === 'CARRIED' && LIVE[w.from]) for (const p of LIVE[w.from].patterns) if (!LIVE[k].patterns.has(p)) bad.push(`${w.where}  ${k} carries ${w.from}, whose pattern ~${p} the target does not permit`);
  }
  assert.deepStrictEqual(bad, []);
});

await run('every permitted value is written by the app, externally (named), by DEFAULT (verified), pending (named) or reserved (dated); the rest FAIL', () => {
  const written = {};
  for (const w of judged) {
    const vs = w.state === 'ENUMERATED' ? w.values : w.state === 'CARRIED' ? [...(LIVE[w.from]?.values || [])] : [];
    for (const v of vs) (written[`${w.table}.${w.col}`] ||= new Set()).add(v);
  }
  const STATES = ['external', 'default', 'pending', 'reserved'];
  const bad = [], listed = { pending: [], reserved: [] };
  for (const [k, x] of Object.entries(SQL_ALL)) {
    const [t, c] = k.split('.');
    for (const v of [...x.values, ...[...x.patterns].map(p => `~${p}`)]) {
      if (!v.startsWith('~') && written[k]?.has(v)) continue;
      const d = DECLARED[k]?.[v];
      if (!d) { bad.push(`${k} = '${v}': permitted, but nothing writes it and nothing declares who will`); continue; }
      const st = STATES.filter(s => s in d);
      if (st.length !== 1 || !d[st[0]]) { bad.push(`DECLARED ${k} = '${v}': exactly one of ${STATES.join(' / ')}, with its reason`); continue; }
      if (st[0] === 'default') {
        const live = CAPTURE.defaults[t]?.[c];
        if (live !== `'${v}'::text` && live !== `'${v}'`) bad.push(`DECLARED ${k} = '${v}' as written by DEFAULT, but the capture's DEFAULT is ${live == null ? 'none' : live}`);
      }
      if (st[0] === 'reserved' && !/^\d{4}-\d{2}-\d{2}$/.test(d.review || '')) bad.push(`DECLARED ${k} = '${v}' reserved: it needs a review date`);
      if (st[0] === 'pending' || st[0] === 'reserved') listed[st[0]].push(`${k} = '${v}': ${d[st[0]]}${d.review ? ` (review ${d.review})` : ''}`);
    }
  }
  for (const [k, vs] of Object.entries(DECLARED)) for (const v of Object.keys(vs)) {
    const x = SQL_ALL[k];
    if (!x || !(v.startsWith('~') ? x.patterns.has(v.slice(1)) : x.values.has(v))) bad.push(`DECLARED ${k} = '${v}': no longer permitted; remove the declaration`);
    else if (!v.startsWith('~') && written[k]?.has(v)) bad.push(`DECLARED ${k} = '${v}': the app writes it now; remove the declaration`);
  }
  console.log(`  PENDING (${listed.pending.length}): ${listed.pending.length ? '\n    ' + listed.pending.join('\n    ') : 'none'}`);
  console.log(`  RESERVED (${listed.reserved.length}): ${listed.reserved.length ? '\n    ' + listed.reserved.join('\n    ') : 'none'}`);
  assert.deepStrictEqual(bad, []);
});

await run('the counts this guard depends on', () => {
  const by = st => judged.filter(w => w.state === st).length;
  console.log(`  CHECKs in the capture: ${Object.values(CAPTURE.checks).reduce((n, c) => n + Object.keys(c).length, 0)} (excluded ${Object.keys(EXCLUDED).length}); governed columns: live ${Object.keys(LIVE).length}, SQL with pending ${Object.keys(SQL_ALL).length}`);
  console.log(`  write sites ${sites.length}; governed entries ${judged.length}: ENUMERATED ${by('ENUMERATED')}, NULL ${by('NULL')}, CARRIED ${by('CARRIED')}, NOT ENUMERABLE ${by('NOT ENUMERABLE')}`);
  assert.ok(judged.length > 0, 'the walker found no governed write at all: the guard is blind');
});
})();
