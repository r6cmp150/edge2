// scripts/lib/production-write.mjs -- 2026-11-12. NO CODE IN THIS REPO WRITES TO PRODUCTION BY DEFAULT (the reviewer's
// rule, CC-refusal-everywhere / CC-refusal-boundary, 2026-11-11). A production write requires a deliberate human act at
// the moment of the write. In the app that act is Roman's tap; everywhere else there is no such act, so a named
// variable stands in for it: EDGE2_PRODUCTION_WRITE must equal the writer's own name. A variable that cannot be set once
// globally for everything is the difference between a deliberate act and an environment someone configured last month.
// Scheduled jobs set it in their workflow step, where it reads as a declaration of what that step does.
//
// The refusal ALWAYS EXITS NON-ZERO (3): a hand-run script that refuses returns an error, which is informative, and a
// scheduled job that lost its variable goes red rather than quietly writing nothing. And it PRINTS WHAT IT WOULD HAVE
// WRITTEN, tables, columns and rows: a refusal that does not say what it was about to do teaches nothing. Every line it
// prints names the writer (the verdict rule, spec 7.7).
//
// tests/production-writes.test.js holds: every writer the walker finds calls this with its own name and a plan whose
// tables and columns equal the walker's, before its first write; every workflow step that runs one, or writes
// workflow_runs with curl, declares the variable; and nothing else in a workflow can reach a production write.

export const PRODUCTION_WRITE_VAR = 'EDGE2_PRODUCTION_WRITE';
export const REFUSED_EXIT = 3;
const VERBS = new Set(['insert', 'update', 'delete']);

// plan: [{ table, verb: 'insert'|'update'|'delete', columns: [...], rows: 'how many rows, and which' }]
export function planLines(plan) {
  return plan.map(p => `  ${p.verb} ${p.table}${p.columns.length ? ` (${p.columns.join(', ')})` : ''}: ${p.rows}`);
}

// A plan that can't say what it writes is refused like a missing variable: a check that cannot identify its subject
// fails rather than passes.
export function planProblem(name, plan) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) return `the writer's name ${JSON.stringify(name)} is not a script name`;
  if (!Array.isArray(plan) || !plan.length) return `${name} declared no writes`;
  for (const p of plan) {
    if (!p || typeof p.table !== 'string' || !p.table) return `${name}: a write with no table`;
    if (!VERBS.has(p.verb)) return `${name}: ${p.table}: verb ${JSON.stringify(p.verb)} is not insert, update or delete`;
    if (!Array.isArray(p.columns) || (p.verb !== 'delete' && !p.columns.length)) return `${name}: ${p.verb} ${p.table} names no columns`;
    if (typeof p.rows !== 'string' || !p.rows) return `${name}: ${p.verb} ${p.table} says nothing about which rows`;
  }
  return null;
}

// The decision alone, for tests: { permitted, lines }. Nothing is printed and nothing exits.
export function productionWriteVerdict(name, plan, env = process.env) {
  const problem = planProblem(name, plan);
  if (problem) return { permitted: false, lines: [`PRODUCTION WRITE REFUSED: ${problem}; nothing was written.`] };
  const value = env[PRODUCTION_WRITE_VAR];
  if (value === name) {
    return { permitted: true, lines: [`PRODUCTION WRITE PERMITTED: ${name} (${PRODUCTION_WRITE_VAR}=${name}). It will write:`, ...planLines(plan)] };
  }
  const why = value === undefined || value === '' ? `${PRODUCTION_WRITE_VAR} is not set` : `${PRODUCTION_WRITE_VAR} is ${JSON.stringify(value)}, not ${JSON.stringify(name)}`;
  return {
    permitted: false,
    lines: [
      `PRODUCTION WRITE REFUSED: ${name}: ${why}. Nothing was written. It would have written:`,
      ...planLines(plan),
      `To write on purpose: ${PRODUCTION_WRITE_VAR}=${name} node scripts/${name}.mjs <its arguments>`,
    ],
  };
}

// Call before the first write. Returns when permitted (after saying so); otherwise prints the refusal and exits 3.
export function requireProductionWrite(name, plan, { env = process.env, log = s => console.error(s), exit = c => process.exit(c) } = {}) {
  const v = productionWriteVerdict(name, plan, env);
  for (const l of v.lines) log(l);
  if (!v.permitted) exit(REFUSED_EXIT);
  return v.permitted;
}
