// scripts/lib/sell-time-era.mjs -- which kind of value a trades_v2.sell_time is (2026-11-04).
// Read from the row, never reconstructed from a date against a deploy time:
// sale_code_version.app is the build that ran the sale (db/028). A phone still on a
// cached older build keeps stamping that build, so its rows land in the right era.
//   recording_moment  when the sale was typed in, whatever the column's name says
//   fill              the form's fill time, or NULL when it was not known
// The first build whose sell form takes a fill time:
export const SELL_FILL_FROM_APP = '20261105033000';

export function sellTimeEra(row) {
  const app = row.sale_code_version && row.sale_code_version.app;
  // NULL: a sale from before db/028, which is older than the sell form's fill time.
  return app && app >= SELL_FILL_FROM_APP ? 'fill' : 'recording_moment';
}
