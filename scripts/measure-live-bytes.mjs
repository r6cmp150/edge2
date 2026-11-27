#!/usr/bin/env node
// scripts/measure-live-bytes.mjs -- 2026-11-27 (the reviewer, CC-the-growth-is-largely-slack-reproject-from-live-bytes
// §2): the database's LIVE-data trend, separate from its ALLOCATED size. Allocated bytes (pg_total_relation_size, what
// the quota counts) mix a trend with a sawtooth: dead row versions and free space accumulate between vacuums and are
// reclaimed by them. Live bytes are the trend.
//
// Method: the daily backups hold every row of each table, so their JSON bytes are a daily series. A direct reading of
// live_data_bytes (RUN-ME-23, sum of pg_column_size over the rows, as stored) calibrates each table's stored/JSON ratio
// at one backup; the series is converted with that ratio. ASSUMES the ratio holds over the window (the rows' make-up
// does not change); a second direct reading tests it. Calendar days, because a date projection runs on calendar days.
// Read only.
//   node scripts/measure-live-bytes.mjs --cal <rev> --live signal_log=20.52,rating_snapshots=5.85,... [--since 2026-11-04]
//     [--from <rev> --to <rev>]   (live values in MB of 1e6 bytes)
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TABLES = ['signal_log', 'rating_snapshots', 'signal_snapshot_at_buy', 'trades_v2'];
const FILES = {
  signal_log: 'monthly', rating_snapshots: 'monthly',
  signal_snapshot_at_buy: 'data/backups/signal_snapshot_at_buy.json', trades_v2: 'data/backups/trades_v2.json',
};
// stored live bytes per JSON byte, per table, at the calibration point
export function ratios(live, jsonAtCal) {
  return Object.fromEntries(Object.keys(live).map(t => {
    if (!(jsonAtCal[t] > 0)) throw new Error(`${t}: no JSON bytes at the calibration backup`);
    return [t, (live[t] * 1e6) / jsonAtCal[t]];
  }));
}
export const liveMB = (json, ratio) => Object.keys(ratio).reduce((s, t) => s + json[t] * ratio[t], 0) / 1e6;
// MB a calendar day between two points of the series
export const slope = (a, b, ratio) => (liveMB(b.json, ratio) - liveMB(a.json, ratio)) / ((Date.parse(b.at) - Date.parse(a.at)) / 864e5);
// the calendar date a size reaches `target` MB from `startMB` on `startDay` at `perDay`
export function reaches(startMB, startDay, perDay, target) {
  if (!(perDay > 0)) return null;
  return new Date(Date.parse(startDay) + ((target - startMB) / perDay) * 864e5).toISOString().slice(0, 10);
}

// JSON bytes and row counts per table at one backup commit (the backups are full copies of every row)
export function backupAt(rev) {
  const sh = c => execSync(c, { cwd: ROOT, maxBuffer: 4e9 }).toString();
  const json = {}, rows = {};
  for (const t of TABLES) {
    const files = FILES[t] === 'monthly' ? sh(`git ls-tree --name-only ${rev} data/backups/${t}/`).trim().split('\n').filter(Boolean) : [FILES[t]];
    let b = 0, n = 0;
    for (const f of files) {
      let txt; try { txt = sh(`git show ${rev}:${f}`); } catch { continue; }
      const j = JSON.parse(txt);
      for (const r of (Array.isArray(j) ? j : j.rows || [])) { b += Buffer.byteLength(JSON.stringify(r)); n++; }
    }
    json[t] = b; rows[t] = n;
  }
  return { json, rows };
}
const jsonAt = rev => backupAt(rev).json;

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const cal = arg('--cal'), liveArg = arg('--live');
  if (!cal || !liveArg) throw new Error('usage: --cal <rev> --live table=MB,...');
  const live = Object.fromEntries(liveArg.split(',').map(kv => kv.split('=')).map(([k, v]) => [k, Number(v)]));
  const r = ratios(live, jsonAt(cal));
  console.log(`CALIBRATION @ ${cal}: stored live / JSON = ${Object.entries(r).map(([t, x]) => `${t} ${x.toFixed(3)}`).join('; ')}`);
  const revs = execSync(`git log --format="%h %cI" --since=${arg('--since') || '2026-11-04'} -- data/backups/_manifest.json`, { cwd: ROOT }).toString().trim().split('\n').map(l => l.split(' ')).reverse();
  const series = revs.map(([rev, at]) => ({ rev, at, json: jsonAt(rev) }));
  for (const p of series) console.log(`  ${p.at.slice(0, 16)}Z ${p.rev}: live ${liveMB(p.json, r).toFixed(2)} MB (the ${Object.keys(r).length} tables)`);
  const from = series.find(p => p.rev === arg('--from')) || series[0], to = series.find(p => p.rev === arg('--to')) || series[series.length - 1];
  console.log(`LIVE TREND ${from.at.slice(0, 10)} -> ${to.at.slice(0, 10)}: ${slope(from, to, r).toFixed(3)} MB a calendar day`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
