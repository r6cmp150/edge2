// scripts/lib/taken-groups.mjs -- states of a signal_log symbol-day group that one
// resolve of the whole group can't produce (2026-11-04). fill-outcomes resolves a
// group from the rows it read, and on two runs that read was cut at 1,000, so a
// group could have been resolved in parts. Each state below is what that leaves.
export function takenGroupProblems(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.signal_date}|${r.symbol}|${r.engine_source}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const problems = [];
  for (const [key, g] of groups) {
    const taken = g.filter(r => /^taken/.test(r.taken_resolution));
    const res = new Set(g.map(r => r.taken_resolution));
    const say = why => problems.push({ key, why, rows: g.map(r => `${r.tier}:${r.taken_resolution}`) });
    if (taken.length > 1) say('two taken rows');
    if (taken.length && res.has('traded-against-engine')) say('taken and traded-against in one group');
    if (new Set(g.map(r => r.matched_trade_id).filter(Boolean)).size > 1) say('two matched trades');
    if (res.has('unresolved') && res.size > 1) say('part unresolved');
    if (taken.some(r => r.tier === 'BELOW_THRESHOLD') && g.some(r => r.tier === 'SHOWN')) say('taken on a lower tier than a sibling');
    if (taken.some(r => r.tier === 'NEAR_MISS') && g.some(r => r.tier === 'QUALIFIED')) say('taken on a lower tier than a sibling');
  }
  return problems;
}
