// scripts/lib/float-rebuilds.mjs -- the float table is DATA, not instrument (the reviewer, 2026-11-26): its builder is
// frozen, its contents refresh on schedule, and every rebuild is recorded on the daily line -- how many tickers' floats
// changed, and how many crossed the float line in each direction -- so a shock to the universe is seen as it happens.

// passes the Warrior float pillar (engines/warrior/gate.js evaluatePillarFloat): a usable value under the threshold
export const passes = (e, threshold) => !!e && e.status === 'value' && typeof e.impliedFloatShares === 'number' && e.impliedFloatShares < threshold;

// one rebuild, previous table -> new table
export function floatDiff(prev, next, threshold) {
  const P = prev?.bySymbol || {}, N = next?.bySymbol || {};
  let changed = 0, nowPassing = 0, noLongerPassing = 0, added = 0, removed = 0;
  for (const s of new Set([...Object.keys(P), ...Object.keys(N)])) {
    const a = P[s], b = N[s];
    if (!a) added++; else if (!b) removed++;
    if (a?.status !== b?.status || a?.impliedFloatShares !== b?.impliedFloatShares) changed++;
    const pa = passes(a, threshold), pb = passes(b, threshold);
    if (!pa && pb) nowPassing++;
    if (pa && !pb) noLongerPassing++;
  }
  return { changed, nowPassing, noLongerPassing, added, removed, symbols: Object.keys(N).length };
}

// INTERVENTIONS (condition 2): a rebuild that was not the scheduled, mechanical one. A commit to the table by anyone
// but the builder, or a run of the builder workflow after the start line that a schedule did not trigger.
export const BOT = 'float-table-bot', SUBJECT = 'Float table rebuild ';
export function interventions({ commits, runs, startLine }) {
  const out = [];
  for (const c of commits) if (c.author !== BOT || !c.subject.startsWith(SUBJECT)) out.push(`commit ${c.sha.slice(0, 7)} changed data/float-table.json and is not the scheduled builder's (author ${c.author}: "${c.subject.slice(0, 60)}")`);
  for (const r of runs) if (Date.parse(r.createdAt) > Date.parse(startLine) && r.event !== 'schedule') out.push(`build-float-table run ${r.databaseId} at ${r.createdAt} was triggered by ${r.event}, not the schedule`);
  return out;
}
export function rebuildLine(c, d, threshold) {
  return `  ${c.date.slice(0, 10)} (commit ${c.sha.slice(0, 7)}): ${d.symbols} tickers; ${d.changed} floats changed (${d.added} added, ${d.removed} removed); against the <${threshold.toLocaleString('en-US')} float line: ${d.nowPassing} now pass, ${d.noLongerPassing} no longer pass`;
}
