#!/usr/bin/env node
// How many positions get urgency: null in the portfolio's default sort
// ("Closest to time limit", 2026-11-02)? Runs app.js's OWN
// portfolioUrgencyRatio (extracted by text, never re-implemented) over
// every row, the way renderPortfolioTab keys it: knownNumber(ratio).
//
// Usage:
//   node scripts/count-portfolio-urgency-unknown.mjs --rev <commit>   pinned: data/backups at that commit
//   node scripts/count-portfolio-urgency-unknown.mjs --live           the live tables (not quotable)
// --today YYYY-MM-DD fixes the date the hold is counted to (default: today PT).
import { backupRowsAtRev } from './lib/backup-shards.mjs';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const rev = arg('--rev'), live = arg('--live');
if (!rev === !live) { console.error('pass exactly one of --rev <commit> or --live'); process.exit(2); }

async function rows(table) {
  if (rev) return backupRowsAtRev(rev, table, ROOT);
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=id.asc`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// The real code: core/clock.js, app.js's MAX_HOLD_DAYS and the
// portfolioUrgencyRatio closure from renderPortfolioTab, verbatim.
const app = readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const ratioStart = app.indexOf('  const portfolioUrgencyRatio = (p) => {');
const ratioSrc = app.slice(ratioStart, app.indexOf('\n  };\n', ratioStart) + 5);
const maxLine = app.match(/^const MAX_HOLD_DAYS = .*$/m)[0];
const knownLine = app.match(/^const knownNumber = .*$/m)[0];
if (ratioStart < 0 || !/return daysHeld \/ \(maxHoldDays\[p\.duration\] \|\| 1\);/.test(ratioSrc)) throw new Error('portfolioUrgencyRatio not found as expected');
const ctx = { Date, Math, JSON, Set, Intl, console, Number, String, state: { settings: {} } };
vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(ROOT, 'core/clock.js'), 'utf8'), ctx);
vm.runInContext(`${maxLine}\n${knownLine}\nconst maxHoldDays = MAX_HOLD_DAYS;\n${ratioSrc}\nglobalThis.__key = p => knownNumber(portfolioUrgencyRatio(p));`, ctx);

// Row -> the position fields the ratio reads (core/store.js's mapping).
const toPos = r => ({ engineSource: r.engine_source ?? null, duration: r.duration ?? r.duration_classification ?? null, // trades_v2 names it duration_classification
  buyDate: r.buy_date ? String(r.buy_date).slice(0, 10) : r.buy_date, filledAt: r.filled_at ?? null, orderType: r.order_type ?? null });

const today = arg('--today') || ctx.ptDateStr(ctx.getPT());
if (arg('--today')) { const fixed = new Date(`${today}T19:00:00Z`); const real = ctx.getPT; ctx.getPT = d => real(d ?? fixed); }

const report = (label, list) => {
  const nulls = list.filter(r => ctx.__key(toPos(r)) == null);
  const durations = {};
  for (const r of list) { const d = toPos(r).duration ?? 'null'; durations[d] = (durations[d] || 0) + 1; }
  console.log(`${label}: ${list.length} rows, urgency null: ${nulls.length}`);
  console.log(`  durations: ${JSON.stringify(durations)}`);
  for (const r of nulls) console.log(`  null: id ${r.id} ${r.ticker} duration=${toPos(r).duration} buy_date=${r.buy_date} filled_at=${r.filled_at} engine=${r.engine_source}`);
};

const portfolio = await rows('portfolio');
const sold = await rows('trades_v2');
console.log(`source: ${rev ? 'data/backups @ ' + rev : 'LIVE (not quotable)'}; hold counted to ${today}`);
const pending = portfolio.filter(r => r.order_type != null && r.filled_at == null); // core/orders.js isPendingOrder
report('open holdings (portfolio, pending orders excluded)', portfolio.filter(r => !pending.includes(r)));
report('full history (trades_v2, every sold position)', sold);
