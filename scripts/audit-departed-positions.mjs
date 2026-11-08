#!/usr/bin/env node
// scripts/audit-departed-positions.mjs -- has every position that left the portfolio got
// a sale row? Read-only. (2026-11-08)
//
// Replaces a figure quoted without its method ("236 of 236 departed positions present",
// from a read on 2026-11-07 01:11Z, relayed back through a second party). This recomputes
// it from the repo's own portfolio backups (every committed version of
// data/backups/portfolio.json) and live portfolio + trades_v2, and prints the four counts,
// the backups' date range, and every departed position with no sale row.
//
// WHAT IT CAN SEE, printed with every result: a backup is a snapshot about once a day, so a
// position bought and sold between two backups is in none of them and is not checked here.
// A row in a backup with no position_id can't be matched and is counted, not guessed.
// "Departed" means: in at least one backup, and not in the live portfolio now.
//
//   node scripts/audit-departed-positions.mjs
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchAllRows } from './lib/read-all.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const BACKUP = 'data/backups/portfolio.json';

// versions: [{ sha, at, rows }] in any order. Pure: no I/O.
export function classify(versions, livePortfolio, liveTrades) {
  const seen = new Map();
  let noId = 0;
  for (const v of [...versions].sort((a, b) => a.at.localeCompare(b.at))) {
    for (const r of v.rows) {
      if (r.position_id == null || r.position_id === '') { noId++; continue; }
      const id = String(r.position_id);
      const s = seen.get(id) || { position_id: id, ticker: r.ticker, buy_date: String(r.buy_date || '').slice(0, 10), first: v.at, last: v.at };
      s.last = v.at;
      seen.set(id, s);
    }
  }
  const open = new Set(livePortfolio.map(r => String(r.position_id)));
  const sold = new Map(liveTrades.filter(t => t.position_id != null).map(t => [String(t.position_id), t]));
  // Sales recorded before db/033 have no position_id. For those only, a WEAKER match:
  // ticker + buy date, each sale row used at most once. Reported as its own tier, never
  // pooled with the exact one. A key with more candidates than departures to fill it is
  // still matched one-to-one, but counted as ambiguous: which row is which can't be told.
  const key = (ticker, d) => `${ticker}|${String(d || '').slice(0, 10)}`;
  const legacy = new Map();
  for (const t of liveTrades.filter(t => t.position_id == null)) {
    const k = key(t.ticker, t.buy_date);
    legacy.set(k, (legacy.get(k) || []).concat([t]));
  }
  const all = [...seen.values()];
  const stillOpen = all.filter(s => open.has(s.position_id));
  const departed = all.filter(s => !open.has(s.position_id));
  const byId = [], byTickerDate = [], missing = [];
  const wantPerKey = new Map();
  for (const s of departed) if (!sold.has(s.position_id)) wantPerKey.set(key(s.ticker, s.buy_date), (wantPerKey.get(key(s.ticker, s.buy_date)) || 0) + 1);
  let ambiguous = 0;
  for (const s of departed.sort((a, b) => a.first.localeCompare(b.first) || a.position_id.localeCompare(b.position_id))) {
    if (sold.has(s.position_id)) { byId.push(s); continue; }
    const k = key(s.ticker, s.buy_date), pool = legacy.get(k) || [];
    if (pool.length) {
      if (pool.length > 1 || wantPerKey.get(k) > 1) ambiguous++;
      pool.shift();
      byTickerDate.push(s);
    } else missing.push(s);
  }
  const neverBackedUp = liveTrades.filter(t => t.position_id != null && !seen.has(String(t.position_id))).length;
  const tradesNoId = liveTrades.filter(t => t.position_id == null).length;
  const legacyUnused = [...legacy.values()].reduce((n, p) => n + p.length, 0);
  const range = versions.length ? [versions.map(v => v.at).sort()[0], versions.map(v => v.at).sort().at(-1)] : [null, null];
  return { backups: versions.length, range, seen: all.length, open: stillOpen.length, departed: departed.length,
    byId: byId.length, byTickerDate: byTickerDate.length, ambiguous, missing, noId, neverBackedUp, tradesNoId, legacyUnused };
}

function backupVersions() {
  const log = execSync(`git log --format=%H%x20%cI -- ${BACKUP}`, { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  return log.map(line => {
    const [sha, at] = line.split(' ');
    const text = execSync(`git show ${sha}:${BACKUP}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error(`${sha}:${BACKUP} is not an array`);
    return { sha, at: new Date(at).toISOString(), rows };
  });
}

async function main() {
  const readAt = new Date().toISOString();
  const head = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const versions = backupVersions();
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  const live = await fetchAllRows(`${SUPABASE_URL}/rest/v1/portfolio?select=id,position_id,ticker&order=id`, headers, 'portfolio (live)');
  const trades = await fetchAllRows(`${SUPABASE_URL}/rest/v1/trades_v2?select=id,position_id,ticker,buy_date,sell_date&order=id`, headers, 'trades_v2 (live)');
  // A positive control: trades_v2 is never empty, and nothing here can tell an empty read from a denied one.
  if (!trades.length) throw new Error('trades_v2 read back empty: a denied read looks the same; refusing to report');
  const r = classify(versions, live, trades);
  console.log(`\nDeparted positions vs trades_v2 -- backups from the repo at ${head}, live read at ${readAt}`);
  console.log(`  backups: ${r.backups} versions of ${BACKUP}, ${r.range[0]} to ${r.range[1]}`);
  console.log(`  positions seen in any backup: ${r.seen}`);
  console.log(`    open now (live portfolio):     ${r.open}`);
  console.log(`    departed:                      ${r.departed}`);
  console.log(`      sale row matched by position_id (exact):                       ${r.byId}`);
  console.log(`      sale row matched by ticker + buy date (no position_id; weaker): ${r.byTickerDate}${r.ambiguous ? `, of which ${r.ambiguous} ambiguous (more than one candidate)` : ''}`);
  console.log(`      NO sale row by either:                                          ${r.missing.length}`);
  for (const m of r.missing) console.log(`      ${m.ticker} position ${m.position_id}, bought ${m.buy_date}, in backups ${m.first} to ${m.last}`);
  console.log('  coverage, not findings:');
  console.log(`    backup rows with no position_id (not matchable): ${r.noId}`);
  console.log(`    trades_v2 sales whose position is in no backup (bought and sold between backups; not checked): ${r.neverBackedUp}`);
  console.log(`    trades_v2 rows with no position_id (before db/033): ${r.tradesNoId}, of which ${r.legacyUnused} matched no backed-up position (bought and sold between backups)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
