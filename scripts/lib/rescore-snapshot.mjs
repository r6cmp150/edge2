// scripts/lib/rescore-snapshot.mjs -- re-score a stored EDGE signal snapshot
// under the formula that produced it (phase-10 spec §5, db/033).
//
// A snapshot is worth storing only if it is SUFFICIENT: everything
// scoreStock read, so the same formula reproduces the same score. This is
// the one reconstruction of scoreStock's inputs from a snapshot, shared by
// scripts/derive-step2-thresholds.mjs (logged signal_log snapshots) and
// tests/signal-snapshot-at-buy.test.js (the snapshot captured at a buy). Two
// copies of it could disagree; one can't.
//
// "Its own formula": a row's code_version.scoring_hash names the formula
// (scripts/lib/scoring-hash.mjs). formulaSourceForHash walks the git
// history of core/edge-scoring.js (and the working tree) for the revision
// whose formula hashes to it. No match means the formula can't be found,
// and is reported as such, never substituted with the current one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { scoringHash } from './scoring-hash.mjs';

// scoreStock(ticker, snap, bars, newsItem, spyChangePct, category), plus the
// macro context it reads from state. The snapshot holds the price and
// today's volume that came from the live snapshot, so the snapshot object
// is rebuilt from them (price as both last trade and daily close).
export function snapshotScoreInputs(o) {
  const snap = { latestTrade: { p: o.price }, dailyBar: { c: o.price, v: o.volume }, prevDailyBar: { c: o.prevClose } };
  return {
    args: [o.ticker, snap, o.bars, o.news || null, o.spyChange || 0, o.category || null],
    macroContext: o.macroCondition ? { condition: o.macroCondition, changes: null } : null,
  };
}

const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');

// A scorer for one revision's core/edge-scoring.js source. indicators and
// market-data come from the working tree (the formula hash covers the
// scoring sections only).
export function scorerFromSource(root, src) {
  const c = { console, Math, Date, JSON, Number, String, Array, Object, Infinity, NaN, isFinite, state: { settings: {}, macroContext: null } };
  vm.createContext(c);
  for (const f of ['core/indicators.js', 'core/market-data.js']) vm.runInContext(strip(readFileSync(path.join(root, f), 'utf8')), c);
  vm.runInContext(strip(src) + '\n;globalThis.__s = scoreStock;', c);
  return c;
}

export function scoreSnapshotWith(scorer, o) {
  const { args, macroContext } = snapshotScoreInputs(o);
  scorer.state.macroContext = macroContext;
  scorer.state.settings.disableMacroOverlay = false;
  return scorer.__s(...args);
}

const cache = new Map();
export function formulaSourceForHash(root, hash) {
  if (cache.has(hash)) return cache.get(hash);
  let found = null;
  const tree = readFileSync(path.join(root, 'core/edge-scoring.js'), 'utf8');
  if (scoringHash(tree) === hash) found = { rev: 'working-tree', src: tree };
  if (!found) {
    const revs = execSync('git log --format=%H -- core/edge-scoring.js', { cwd: root }).toString().trim().split('\n').filter(Boolean);
    for (const rev of revs) {
      const src = execSync(`git show ${rev}:core/edge-scoring.js`, { cwd: root, maxBuffer: 1e8 }).toString();
      if (scoringHash(src) === hash) { found = { rev: rev.slice(0, 7), src }; break; }
    }
  }
  cache.set(hash, found);
  return found;
}

// Re-score a snapshot under the formula its scoring_hash names.
// -> { score, rev } or { score: null, reason }.
export function rescoreUnderOwnFormula(root, snapshot, scoringHashOfRow) {
  if (!snapshot) return { score: null, reason: 'no snapshot' };
  if (!scoringHashOfRow) return { score: null, reason: 'no scoring_hash on the row' };
  const f = formulaSourceForHash(root, scoringHashOfRow);
  if (!f) return { score: null, reason: `no revision of core/edge-scoring.js hashes to ${scoringHashOfRow}` };
  const r = scoreSnapshotWith(scorerFromSource(root, f.src), snapshot);
  return r ? { score: r.score, rev: f.rev } : { score: null, reason: 'scoreStock returned nothing' };
}
