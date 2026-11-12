// core/scan-history.js — 2026-11-12. Roman's feature: the price EDGE was showing at his recent scans of a ticker.
// Facts only (ruled by the reviewer): prices, ages, and in the modal the change between scans, as text. No colour,
// no arrow, no trend word. It is what the APP showed at each scan, a quote at that moment, never a traded price.
// Pure: no DOM, no network; every time-dependent function takes `nowMs`. Classic script (shared global scope).
//
// SOURCE: rating_snapshots, one row per ticker per scan that scored 60 or more. A scan = a distinct captured_at for
// the ticker (measured 2026-11-12 on the backup at 9d3325a: 627 scans, none holding a ticker twice; de-duplicated
// here anyway). A scan in which the ticker scored under 60 leaves NO row, and browser scans write no scan_runs row,
// so a gap between two points may hide scans: the modal says so.
//
// NO SCORE: rating_snapshots.scoring_version / scoring_hash are NULL on all 4,431 backed-up rows (the writer is on
// the gated branch), and v2 shipped 2026-10-22 inside that range, so no row can say which scoring produced its
// score. A score column would look comparable and not be (reviewer's condition, 2026-11-12): dropped.

// rows: [{ ticker, captured_at, price }] -> Map(ticker -> [{ at: ms, price }]), newest first, one per captured_at.
function scanPointsByTicker(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const at = Date.parse(r.captured_at);
    if (!r.ticker || !Number.isFinite(at) || r.price == null || !Number.isFinite(Number(r.price))) continue;
    const list = by.get(r.ticker) || by.set(r.ticker, new Map()).get(r.ticker);
    if (!list.has(at)) list.set(at, { at, price: Number(r.price) });
  }
  const out = new Map();
  for (const [t, m] of by) out.set(t, [...m.values()].sort((a, b) => b.at - a.at));
  return out;
}

// The PT calendar date of an instant, YYYY-MM-DD (Intl, never a getPT() mutator: CLAUDE.md's rule).
function scanPtDate(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function scanDaysBetween(a, b) { return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000); }

// How long ago, in words that never read like minutes when a day has passed (ruled 2026-11-11).
//   same PT day:      card '41m' / '3h'        modal '41 min ago' / '3 h ago'
//   1-6 days before:  card 'Fri'               modal '3 days ago'   (a weekday, never "yesterday" for a Friday seen
//                                                                     on a Monday; the modal's timestamp names the day)
//   older:            card 'Oct 27'            modal '15 days ago'
//   several shown points on one earlier day: each carries its time (scanCardLabels)
function scanAgeLabel(atMs, nowMs, form) {
  const days = scanDaysBetween(scanPtDate(atMs), scanPtDate(nowMs));
  if (days <= 0) {
    const min = Math.max(0, Math.floor((nowMs - atMs) / 60000));
    if (min < 60) return form === 'modal' ? (min < 1 ? 'under a minute ago' : `${min} min ago`) : (min < 1 ? '<1m' : `${min}m`);
    const h = Math.floor(min / 60);
    return form === 'modal' ? `${h} h ago` : `${h}h`;
  }
  const d = new Date(atMs);
  const weekday = d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
  const monthDay = d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
  const ago = `${days} day${days === 1 ? '' : 's'} ago`;
  // the modal's timestamp already names the weekday and date, so its age is only how long ago (never "Sun ... Sun")
  if (form === 'modal') return ago;
  return days <= 6 ? weekday : monthDay;
}

// A short PT time of day for a card label: '9:14a', '12:55p'.
function scanShortTime(ms) {
  const t = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
  return t.replace(/\s?AM$/, 'a').replace(/\s?PM$/, 'p');
}

