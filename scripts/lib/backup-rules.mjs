// scripts/lib/backup-rules.mjs -- the backup's per-table rules and floors
// (2026-11-02), separated from scripts/backup-tables.mjs so tests can import
// them without running a backup. backup-tables.mjs runs main()
// unconditionally: a "run only when executed" guard that ever misfired
// would make CI report a successful backup of nothing.

// Each rule returns { ok: true } to write normally, or
// { ok: false, reason } to skip writing this table this run. A rule may
// also just console.warn for a non-blocking flag (portfolio) without
// affecting ok.
export const TABLE_RULES = {
  trades(fresh, prior) {
    if (fresh < prior) {
      return { ok: false, reason: `shrank from ${prior} to ${fresh} rows -- trades is append-only with no delete call site anywhere in the app; any shrink means something is wrong, not normal usage` };
    }
    return { ok: true };
  },
  // trades_v2/signal_log (Phase 9 §1.5, 2026-09-15): the two tables Phase 7
  // created and everything now writes to -- unbacked until this change.
  // Same never-shrink posture as `trades` above, same reason: both are
  // append-only with no delete call site anywhere in the app.
  trades_v2(fresh, prior) {
    if (fresh < prior) {
      return { ok: false, reason: `shrank from ${prior} to ${fresh} rows -- trades_v2 is append-only with no delete call site anywhere in the app; any shrink means something is wrong, not normal usage` };
    }
    return { ok: true };
  },
  signal_log(fresh, prior) {
    if (fresh < prior) {
      return { ok: false, reason: `shrank from ${prior} to ${fresh} rows -- signal_log is append-only with no delete call site anywhere in the app; any shrink means something is wrong, not normal usage` };
    }
    return { ok: true };
  },
  settings(fresh, _prior) {
    if (fresh < 1) {
      return { ok: false, reason: `dropped to ${fresh} rows -- settings is a single-row table; anything below 1 means something is wrong` };
    }
    return { ok: true };
  },
  portfolio(fresh, prior, ctx) {
    if (fresh === 0 && prior > 0) {
      console.warn(`backup-tables: FLAG -- portfolio dropped to 0 rows (was ${prior}). Not blocked -- shrinking is normal (every sale deletes a row) -- but every position closing at once is unusual enough to be worth a glance.`);
    }
    // EXCEPT an empty read that nothing corroborates (2026-11-02). N real
    // holdings can only reach 0 through N sales, and every sale is a new
    // trades_v2 row; an RLS-denied read reaches 0 with no new sales. So 0
    // rows when the last backup held N holdings (pending orders excluded:
    // cancelling one deletes its row with no sale) needs trades_v2 to have
    // grown by at least N since the last backup.
    if (fresh === 0 && ctx && ctx.priorHoldings > 0) {
      const newSales = ctx.tradesV2Fresh - ctx.tradesV2Prior;
      if (!(newSales >= ctx.priorHoldings)) {
        return { ok: false, reason: `read back EMPTY with ${ctx.priorHoldings} holding(s) in the last backup and only ${Number.isFinite(newSales) ? newSales : 'an unknown number of'} new sale(s) in trades_v2 since -- that is an empty read (a permission or RLS denial returns an empty list, not an error), not ${ctx.priorHoldings} sales` };
      }
    }
    return { ok: true }; // otherwise never aborts: shrinking is this table's normal operation
  },
  // signal_snapshot_at_buy (db/033, added here 2026-11-01): one row per
  // position, never updated or deleted (anon has INSERT and SELECT only,
  // db/034), so the same never-shrink posture. Unbacked from creation
  // until 88 rows had accumulated, so nothing read from it could be
  // pinned to a commit.
  signal_snapshot_at_buy(fresh, prior) {
    if (fresh < prior) {
      return { ok: false, reason: `shrank from ${prior} to ${fresh} rows -- signal_snapshot_at_buy has no UPDATE or DELETE policy (db/034); any shrink means something is wrong` };
    }
    return { ok: true };
  },
  rating_snapshots(fresh, prior) {
    if (fresh < prior) {
      return { ok: false, reason: `shrank from ${prior} to ${fresh} rows -- rating_snapshots is append-only since 2026-11-02 (no purge call site left in the app); any shrink means something deleted rows` };
    }
    return { ok: true };
  },
};

// FLOORS (2026-11-02): a plausible minimum for EVERY table, checked before
// its rule. RLS answers a read it won't allow with an EMPTY LIST, not an
// error, so a policy mistake (ours or Supabase's) would otherwise produce a
// "successful" backup of nothing. The shrink rules catch that for the
// append-only tables only while a prior backup file exists; a missing or
// first file has no prior count. These floors don't depend on the prior
// file. Values: the committed row counts at d6e277d (2026-11-02) for tables
// that only grow; raise them as history grows, never lower them without a
// recorded reason. portfolio's floor is 0 (holding nothing is legitimate):
// its empty read is judged by corroboration instead (TABLE_RULES.portfolio).
export const MIN_ROWS = {
  trades: 37,
  trades_v2: 451,
  signal_log: 1938,
  settings: 1,
  portfolio: 0,
  rating_snapshots: 2944,
  signal_snapshot_at_buy: 88,
};

// The unique key each whole-file table's paged read orders on (2026-11-04). Without an
// ORDER BY Postgres guarantees no order, so pages can skip or repeat rows while the row
// count still matches. signal_snapshot_at_buy has no id column. For trades, portfolio and
// settings there is no CREATE in db/, so uniqueness is not known from the schema, and a
// repeated key in the read is refused rather than trusted.
export const WHOLE_FILE_KEY = { trades: 'id', trades_v2: 'id', settings: 'id', portfolio: 'id', signal_snapshot_at_buy: 'position_id' };
export const repeatedKeys = (rows, key) => rows.length - new Set(rows.map(r => r[key])).size;

// Holdings in a portfolio backup: rows that aren't pending orders (core/
// orders.js isPendingOrder: an order type with no fill).
export const holdingsIn = rows => (rows || []).filter(r => !(r.order_type != null && r.filled_at == null)).length;

// A table's verdict: the floor first (independent of any prior file), then
// its own rule.
export function judgeTable(table, freshCount, priorCount, ctx) {
  const floor = MIN_ROWS[table];
  if (!(freshCount >= floor)) {
    return { ok: false, reason: `read back ${freshCount} rows, below this table's floor of ${floor} -- an empty or truncated read (RLS returns an empty list, not an error), not a real state of the data` };
  }
  return TABLE_RULES[table](freshCount, priorCount, ctx);
}
