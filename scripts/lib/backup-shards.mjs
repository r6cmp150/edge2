// scripts/lib/backup-shards.mjs -- monthly backup files for the two tables that
// outgrow one (2026-11-04). GitHub refuses a file over 100 MiB, and a refused
// push loses every table's backup that day, not just the big one's.
// data/backups/signal_log.json was 46.3 MB at f66fe02, growing 2.9 MB a trading
// day. rating_snapshots grows faster than that once every scored row is captured.
//
// data/backups/<table>/YYYY-MM.json is a JSON array with one row per line: half
// the size of the old indented form, and a changed row is a one-line diff. Only
// months whose text changed are rewritten, so old months stop costing git history.
//
// "ONLY NEW ROWS" IS NOT ENOUGH, so a daily read also takes rows that can still
// change. fill-outcomes.mjs PATCHes signal_log for about 7.5 days after insert
// (max lag at 8535a85), and signal_log's ids are UUIDs, so they can't say "new".
// A row is re-read while it is inside the window or not yet settled. A failed
// rating_snapshots batch is retried with its original captured_at, which is why
// that table also reads by id. Once a month a full read takes everything else,
// such as audit-signal-log-splits.mjs's PATCHes, and counts what the daily reads
// had missed (changed_outside_window in the manifest), so the window can be judged.
//
// THE GUARANTEE IS THE TABLE'S ROWS ACROSS ALL ITS FILES, NOT ANY FILE'S SIZE. A
// month's file changing size means nothing. These do, and each refuses the write:
//   - a month file listed in the last manifest is missing or has a different count;
//   - the rows we'd hold (prior + read, by id) aren't exactly the live count: a
//     delete alongside an insert keeps the count level, and this still sees it;
//   - the floor and never-shrink rule in backup-rules.mjs, on the table's total.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { judgeTable } from './backup-rules.mjs';

export const SHARDED = {
  signal_log: { partition: 'created_at', numericId: false, unsettled: 'outcomes_filled_at' },
  rating_snapshots: { partition: 'captured_at', numericId: true, unsettled: null },
};

export const WINDOW_DAYS = 14;
// How far before the last run the window reaches, so a late run can't lose a fill.
export const OVERLAP_DAYS = 2;
// GitHub warns at 50 MiB and blocks at 100 MiB. A table over this is refused here,
// with a reason, rather than letting the push fail for every table.
export const MAX_FILE_BYTES = 90 * 1024 * 1024;
const MONTH_FILE = /^\d{4}-\d{2}\.json$/;

const rowMs = (row, cfg) => {
  const ms = new Date(row[cfg.partition]).getTime();
  if (!Number.isFinite(ms)) throw new Error(`row ${row.id} has no usable ${cfg.partition} (${row[cfg.partition]})`);
  return ms;
};
export const monthOf = (row, cfg) => new Date(rowMs(row, cfg)).toISOString().slice(0, 7);

const byTimeThenId = cfg => (a, b) => rowMs(a, cfg) - rowMs(b, cfg)
  || (cfg.numericId ? a.id - b.id : (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

export const serializeRows = rows => (rows.length ? `[\n${rows.map(r => JSON.stringify(r)).join(',\n')}\n]\n` : '[]\n');

function parseArray(text, label) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`${label} is not valid JSON (${e.message})`); }
  if (!Array.isArray(parsed)) throw new Error(`${label} did not contain a JSON array`);
  return parsed;
}

// What we hold on disk: month files, or the old single file before migration.
// status 'corrupt' blocks the table until someone looks, like any other refusal.
export function readHeld(dir, table, lastShards) {
  const shardDir = path.join(dir, table);
  const legacy = path.join(dir, `${table}.json`);
  try {
    if (existsSync(shardDir)) {
      const files = readdirSync(shardDir).filter(f => MONTH_FILE.test(f)).sort();
      const rows = [], counts = {};
      for (const f of files) {
        const part = parseArray(readFileSync(path.join(shardDir, f), 'utf8'), `${table}/${f}`);
        counts[f.slice(0, 7)] = part.length;
        rows.push(...part);
      }
      for (const [month, n] of Object.entries(lastShards || {})) {
        if (counts[month] !== n) {
          return { status: 'corrupt', reason: `${table}/${month}.json holds ${counts[month] ?? 'no'} rows where the last manifest recorded ${n}` };
        }
      }
      return { status: 'ok', rows, legacy: existsSync(legacy) };
    }
    if (existsSync(legacy)) return { status: 'ok', rows: parseArray(readFileSync(legacy, 'utf8'), `${table}.json`), legacy: true };
  } catch (e) {
    return { status: 'corrupt', reason: e.message };
  }
  return { status: 'absent', rows: [], legacy: false };
}

// The PostgREST filter for a daily read: rows that are new or can still change.
export function dailyFilter(table, held, nowMs, lastRunAt) {
  const cfg = SHARDED[table];
  const lastRunMs = new Date(lastRunAt).getTime();
  const since = Math.min(nowMs - WINDOW_DAYS * 864e5, Number.isFinite(lastRunMs) ? lastRunMs - OVERLAP_DAYS * 864e5 : Infinity);
  const sinceIso = new Date(since).toISOString();
  const parts = [`${cfg.partition}.gte.${sinceIso}`];
  if (cfg.numericId) parts.push(`id.gt.${held.reduce((m, r) => Math.max(m, r.id), 0)}`);
  if (cfg.unsettled) parts.push(`${cfg.unsettled}.is.null`, `${cfg.unsettled}.gte.${sinceIso}`);
  return `or=(${parts.join(',')})`;
}

