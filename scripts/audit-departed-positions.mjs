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
// CHECK 2 (classifySnapshots) covers what check 1 can't: every buy since the first
// signal_snapshot_at_buy row (2026-10-29), intraday round trips included, because the
// snapshot is written at the buy, not on a schedule. It prints its own blind period.
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
  // pooled with the exact one. Where the key has more than one candidate row, or more
  // than one departed position, the match could belong to a different position: that is
  // CANNOT TELL, its own tier, never counted as a confirmation (2026-11-08). A row is
  // still consumed, so a further departure on the same key with no row left is missing.
  const key = (ticker, d) => `${ticker}|${String(d || '').slice(0, 10)}`;
  const legacy = new Map();
  for (const t of liveTrades.filter(t => t.position_id == null)) {
    const k = key(t.ticker, t.buy_date);
    legacy.set(k, (legacy.get(k) || []).concat([t]));
  }
  const all = [...seen.values()];
  const stillOpen = all.filter(s => open.has(s.position_id));
  const departed = all.filter(s => !open.has(s.position_id));
  const byId = [], byTickerDate = [], cannotTell = [], missing = [];
  const wantPerKey = new Map();
  for (const s of departed) if (!sold.has(s.position_id)) wantPerKey.set(key(s.ticker, s.buy_date), (wantPerKey.get(key(s.ticker, s.buy_date)) || 0) + 1);
  for (const s of departed.sort((a, b) => a.first.localeCompare(b.first) || a.position_id.localeCompare(b.position_id))) {
    if (sold.has(s.position_id)) { byId.push(s); continue; }
    const k = key(s.ticker, s.buy_date), pool = legacy.get(k) || [];
    if (pool.length) {
      const candidates = pool.length, rivals = wantPerKey.get(k);
      pool.shift();
      if (candidates > 1 || rivals > 1) cannotTell.push({ ...s, candidates, rivals });
      else byTickerDate.push(s);
    } else missing.push(s);
  }
  const neverBackedUp = liveTrades.filter(t => t.position_id != null && !seen.has(String(t.position_id))).length;
  const tradesNoId = liveTrades.filter(t => t.position_id == null).length;
  const legacyUnused = [...legacy.values()].reduce((n, p) => n + p.length, 0);
  const range = versions.length ? [versions.map(v => v.at).sort()[0], versions.map(v => v.at).sort().at(-1)] : [null, null];
  return { backups: versions.length, range, seen: all.length, open: stillOpen.length, departed: departed.length,
    byId: byId.length, byTickerDate: byTickerDate.length, cannotTell, missing, noId, neverBackedUp, tradesNoId, legacyUnused };
}

