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
//
// Every kill is reported with the tests that failed. LINT tests (source-text
// checks) are named in LINT_TESTS; a mutant marked `behavioural` counts as
// killed only if a NON-lint test fails, i.e. the code's behaviour changed
// and a test saw it.
//
// Removed 2026-11-02, as not mutations: `!dailyBarSessionAge(signal).asOf`
// for the gate's `.state !== 'EARLIER_SESSION'`, and `age && age.asOf` for
// displayQuoteAge's `age.state === 'EARLIER_SESSION'`. Both are EQUIVALENT
// rewrites, not missing fixtures: asOf is set only on EARLIER_SESSION, which
// needs age >= 1, which needs a parseable bar date, so asOf is then always a
// non-empty date and no input can tell the two apart. Replaced by the
// realistic mistake, testing .state by truthiness, which behaves differently.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LINT_TESTS = [/three NAMED states/, /^wiring:/];
const TESTS = {
  sort: 'tests/portfolio-sort.test.js',
  gate: 'tests/prior-session-daily-bar.test.js',
  sold: 'tests/portfolio-price-unavailable.test.js',
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
  // .state tested by truthiness (true for every state): must change behaviour
  ['app.js', 'sort', '.state truthiness: displayQuoteAge', "  if (age.state === 'EARLIER_SESSION') return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };", "  if (age.state) return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };", { behavioural: true }],
  ['app.js', 'sort', '.state truthiness: portfolioScoreState PRIOR_SESSION', "  if (age.state === 'PRIOR_SESSION') return { score: null, unknown: `scanned before", "  if (age.state) return { score: null, unknown: `scanned before", { behavioural: true }],
  ['core/entry-gate.js', 'gate', '.state truthiness: gate STALE_DAILY_BAR', "  if (dailyBarSessionAge(signal).state !== 'EARLIER_SESSION') return null;", '  if (!dailyBarSessionAge(signal).state) return null;', { behavioural: true }],
  ['core/entry-gate.js', 'gate', '.state truthiness: gate PRIOR_SESSION', "  if (age.state !== 'PRIOR_SESSION') return null; // CURRENT or UNJUDGED", '  if (!age.state) return null;', { behavioural: true }],
  ['core/entry-gate.js', 'sort', '.state truthiness: gate PRIOR_SESSION, seen at the HHH row', "  if (age.state !== 'PRIOR_SESSION') return null; // CURRENT or UNJUDGED", '  if (!age.state) return null;', { behavioural: true }],
  ['app.js', 'sort', 'unknown scan time ranked, seen at the HHH row', "  if (age.state === 'UNJUDGED') return { score: null, unknown: 'scan time not recorded' };", '', { behavioural: true }],
  ['core/entry-gate.js', 'gate', 'gate: unknown scan time no longer passes', "  if (age.state !== 'PRIOR_SESSION') return null; // CURRENT or UNJUDGED", "  if (age.state === 'CURRENT') return null;"],
  // exit side (2026-11-02): a display is qualified, a record withheld, a verdict never blocked
  ['app.js', 'sort', 'EDGE verdict blocked on an earlier close', 'calcUnifiedRecommendation({ ...p, currentPrice, rsi, priceFetchFailed: priceUnavailable }', 'calcUnifiedRecommendation({ ...p, currentPrice, rsi, priceFetchFailed: priceUnavailable || showsEarlierSessionClose }', { behavioural: true }],
  ['app.js', 'sort', 'engine verdict blocked on an earlier close', '      const exitResult = priceUnavailable\n', '      const exitResult = (priceUnavailable || showsEarlierSessionClose)\n', { behavioural: true }],
  ['app.js', 'sort', 'EDGE verdict not marked', 'portBanner = buildUnifiedPortfolioBanner(unifiedResult, earlierCloseTag);', 'portBanner = buildUnifiedPortfolioBanner(unifiedResult);', { behavioural: true }],
  ['app.js', 'sort', 'engine verdict not marked', 'portBanner = buildRegisteredEngineExitBanner(exitResult, earlierCloseTag);', 'portBanner = buildRegisteredEngineExitBanner(exitResult);', { behavioural: true }],
  ['app.js', 'sort', 'banner builder: hard floor drops the tag', '<strong>${result.label}</strong>${priceBasisLine(priceTag)}</div>`;', '<strong>${result.label}</strong></div>`;', { behavioural: true }],
  ['app.js', 'sort', 'banner builder: lock-in drops the tag', '      <div class="ur-exit-window">This is the exit window — consider selling now</div>\n      ${priceBasisLine(priceTag)}', '      <div class="ur-exit-window">This is the exit window — consider selling now</div>', { behavioural: true }],
  ['app.js', 'sort', 'Mark as Sold pre-fills the earlier close (a record from a stale quote)', "${(priceUnavailable || showsEarlierSessionClose) ? 'null' : currentPrice}", "${priceUnavailable ? 'null' : currentPrice}", { behavioural: true }],
  ['app.js', 'sort', 'Mark as Sold not told which close was withheld', "${showsEarlierSessionClose ? `'${quoteAge.asOf}'` : 'null'})\">Mark as sold", "null)\">Mark as sold", { behavioural: true }],
  ['app.js', 'sold', 'Mark as Sold notice says "no live price" for a withheld close', "${withheldCloseAsOf ? `The only price available is", "${false ? `The only price available is", { behavioural: true }],
  ['app.js', 'sort', 'nav badge drops an earlier-close warning (blocking by omission)', "        const onEarlierClose = cached.quoteAge.state === 'EARLIER_SESSION_CLOSE';", "        const onEarlierClose = cached.quoteAge.state === 'EARLIER_SESSION_CLOSE'; if (onEarlierClose) return;", { behavioural: true }],
  ['app.js', 'sort', 'nav badge not marked', "    pfBadge.classList.toggle('badge-earlier-close', earlierCloseWarnCount > 0);", "    pfBadge.classList.toggle('badge-earlier-close', false);", { behavioural: true }],
  ['app.js', 'sort', 'badge cache drops the state (bare number again)', 'else state.portfolioPrices[p.ticker] = { price: currentPrice, quoteAge };', 'else state.portfolioPrices[p.ticker] = { price: currentPrice, quoteAge: { state: "UNJUDGED" } };', { behavioural: true }],
  // LINT-required (2026-11-02): equivalent TODAY, so no behaviour test can
  // see them; they are what the lint exists for (state from .state alone).
  ['core/entry-gate.js', 'sort', 'lint: gate branches on a payload field (!x.asOf)', "  if (dailyBarSessionAge(signal).state !== 'EARLIER_SESSION') return null;", '  if (!dailyBarSessionAge(signal).asOf) return null;', { lint: true }],
  ['app.js', 'sort', 'lint: reader branches on age && age.asOf', "  if (age.state === 'EARLIER_SESSION') return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };", "  if (age && age.asOf) return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };", { lint: true }],
  ['app.js', 'sort', 'lint: reader branches on a payload field (if (age.asOf))', "  if (age.state === 'EARLIER_SESSION') return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };", "  if (age.asOf) return { state: 'EARLIER_SESSION_CLOSE', asOf: age.asOf };", { lint: true }],
  // the producer invariant (2026-11-02): payload only on the stale state
  ['core/clock.js', 'sort', 'producer: CURRENT carries asOf too', "? { state: 'EARLIER_SESSION', asOf: fresh.dailyBarAsOf } : { state: 'CURRENT' };", "? { state: 'EARLIER_SESSION', asOf: fresh.dailyBarAsOf } : { state: 'CURRENT', asOf: fresh.dailyBarAsOf };"],
  ['core/clock.js', 'sort', 'producer: CURRENT carries openDate too', "return { state: 'CURRENT' };\n  return { state: 'PRIOR_SESSION'", "return { state: 'CURRENT', openDate };\n  return { state: 'PRIOR_SESSION'"],
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
for (const [file, test, name, from, to, opts = {}] of M) {
  const n = orig[file].split(from).length - 1;
  if (n !== 1) { console.log(`ANCHOR x${n}  ${name}`); survived++; continue; }
  fs.writeFileSync(path.join(ROOT, file), orig[file].replace(from, to));
  const r = spawnSync(process.execPath, [TESTS[test]], { cwd: ROOT, encoding: 'utf8' });
  const failed = [...(r.stdout + r.stderr).matchAll(/^FAIL: (.*)$/gm)].map(m => m[1]);
  const behaviourFails = failed.filter(t => !LINT_TESTS.some(re => re.test(t)));
  const crashed = r.status !== 0 && !failed.length;
  const lintFails = failed.length - behaviourFails.length;
  const killed = opts.behavioural ? (behaviourFails.length > 0 || crashed)
    : opts.lint ? lintFails > 0
    : (failed.length > 0 || crashed);
  if (!killed) survived++;
  const by = crashed ? 'crash' : `${behaviourFails.length} behavioural, ${failed.length - behaviourFails.length} lint`;
  console.log(`${killed ? 'killed  ' : 'SURVIVED'}  ${name}${opts.behavioural ? ' [behavioural required]' : opts.lint ? ' [lint required]' : ''}  (${by})`);
  restoreAll();
}
console.log(`\n${M.length} mutants: ${M.length - survived} killed, ${survived} survived or unanchored`);
process.exitCode = survived ? 1 : 0;