// Prior + read, by id, judged against the live count. Pure.
export function mergeAndJudge({ table, held, read, live, full }) {
  const cfg = SHARDED[table];
  const merged = new Map(held.map(r => [r.id, r]));
  let changedOutsideWindow = 0;
  for (const r of read) {
    const prior = merged.get(r.id);
    if (full && prior && JSON.stringify(prior) !== JSON.stringify(r)) changedOutsideWindow++;
    merged.set(r.id, r);
  }
  if (merged.size !== live) {
    return { ok: false, retry: true, reason: `the rows we'd hold (${merged.size}) aren't the live count (${live}) -- ${merged.size > live ? 'rows we hold are gone from the table, or the read was denied' : 'the read missed rows'}; nothing written` };
  }
  const verdict = judgeTable(table, merged.size, held.length, {});
  if (!verdict.ok) return { ok: false, retry: false, reason: verdict.reason };
  const rows = [...merged.values()].sort(byTimeThenId(cfg));
  const months = {};
  for (const r of rows) (months[monthOf(r, cfg)] ??= []).push(r);
  const texts = Object.fromEntries(Object.entries(months).map(([m, list]) => [m, serializeRows(list)]));
  const over = Object.entries(texts).find(([, t]) => Buffer.byteLength(t) > MAX_FILE_BYTES);
  if (over) return { ok: false, retry: false, reason: `${table}/${over[0]}.json would be ${Buffer.byteLength(over[1])} bytes, over the ${MAX_FILE_BYTES} limit -- refused so the push doesn't fail for every table` };
  return { ok: true, total: rows.length, texts, counts: Object.fromEntries(Object.entries(months).map(([m, l]) => [m, l.length])), changedOutsideWindow };
}

// One table's run. api = { readRows(table, filterOrNull) -> rows, countRows(table) -> number }.
// Returns the manifest entry, plus writes to make if it passed. Writes nothing itself.
export async function runShardedTable({ table, dir, api, nowMs, last, forceFull = false }) {
  const prior = readHeld(dir, table, last?.shards);
  if (prior.status === 'corrupt') return { ok: false, reason: `corrupt prior backup (${prior.reason})`, entry: { ...keep(last), written: false, reason: prior.reason } };
  const thisMonth = new Date(nowMs).toISOString().slice(0, 7);
  const full = forceFull || prior.status === 'absent' || !existsSync(path.join(dir, table)) || last?.last_full_month !== thisMonth;
  const filter = full ? null : dailyFilter(table, prior.rows, nowMs, last?.run_at);
  let result, read = [], live = 0;
  // Rows arrive while we read (the logger, a scan), so a mismatch gets another look.
  for (let attempt = 1; attempt <= 3; attempt++) {
    read = await api.readRows(table, filter);
    live = await api.countRows(table);
    result = mergeAndJudge({ table, held: prior.rows, read, live, full });
    if (result.ok || !result.retry) break;
  }
  const base = { mode: full ? 'full' : 'daily', read: read.length, live, prior: prior.rows.length };
  if (!result.ok) return { ok: false, reason: result.reason, entry: { ...keep(last), ...base, written: false, reason: result.reason } };
  return {
    ok: true, total: result.total, texts: result.texts, removeLegacy: prior.legacy,
    entry: {
      ...base, fetched: result.total, written: true, reason: null, shards: result.counts,
      last_full_month: full ? thisMonth : last?.last_full_month ?? null,
      changed_outside_window: full ? result.changedOutsideWindow : null,
    },
  };
}
// A refused run must not lose what the next run checks its files against.
const keep = last => (last?.shards ? { shards: last.shards, last_full_month: last.last_full_month ?? null } : {});

// Writes only the months whose text changed. Returns the months written.
export function writeShards(dir, table, texts, removeLegacy) {
  const shardDir = path.join(dir, table);
  mkdirSync(shardDir, { recursive: true });
  const written = [];
  for (const [month, text] of Object.entries(texts)) {
    const f = path.join(shardDir, `${month}.json`);
    if (existsSync(f) && readFileSync(f, 'utf8') === text) continue;
    writeFileSync(f, text);
    written.push(month);
  }
  if (removeLegacy) rmSync(path.join(dir, `${table}.json`));
  return written;
}

// For readers: a table's rows from a working tree, either layout.
export function readBackupRows(dir, table) {
  const held = SHARDED[table] ? readHeld(dir, table) : { status: existsSync(path.join(dir, `${table}.json`)) ? 'ok' : 'absent', rows: null };
  if (held.status === 'corrupt') throw new Error(held.reason);
  if (held.status === 'absent') throw new Error(`no backup of ${table} in ${dir}`);
  return held.rows ?? parseArray(readFileSync(path.join(dir, `${table}.json`), 'utf8'), `${table}.json`);
}

// For readers: a table's rows at a commit, either layout, so a figure stays
// pinned to a commit on both sides of the move to month files.
export function backupRowsAtRev(rev, table, cwd) {
  const sh = c => execSync(c, { cwd, maxBuffer: 2e9, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = sh(`git ls-tree -r --name-only ${rev} data/backups/${table}/`).split('\n').filter(f => /\/\d{4}-\d{2}\.json$/.test(f));
  if (files.length) return files.flatMap(f => parseArray(sh(`git show ${rev}:${f}`), f));
  const j = JSON.parse(sh(`git show ${rev}:data/backups/${table}.json`));
  return Array.isArray(j) ? j : j.rows;
}
