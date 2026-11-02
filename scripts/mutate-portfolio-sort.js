#!/usr/bin/env node
// Mutation check for the portfolio sort (2026-11-02): every mutant below must
// make its guard test fail. Each one edits a source file in place, runs the
// test, and restores the file byte for byte (also on exit or Ctrl-C), so a
// run never leaves a mutant behind. Refuses to start on a dirty file it
// would mutate, so "restore" can never overwrite uncommitted work.
//
//   node scripts/mutate-portfolio-sort.js
//
// A mutant that SURVIVES means a guard that doesn't guard: exit code 1.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS = {
  sort: 'tests/portfolio-sort.test.js',
  gate: 'tests/prior-session-daily-bar.test.js',
};

// [file, test, name, from, to]
const M = [
  // renderPortfolioTab: presentation only
  ['app.js', 'sort', 'visit in display order (sort before the loop)', '  holdings.forEach(p => {', '  [...holdings].sort((a, b) => sortMode === "TIME_LIMIT" ? 0 : comparePositionIds(b.id, a.id)).forEach(p => {'],
  ['app.js', 'sort', 'mode-dependent written VALUE, same count', '    p.prevRSI = prevRSI;', '    p.prevRSI = sortMode === "NEWEST" ? -1 : prevRSI;'],
  ['app.js', 'sort', 'mode-dependent save argument', "      p.peakPriceDate = new Date().toISOString().split('T')[0];", "      p.peakPriceDate = sortMode === \"OLDEST\" ? \"x\" : new Date().toISOString().split('T')[0];"],
  // keys: three states
  ['app.js', 'sort', '|| on the P/L key (0.0% lost)', 'pnlPct: (priceUnavailable || showsEarlierSessionClose) ? null : knownNumber(pnlPct),', 'pnlPct: (priceUnavailable || showsEarlierSessionClose) ? null : (knownNumber(pnlPct) || null),'],
  ['app.js', 'sort', 'earlier close ranked', 'pnlPct: (priceUnavailable || showsEarlierSessionClose) ? null : knownNumber(pnlPct),', 'pnlPct: priceUnavailable ? null : knownNumber(pnlPct),'],
  ['app.js', 'sort', 'filledAt falls back to the id', 'filledAtMs: p.filledAt ? knownNumber(Date.parse(p.filledAt)) : null,', 'filledAtMs: p.filledAt ? knownNumber(Date.parse(p.filledAt)) : knownNumber(Number(p.id)),'],
  ['app.js', 'sort', 'filledAt falls back to buyDate', 'filledAtMs: p.filledAt ? knownNumber(Date.parse(p.filledAt)) : null,', 'filledAtMs: knownNumber(Date.parse(p.filledAt || p.buyDate)),'],
  // portfolioScoreState
  ['app.js', 'sort', 'prior-session score ranked', "  if (age.state === 'PRIOR_SESSION') return { score: null, unknown: `scanned before", "  if (false) return { score: null, unknown: `scanned before"],
  ['app.js', 'sort', 'unknown scan time ranked', "  if (age.state === 'UNJUDGED') return { score: null, unknown: 'scan time not recorded' };", ''],
  ['app.js', 'sort', 'hash ignored', '  if (sig.scoringHash != null && sig.scoringHash !== SCORING_HASH)', '  if (false)'],
  ['app.js', 'sort', 'absent and different versions merged (fix 2)', "  if (sig.scoringVersion == null) return { score: null, unknown: 'scoring version not recorded' };", ''],
  ['app.js', 'sort', 'different version reported as "not recorded" (fix 2)', "unknown: `scored by scoring v${sig.scoringVersion}, current is v${SCORING_VERSION}` };", "unknown: 'scoring version not recorded' };"],
  ['app.js', 'sort', 'not-evaluated reported as a formula claim (fix 3)', "  if (sig?.notEvaluatedReason) return { score: null, unknown: `not evaluated (${sig.notEvaluatedReason})` };", "  if (sig?.notEvaluatedReason) return { score: null, unknown: 'scored by another formula' };"],
  // markers
  ['app.js', 'sort', 'scan label without the date', '(nowScan.date === ptDateStr(getPT()) ? nowScan.hhmm : `${nowScan.date} ${nowScan.hhmm}`)', 'nowScan.hhmm'],
  ['app.js', 'sort', 'marker missing from the Now label', ": earlierCloseTag ? ` ${earlierCloseTag}` : ''}</div>", ": ''}</div>"],
  ['app.js', 'sort', 'intraday tag not passed (fix 4)', '    const intradayLineHtml = renderIntradayLineCard(intradayPanel, earlierCloseTag);', '    const intradayLineHtml = renderIntradayLineCard(intradayPanel);'],
  ['app.js', 'sort', 'intraday renderer drops the tag on the Down line (fix 4)', '% today${floorPart}${tag}</div>`;', '% today${floorPart}</div>`;'],
  ['app.js', 'sort', 'intraday renderer drops the tag on the Up line (fix 4)', '% today${highPart}${tag}</div>`;', '% today${highPart}</div>`;'],
  ['app.js', 'sort', 'no divider', '      html += `<div class="pf-unranked-divider">', '      html += `<div class="x">'],
  // summary
  ['app.js', 'sort', 'unpriced list in visit order', "price unavailable (${[...summaryUnpricedTickers].sort().join(', ')})", "price unavailable (${summaryUnpricedTickers.join(', ')})"],
  ['app.js', 'sort', 'earlier-close list in visit order', "(${[...summaryEarlierCloseTickers].sort().join(', ')})", "(${summaryEarlierCloseTickers.join(', ')})"],
  // the stale state stays display-only
  ['app.js', 'sort', 'stale state wired into priceUnavailable', "    const showsEarlierSessionClose = !priceUnavailable && quoteAge.state === 'EARLIER_SESSION_CLOSE';", "    const showsEarlierSessionClose = !priceUnavailable && quoteAge.state === 'EARLIER_SESSION_CLOSE'; if (showsEarlierSessionClose) priceFetchFailed = true;"],
  // persistence
  ['app.js', 'sort', 'stored mode trusted unvalidated', '  return isPortfolioSort(stored) ? stored : PORTFOLIO_SORT_DEFAULT;', '  return stored || PORTFOLIO_SORT_DEFAULT;'],
  ['app.js', 'sort', 'default changed', "const PORTFOLIO_SORT_DEFAULT = 'TIME_LIMIT';", "const PORTFOLIO_SORT_DEFAULT = 'NEWEST';"],
  // fix 1: named states, read by .state, never by truthiness
  ['core/clock.js', 'sort', 'quote age: session ignored', '  return age >= 1 && inOrAfterSession ? {', '  return age >= 1 ? {'],
  ['core/clock.js', 'sort', 'scanSessionAge: unknown returned as null', "  if (scannedAt == null) return { state: 'UNJUDGED' };", '  if (scannedAt == null) return null;'],
  ['core/clock.js', 'sort', 'dailyBarSessionAge: current returned as false', ": { state: 'CURRENT' };\n}", ': false;\n}'],
  ['app.js', 'sort', 'reader branches on truthiness (displayQuoteAge)', "  if (age.state === 'EARLIER_SESSION') return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };", "  if (age && age.asOf) return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };"],
  ['core/entry-gate.js', 'sort', 'gate branches on truthiness (STALE_DAILY_BAR)', "  if (dailyBarSessionAge(signal).state !== 'EARLIER_SESSION') return null;", '  if (!dailyBarSessionAge(signal).asOf) return null;'],
  ['core/entry-gate.js', 'gate', 'gate: unknown scan time no longer passes', "  if (age.state !== 'PRIOR_SESSION') return null; // CURRENT or UNJUDGED", "  if (age.state === 'CURRENT') return null;"],
  ['core/entry-gate.js', 'gate', 'gate: PRIOR_SESSION never fires', "  if (age.state !== 'PRIOR_SESSION') return null; // CURRENT or UNJUDGED", '  return null;'],
];

