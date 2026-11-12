// core/execution-mode-count.js — 2026-11-12. The not_known count (ruled by the reviewer, 2026-11-11): every trade a
// build records says whether it was placed at the broker (db/042's app side, build 20261112002000), so a not_known
// row is one of four things, told apart by the BUILD STAMP that wrote it, never by a date:
//   defect        written by a build that records the mode: it should have recorded one. Expected zero, shown red.
//   older_build   written by an earlier build: before the mode existed, or a phone not yet reloaded onto it.
//   build_unknown the row carries no readable stamp (NULL before db/028, or 'unavailable'): neither of the above
//                 can be said, so it is its own state rather than folded into either.
//   carried       a SALE that copied its position's not_known (copied_from_position): legitimate, not counted.
// The writer's stamp: a position's code_version.app (the buy), a sale's sale_code_version.app (the sale). One file,
// loaded by the app (Settings) and run by scripts/count-not-known.mjs (the daily log), so the two can't disagree.
// Classic script, pure: no DOM, no network, no clock.

// The first build that sends the mode (e313349, db/042's app side). Every stamp is YYYYMMDDHHMMSS, so string order
// is time order.
const FIRST_MODE_BUILD = '20261112002000';

function executionModeBuildStamp(codeVersion) {
  const app = codeVersion && typeof codeVersion === 'object' ? codeVersion.app : null;
  return typeof app === 'string' && /^\d{14}$/.test(app) ? app : null;
}

// 'defect' | 'older_build' | 'build_unknown' | 'carried', or null for a row that is not not_known.
function classifyNotKnown(row, table) {
  if (!row || row.execution_mode !== 'not_known') return null;
  if (table === 'trades_v2' && row.execution_mode_source === 'copied_from_position') return 'carried';
  const stamp = executionModeBuildStamp(table === 'portfolio' ? row.code_version : row.sale_code_version);
  if (stamp == null) return 'build_unknown';
  return stamp >= FIRST_MODE_BUILD ? 'defect' : 'older_build';
}

// rows: { portfolio: [...], trades: [...] }, each the not_known rows of that table (others are ignored).
// Returns per state: { positions, sales, examples: ['TICKER (table id)', ..up to 5] }.
function countNotKnown(rows) {
  const out = {};
  for (const s of ['defect', 'older_build', 'build_unknown', 'carried']) out[s] = { positions: 0, sales: 0, examples: [] };
  for (const [table, list] of [['portfolio', rows.portfolio || []], ['trades_v2', rows.trades || []]]) {
    for (const r of list) {
      const s = classifyNotKnown(r, table);
      if (!s) continue;
      out[s][table === 'portfolio' ? 'positions' : 'sales']++;
      if (out[s].examples.length < 5) out[s].examples.push(`${r.ticker} (${table} ${r.id})`);
    }
  }
  return out;
}

// The readout's lines: [{ text, bad }]. Never blank: the defect line is always there, zero included.
function notKnownLines(c) {
  const n = x => x.positions + x.sales;
  const both = x => `${x.positions} position${x.positions === 1 ? '' : 's'}, ${x.sales} sale${x.sales === 1 ? '' : 's'}`;
  const lines = [];
  const d = c.defect;
  lines.push(n(d)
    ? { text: `${n(d)} recorded WITHOUT Live/Paper by a build that records it (${both(d)}; expected 0): ${d.examples.join(', ')}`, bad: true }
    : { text: `None recorded without Live/Paper since build ${FIRST_MODE_BUILD} (expected 0).`, bad: false });
  lines.push({ text: `Recorded by older builds, before Live/Paper existed or on a phone not yet reloaded: ${both(c.older_build)}.`, bad: false });
  if (n(c.build_unknown)) lines.push({ text: `Build not recorded, so neither can be said: ${both(c.build_unknown)}.`, bad: false });
  if (c.carried.sales) lines.push({ text: `Sales that carried an older position's not_known (expected, not counted): ${c.carried.sales}.`, bad: false });
  return lines;
}
