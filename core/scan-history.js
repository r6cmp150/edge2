// core/scan-history.js — 2026-11-12. Roman's feature: the price EDGE was showing at his recent scans of a ticker.
// Facts only (ruled by the reviewer): prices, ages, and in the modal the change between scans, as text. No colour,
// no arrow, no trend word. It is what the APP showed at each scan, a quote at that moment, never a traded price.
// Pure: no DOM, no network; every time-dependent function takes `nowMs`. Classic script (shared global scope).
//
// SOURCE: rating_snapshots, one row per ticker per scan that SCORED it. A scan = a distinct captured_at for the
// ticker (measured 2026-11-12 on the backup at 9d3325a: 627 scans, none holding a ticker twice; de-duplicated here
// anyway). Which scans leave a row for a ticker (corrected 2026-11-27; this header said "scored 60 or more", true
// when written and false from 2026-11-13 02:35Z, when writeRatingSnapshots began writing every scored row, any score,
// with its tier):
//   - a scan covers ONE universe list, the one selected (setUniverse runs a scan of that list only), so a ticker gets
//     a row only in scans of a list it is on. Scans of his other lists never fetch its price: there is nothing to
//     record. Measured on the backup at b786b78: across 95 ticker-days he bought on from 11-13, 778 of 784 scans of
//     the stock's own list left a row (99.2%), and that was 13.4% of all his scans (5,798), since he taps through
//     nine lists seconds apart. This, not a score filter, is why the points are spaced as they are.
//   - in a scan of its list, only if it passed the price/volume prefilter and could be scored (6 of the 784 missed).
//   - before 2026-11-13 02:35Z, only shown rows scoring 60 or more were written (those rows have tier NULL).
// Browser scans write no scan_runs row, so a gap between two points may hide scans: the modal says so.
//
// NO SCORE: rows before 2026-11-13 02:35Z carry no scoring_version / scoring_hash (4,431 of them NULL at 9d3325a),
// and v2 shipped 2026-10-22 inside that range, so those rows cannot say which scoring produced their score; rows
// since then carry it (2 or 3, every row at b786b78). A score column mixing the two would look comparable and not
// be (reviewer's condition, 2026-11-12): dropped. (Comment facts corrected 2026-11-27; the decision is unchanged.)

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

// The card labels for the points shown, in DISPLAY order: OLDEST FIRST, left to right (Roman, 2026-11-26: oldest on
// the left, newest on the right, so a rise reads as a rise). Same PT day as now: '41m', '3h'. An earlier day: its
// weekday or date. When two or more shown points would carry the same label -- several on one earlier day (Roman scans
// in bursts; ruled 2026-11-12: three identical labels hid the order), or two today in the same hour ('1h · 1h' for
// points thirty minutes apart; the reviewer, 2026-11-26) -- each carries its time, the shared label written once, on
// the leftmost: 'Nov 2 9:14a · 9:40a · 12:55p', '1h 10:05a · 10:35a'.
function scanCardLabels(shown, nowMs) {
  const today = scanPtDate(nowMs);
  const base = shown.map(p => scanAgeLabel(p.at, nowMs, 'card'));
  // today's points collide only when their labels are equal; an earlier day's always share the day's label
  const key = (p, i) => (scanPtDate(p.at) === today ? `today ${base[i]}` : scanPtDate(p.at));
  const count = {};
  shown.forEach((p, i) => { count[key(p, i)] = (count[key(p, i)] || 0) + 1; });
  const seen = new Set();
  return shown.map((p, i) => {
    const k = key(p, i);
    if (count[k] < 2) return base[i];
    const first = !seen.has(k);
    seen.add(k);
    return first ? `${base[i]} ${scanShortTime(p.at)}` : scanShortTime(p.at);
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
  // "Recent", not "Last" (2026-11-26): with the oldest on the left, "Last scans" would put the least recent point
  // where the eye reads "last". "Earlier" (Signals) still says what it means: these came before the scan on screen.
  const lead = eligible >= SCAN_HISTORY_SHOWN ? (beforeMs == null ? 'Recent scans' : 'Earlier scans')
    : `Only ${eligible} ${beforeMs == null ? '' : 'earlier '}scan${eligible === 1 ? '' : 's'}`;
  const ordered = [...shown].reverse(); // oldest on the left, newest on the right
  const labels = scanCardLabels(ordered, nowMs);
  return {
    full: `${lead}  ${ordered.map((p, i) => `${fmtScanPrice(p.price)} ${labels[i]}`).join(' · ')}`,
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
// Returned newest first; the modal DISPLAYS them oldest at the top (app.js scanHistoryModalHtml, 2026-11-26).
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