// CHECK 2 (2026-11-08): the buy snapshots. signal_snapshot_at_buy is written at the buy and
// carries position_id (db/033), on no schedule, so it sees positions bought and sold between
// backups -- the class check 1 is blind to. A snapshot whose position is neither open nor
// sold is a candidate for loss mode B (delete landed, insert failed, queue entry lost).
// Pure: no I/O.
export function classifySnapshots(snaps, livePortfolio, liveTrades) {
  const first = snaps.length ? snaps.map(s => s.captured_at).sort()[0] : null;
  const open = new Set(livePortfolio.map(r => String(r.position_id)));
  const sold = new Map(liveTrades.filter(t => t.position_id != null).map(t => [String(t.position_id), t]));
  const snapIds = new Set(snaps.map(s => String(s.position_id)));
  const stillOpen = snaps.filter(s => open.has(String(s.position_id)));
  const withSale = snaps.filter(s => !open.has(String(s.position_id)) && sold.has(String(s.position_id)));
  const neither = snaps.filter(s => !open.has(String(s.position_id)) && !sold.has(String(s.position_id)));
  // Sales recorded since the first snapshot whose position has none: read the buy, don't guess.
  // Bought before the first snapshot existed = expected; bought after = a buy whose snapshot
  // did not land (the failed-snapshot blind spot, observed).
  const boughtAt = t => t.filled_at || (t.buy_date ? `${String(t.buy_date).slice(0, 10)}T23:59:59Z` : null);
  const noSnap = first ? liveTrades.filter(t => t.position_id != null && t.created_at >= first && !snapIds.has(String(t.position_id))) : [];
  const noSnapBefore = noSnap.filter(t => boughtAt(t) && boughtAt(t) < first);
  const noSnapAfter = noSnap.filter(t => !(boughtAt(t) && boughtAt(t) < first));
  return { snapshots: snaps.length, first, open: stillOpen.length, sold: withSale.length, neither, noSnapBefore, noSnapAfter };
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
  const trades = await fetchAllRows(`${SUPABASE_URL}/rest/v1/trades_v2?select=id,position_id,ticker,buy_date,buy_time,filled_at,sell_date,created_at&order=id`, headers, 'trades_v2 (live)');
  const snaps = await fetchAllRows(`${SUPABASE_URL}/rest/v1/signal_snapshot_at_buy?select=position_id,captured_at,engine_source&order=position_id`, headers, 'signal_snapshot_at_buy (live)', fetch, 'position_id');
  // A positive control: trades_v2 is never empty, and nothing here can tell an empty read from a denied one.
  if (!trades.length) throw new Error('trades_v2 read back empty: a denied read looks the same; refusing to report');
  const r = classify(versions, live, trades);
  console.log(`\nDeparted positions vs trades_v2 -- backups from the repo at ${head}, live read at ${readAt}`);
  console.log(`  backups: ${r.backups} versions of ${BACKUP}, ${r.range[0]} to ${r.range[1]}`);
  console.log(`  positions seen in any backup: ${r.seen}`);
  console.log(`    open now (live portfolio):     ${r.open}`);
  console.log(`    departed: ${r.departed}, in four tiers. They are not added up: each is a different strength of evidence.`);
  console.log(`      CONFIRMED, exact: the sale row carries this position's position_id ........ ${r.byId}`);
  console.log(`      WEAK: no position_id on the sale (before db/033); the only sale row with this`);
  console.log(`        ticker and buy date, and the only departed position with them ............ ${r.byTickerDate}`);
  console.log(`      CANNOT TELL: a ticker + buy-date row exists, but another position or another`);
  console.log(`        row shares the key, so it may belong to a different position .............. ${r.cannotTell.length}`);
  for (const c of r.cannotTell) console.log(`        ${c.ticker} position ${c.position_id}, bought ${c.buy_date}: ${c.candidates} candidate row(s), ${c.rivals} departed position(s) on the key`);
  console.log(`      MISSING: no sale row by position_id, and none by ticker + buy date ........... ${r.missing.length}`);
  for (const m of r.missing) console.log(`        ${m.ticker} position ${m.position_id}, bought ${m.buy_date}, in backups ${m.first} to ${m.last}`);
  console.log('  coverage, not findings:');
  console.log(`    backup rows with no position_id (not matchable): ${r.noId}`);
  console.log(`    trades_v2 sales whose position is in no backup (bought and sold between backups; not checked): ${r.neverBackedUp}`);
  console.log(`    trades_v2 rows with no position_id (before db/033): ${r.tradesNoId}, of which ${r.legacyUnused} matched no backed-up position (bought and sold between backups)`);

  if (!snaps.length) throw new Error('signal_snapshot_at_buy read back empty: a denied read looks the same; refusing to report check 2');
  const s = classifySnapshots(snaps, live, trades);
  console.log(`\nCHECK 2: buy snapshots (signal_snapshot_at_buy) vs live portfolio and trades_v2 -- the check that sees intraday round trips`);
  console.log(`  BLIND: every position bought before the first snapshot, ${s.first}. Loss mode B is UNDETECTABLE there:`);
  console.log(`    no snapshot exists, and check 1 can't see a position bought and sold between backups.`);
  console.log(`  ${s.snapshots} buy snapshots since then:`);
  console.log(`    open now ................................................................ ${s.open}`);
  console.log(`    sold: a trades_v2 row carries its position_id ............................ ${s.sold}`);
  console.log(`    NEITHER open nor sold (a loss mode B candidate) .......................... ${s.neither.length}`);
  for (const n of s.neither) console.log(`      position ${n.position_id}, snapshot ${n.captured_at}, ${n.engine_source || 'engine not recorded'}`);
  console.log(`  sales recorded since the first snapshot whose position has NO snapshot:`);
  console.log(`    bought before the first snapshot existed (expected) ...................... ${s.noSnapBefore.length}`);
  for (const t of s.noSnapBefore) console.log(`      ${t.ticker} position ${t.position_id}, bought ${t.filled_at || t.buy_date}`);
  console.log(`    bought AFTER it: a buy whose snapshot did not land ....................... ${s.noSnapAfter.length}`);
  for (const t of s.noSnapAfter) console.log(`      ${t.ticker} position ${t.position_id}, bought ${t.filled_at || t.buy_date}`);
  console.log('  coverage: a buy whose snapshot failed to write leaves an entry in the phone\'s snapshotWriteFailures');
  console.log('    queue (Retry lands it). It is invisible here only if that entry was also lost: mode B one level down.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