// The card labels for the points shown, newest first. Same PT day as now: '41m', '3h'. An earlier day: its weekday or
// date -- and when two or more shown points share an earlier day (Roman scans in bursts), each carries its time, the
// day written once on the newest: 'Nov 2 12:55p · 9:40a · 9:14a' (ruled 2026-11-12: three identical labels hid the
// order). Points are newest first, so a day's first point is its newest.
function scanCardLabels(shown, nowMs) {
  const today = scanPtDate(nowMs);
  const day = p => scanPtDate(p.at);
  const perDay = {};
  for (const p of shown) if (day(p) !== today) perDay[day(p)] = (perDay[day(p)] || 0) + 1;
  const seen = new Set();
  return shown.map(p => {
    const base = scanAgeLabel(p.at, nowMs, 'card');
    const d = day(p);
    if (d === today || perDay[d] < 2) return base;
    const first = !seen.has(d);
    seen.add(d);
    return first ? `${base} ${scanShortTime(p.at)}` : scanShortTime(p.at);
  });
}

const SCAN_HISTORY_SHOWN = 3;

// The points a CARD compares against. Signals: the scans BEFORE the one on screen (ruled 2026-11-12: the card
// already shows the current price), i.e. captured before that scan finished (`beforeMs`, state.lastScanTime); the
// scan's own snapshot row is written after it finished, so it is never one of them. Portfolio: no scan on screen,
// beforeMs null, the latest. Returns { shown: up to 3, eligible: how many exist }.
function scanCardPoints(points, beforeMs) {
  const eligible = (points || []).filter(p => beforeMs == null || p.at < beforeMs);
  return { shown: eligible.slice(0, SCAN_HISTORY_SHOWN), eligible: eligible.length };
}

const fmtScanPrice = p => `$${p.toFixed(2)}`;

// The card's one line, in every state; never blank. status: 'loading' | 'failed' | 'ready'.
// Returns { full, agesOnly }: the renderer shows `full`, and `agesOnly` when `full` would overflow (measured).
function scanCardLine(status, points, beforeMs, nowMs) {
  if (status === 'loading') return { full: 'Scan history loading…', agesOnly: 'Scan history loading…' };
  if (status !== 'ready') return { full: 'Scan history unavailable', agesOnly: 'Scan history unavailable' };
  const { shown, eligible } = scanCardPoints(points, beforeMs);
  if (!shown.length) {
    const t = beforeMs == null ? 'No scans recorded' : 'No earlier scans recorded';
    return { full: t, agesOnly: t };
  }
  const lead = eligible >= SCAN_HISTORY_SHOWN ? (beforeMs == null ? 'Last scans' : 'Earlier scans')
    : `Only ${eligible} ${beforeMs == null ? '' : 'earlier '}scan${eligible === 1 ? '' : 's'}`;
  const labels = scanCardLabels(shown, nowMs);
  return {
    full: `${lead}  ${shown.map((p, i) => `${fmtScanPrice(p.price)} ${labels[i]}`).join(' · ')}`,
    agesOnly: `${lead}  ${labels.join(' · ')}`,
  };
}

// A change between two prices as text: '+$0.07 (+1.7%)', '−$0.07 (−1.7%)', 'no change'. Never coloured.
function scanChangeText(newer, older) {
  const d = newer - older;
  if (Math.abs(d) < 0.005) return 'no change';
  const s = d > 0 ? '+' : '−';
  return `${s}$${Math.abs(d).toFixed(2)} (${s}${Math.abs((d / older) * 100).toFixed(1)}%)`;
}

// The MODAL's rows: the scan on screen (if this ticker has a row from it), marked, then up to 3 before it, each with
// its change from the scan before it (the oldest shown has none: the one before it isn't shown). Plus the total.
function scanModalRows(points, beforeMs) {
  const all = points || [];
  // the scan on screen wrote its row just after it finished: the OLDEST row at or after that moment (a newer one is a
  // later scan, e.g. from another device, and is not the one on screen)
  const after = beforeMs == null ? [] : all.filter(p => p.at >= beforeMs);
  const current = after.length ? after[after.length - 1] : null;
  const earlier = all.filter(p => beforeMs == null || p.at < beforeMs);
  const shown = [...(current ? [{ ...current, current: true }] : []), ...earlier.slice(0, SCAN_HISTORY_SHOWN)];
  return {
    rows: shown.map((p, i) => ({ ...p, change: i + 1 < shown.length ? scanChangeText(p.price, shown[i + 1].price) : null })),
    total: all.length,
    first: all.length ? all[all.length - 1].at : null,
  };
}
