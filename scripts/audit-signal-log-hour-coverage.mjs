#!/usr/bin/env node
// Which PT hours of the trading day does signal_log actually cover?
// (2026-11-02.) The EDGE logger runs on GitHub's scheduler, which delivers
// hours late, so its rows sit wherever the queue happened to land them.
// Every signal_log-derived conclusion inherits that distribution. This
// counts rows (and distinct scans) per engine x date x PT hour of the row's
// created_at (the scan's insert time), plus an hour totals table, overall
// and for rows up to a cutoff date (--asof, e.g. the date a finding was
// computed on).
//
//   node scripts/audit-signal-log-hour-coverage.mjs --rev <commit> [--asof YYYY-MM-DD] [--engine EDGE]
import { backupRowsAtRev } from './lib/backup-shards.mjs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const rev = arg('--rev'), asof = arg('--asof'), engine = arg('--engine') || 'EDGE';
if (!rev) { console.error('usage: --rev <commit> [--asof YYYY-MM-DD] [--engine EDGE|WARRIOR]'); process.exit(2); }

const raw = backupRowsAtRev(rev, 'signal_log', ROOT);
const all = raw.filter(r => r.engine_source === engine);
const pt = iso => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

function table(rows, title) {
  const byHour = {}, byDate = {};
  for (const r of rows) {
    const { date, hour } = pt(r.created_at);
    (byHour[hour] ??= { rows: 0, scans: new Set(), dates: new Set() });
    byHour[hour].rows++; byHour[hour].scans.add(r.scan_session); byHour[hour].dates.add(date);
    ((byDate[date] ??= {})[hour] ??= { rows: 0, scans: new Set() });
    byDate[date][hour].rows++; byDate[date][hour].scans.add(r.scan_session);
  }
  const dates = Object.keys(byDate).sort();
  console.log(`\n=== ${title}: ${rows.length} ${engine} rows, ${dates.length} dates, ${new Set(rows.map(r => r.scan_session)).size} scans ===`);
  console.log('PT hour | rows | scans | dates with a scan in this hour');
  for (let h = 0; h < 24; h++) {
    const b = byHour[h]; if (!b) continue;
    console.log(`${String(h).padStart(2, '0')}:00   | ${String(b.rows).padStart(5)} | ${String(b.scans.size).padStart(5)} | ${b.dates.size} of ${dates.length}`);
  }
  console.log('\nper date (PT hour: rows/scans)');
  for (const d of dates) console.log(`${d}  ${Object.keys(byDate[d]).map(Number).sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}h:${byDate[d][h].rows}/${byDate[d][h].scans.size}`).join('  ')}`);
}

console.log(`source: data/backups/signal_log.json @ ${rev} (pinned); created_at in PT`);
table(all, 'all rows');
if (asof) table(all.filter(r => r.signal_date <= asof), `rows with signal_date <= ${asof}`);
