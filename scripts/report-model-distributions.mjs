#!/usr/bin/env node
// Task 1 (Roman, 2026-09-15): does either model actually discriminate,
// or have we validated a coin flip? Reads the committed production
// tables directly -- no re-streaming needed, this is a pure read of
// data/exit-model-a.json / exit-model-b.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n_cells: sorted.length,
    min: sorted[0] ?? null,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? null,
  };
}

const a = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'exit-model-a.json'), 'utf8'));
const b = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'exit-model-b.json'), 'utf8'));

console.log('=== Model A: p_recover_2d distribution across evaluated cells ===');
for (const branch of Object.keys(a.branches)) {
  const vals = Object.values(a.branches[branch]).filter(c => c.status === 'evaluated').map(c => c.p_recover_2d);
  console.log(branch, JSON.stringify(distribution(vals)));
}

console.log('\n=== Model B: p_peak_already_in distribution across evaluated cells ===');
for (const branch of Object.keys(b.branches)) {
  const vals = Object.values(b.branches[branch]).filter(c => c.status === 'evaluated').map(c => c.p_peak_already_in);
  console.log(branch, JSON.stringify(distribution(vals)));
}

console.log('\n=== Model B: p_higher_close_tomorrow distribution across evaluated cells ===');
for (const branch of Object.keys(b.branches)) {
  const vals = Object.values(b.branches[branch]).filter(c => c.status === 'evaluated' && c.p_higher_close_tomorrow != null).map(c => c.p_higher_close_tomorrow);
  console.log(branch, JSON.stringify(distribution(vals)));
}
