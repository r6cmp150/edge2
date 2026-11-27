#!/usr/bin/env node
// scripts/measure-slack-split.mjs -- 2026-11-27 (the reviewer, CC-here-is-the-raw-cell-and-peak-corrections-is-settled
// §1-2): split each large table's allocated bytes, from one RUN-ME-23 cell, into
//   LIVE     the stored bytes of the live rows (live_data_bytes);
//   INDEX    index_bytes: grows with rows, so it is GROWTH, not slack;
//   OVERHEAD page and TOAST-chunk structure that exists with no update at all, estimated as live x o, where o is read
//            from a table of the same kind that is (almost) never updated (REFERENCE below): growth too;
//   SLACK    the rest: dead row versions and free space, which vacuum reclaims and churn refills (the sawtooth).
// Then the ALLOCATED TREND: each table's live-data rate (scripts/measure-live-bytes.mjs) x (1 + o), plus its index
// bytes per row x its row rate, from the daily backups. That is the growth the quota will see once the sawtooth is
// set aside. Every estimate is named as one. Read only.
//   node scripts/measure-slack-split.mjs --cell <RUN-ME-23 output .json> --cal <rev> --from <rev> --to <rev>
//     --start <YYYY-MM-DD> --db-mb <allocated MB> --cluster-mb <allocated MB>
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TABLES, backupAt, ratios, reaches } from './measure-live-bytes.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// the never-updated table each one's structural overhead is read from: rating_snapshots is its own (1 update in its
// life); the three TOAST-heavy tables take signal_snapshot_at_buy's (0 updates in its life, 2 dead rows)
export const REFERENCE = { rating_snapshots: 'rating_snapshots', signal_snapshot_at_buy: 'signal_snapshot_at_buy', signal_log: 'signal_snapshot_at_buy', trades_v2: 'signal_snapshot_at_buy' };
const nonIndex = t => t.total_bytes - t.index_bytes; // heap + TOAST + the free-space and visibility maps
export const overheadOf = t => nonIndex(t) / t.live_data_bytes - 1;
export function split(cell) {
  const by = Object.fromEntries(cell.public_tables.map(t => [t.table, t]));
  return Object.fromEntries(Object.entries(REFERENCE).map(([name, ref]) => {
    const t = by[name], o = overheadOf(by[ref]);
    const overhead = t.live_data_bytes * o, slack = nonIndex(t) - t.live_data_bytes - overhead;
    return [name, { total: t.total_bytes, live: t.live_data_bytes, index: t.index_bytes, overhead, slack, o, rows: t.rows }];
  }));
}
// MB a calendar day the allocated size grows once slack is set aside
export function allocatedTrend(parts, liveRatePerDay, rowRatePerDay) {
  let sum = 0; const per = {};
  for (const [t, p] of Object.entries(parts)) {
    per[t] = liveRatePerDay[t] * (1 + p.o) + (p.index / p.rows) * rowRatePerDay[t] / 1e6;
    sum += per[t];
  }
  return { sum, per };
}

async function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const cell = JSON.parse(readFileSync(arg('--cell'), 'utf8'));
  const parts = split(cell);
  const mb = x => (x / 1e6).toFixed(2);
  console.log(`CELL read_at ${cell.read_at}, stats_reset ${cell.stats_reset}. Per table, MB (1e6 B):`);
  for (const [t, p] of Object.entries(parts)) console.log(`  ${t}: total ${mb(p.total)} = live ${mb(p.live)} + index ${mb(p.index)} + overhead ${mb(p.overhead)} (o ${(100 * p.o).toFixed(1)}%, from ${REFERENCE[t]}) + SLACK ${mb(p.slack)}`);
  const all = cell.public_tables.reduce((s, t) => s + t.total_bytes, 0), slack = Object.values(parts).reduce((s, p) => s + p.slack, 0);
  console.log(`  all ${cell.public_tables.length} tables: allocated ${mb(all)}; slack in the four ${mb(slack)}`);
  const cal = backupAt(arg('--cal')), r = ratios(Object.fromEntries(TABLES.map(t => [t, parts[t].live / 1e6])), cal.json);
  const at = rev => ({ ...backupAt(rev), at: execSync(`git log -1 --format=%cI ${rev}`, { cwd: ROOT }).toString().trim() });
  const a = at(arg('--from')), b = at(arg('--to')), days = (Date.parse(b.at) - Date.parse(a.at)) / 864e5;
  const liveRate = Object.fromEntries(TABLES.map(t => [t, (b.json[t] - a.json[t]) * r[t] / 1e6 / days]));
  const rowRate = Object.fromEntries(TABLES.map(t => [t, (b.rows[t] - a.rows[t]) / days]));
  const liveSum = Object.values(liveRate).reduce((s, x) => s + x, 0), tr = allocatedTrend(parts, liveRate, rowRate);
  console.log(`WINDOW ${a.at.slice(0, 10)} -> ${b.at.slice(0, 10)} (${days.toFixed(1)} days): live ${liveSum.toFixed(3)} MB/day; ALLOCATED TREND ${tr.sum.toFixed(3)} MB/day [${Object.entries(tr.per).map(([t, x]) => `${t} ${x.toFixed(3)}`).join(', ')}]`);
  const start = arg('--start'), dbMb = Number(arg('--db-mb')), clMb = Number(arg('--cluster-mb'));
  for (const [label, rate] of [['live (slow bound)', liveSum], ['allocated trend (central)', tr.sum], ['allocated slope 1.6 (fast bound)', 1.6]])
    console.log(`  40% (200 MB) at ${label} ${rate.toFixed(2)}/day: database ${reaches(dbMb, start, rate, 200)}, cluster ${reaches(clMb, start, rate, 200)}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