const files = [...new Set(M.map(m => m[0]))];
const dirty = files.filter(f => { try { execSync(`git diff --quiet HEAD -- ${f}`, { cwd: ROOT }); return false; } catch (_) { return true; } });
if (dirty.length && !process.argv.includes('--allow-dirty')) {
  console.error(`uncommitted changes in ${dirty.join(', ')}: commit first (or --allow-dirty; the originals are still restored byte for byte)`);
  process.exit(2);
}
const orig = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const restoreAll = () => { for (const f of files) fs.writeFileSync(path.join(ROOT, f), orig[f]); };
process.on('exit', restoreAll);
process.on('SIGINT', () => process.exit(130));

// Baseline: every test passes unmutated, or a "kill" proves nothing.
for (const t of new Set(M.map(m => m[1]))) {
  const r = spawnSync(process.execPath, [TESTS[t]], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 || /^FAIL/m.test(r.stdout + r.stderr)) { console.error(`baseline FAILS: ${TESTS[t]}`); process.exit(2); }
}

let survived = 0;
for (const [file, test, name, from, to] of M) {
  const n = orig[file].split(from).length - 1;
  if (n !== 1) { console.log(`ANCHOR x${n}  ${name}`); survived++; continue; }
  fs.writeFileSync(path.join(ROOT, file), orig[file].replace(from, to));
  const r = spawnSync(process.execPath, [TESTS[test]], { cwd: ROOT, encoding: 'utf8' });
  const killed = r.status !== 0 || /^FAIL/m.test(r.stdout + r.stderr);
  if (!killed) survived++;
  console.log(`${killed ? 'killed  ' : 'SURVIVED'}  ${name}`);
  restoreAll();
}
console.log(`\n${M.length} mutants: ${M.length - survived} killed, ${survived} survived or unanchored`);
process.exitCode = survived ? 1 : 0;
