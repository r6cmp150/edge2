// core/orders.js — order vs fill (db/027; docs/phase-9-entry-exit-spec.md §4.8).
//
// After db/027 a `portfolio` row is either a HOLDING or a PENDING ORDER.
// One predicate decides which, here, and nothing outside persistence reads
// state.portfolio directly: every reader goes through getHoldings() or
// getPendingOrders(). A pending order is not a position -- no return, no
// P&L, no hold time, no recommendation, no Sell.
//
// Also the single implementation of the fill rule at entry, shared by every
// add-position form (EDGE in app.js, Warrior in engines/warrior/index.js --
// engines may use core/, never the reverse):
//   market + REGULAR session -> filled now
//   market + PRE_MARKET / AFTER_HOURS / CLOSED -> pending until marked.
//     Overnight: Roman's broker takes LIMIT orders only (confirmed with him
//     2026-10-09). Pre-market / after-hours: NOT YET CONFIRMED what it does
//     with a plain market order -- many brokers queue it for the open or
//     require a limit. The error is asymmetric: a wrongly-pending order
//     costs one tap on Mark filled; a wrongly-filled one puts a fabricated
//     timestamp in filled_at, the column every hold-time figure runs from,
//     permanently and indistinguishably. So pending until Roman confirms.
//     (Real extended-hours FILLS exist -- 10 of his first 37 buys -- but that
//     doesn't establish they were market orders filled on placement.)
//   limit / stop / stop_limit / trailing_stop -> pending until marked filled
//     (none fills on placement), unless Roman says it already has
//   entered after the fact (order date isn't today) -> he gives the fill
//     time, or says it's still pending; never guessed.
// Holds the invariant db/027 relies on: for every new row, filledAt null
// means exactly "not filled".

const ORDER_TYPES = [
  ['market', 'Market'],
  ['limit', 'Limit'],
  ['stop', 'Stop'],
  ['stop_limit', 'Stop limit'],
  ['trailing_stop', 'Trailing stop'],
];
const ORDER_TYPE_LABEL = Object.fromEntries(ORDER_TYPES);

function isPendingOrder(p) {
  return p.orderType != null && p.filledAt == null; // legacy rows (orderType null) are holdings
}
function getHoldings() {
  return state.portfolio.filter(p => !isPendingOrder(p));
}
function getPendingOrders() {
  return state.portfolio.filter(isPendingOrder);
}

// Stale = the order has sat through at least one full market close since it
// was placed: a day order would have expired, a closed-market market order
// should have filled at the open. The app can't know what the broker did, so
// it never changes the order itself -- it keeps asking.
function isStalePendingOrder(p) {
  return isPendingOrder(p) && marketClosesHeld(p.buyDate, ptDateStr(getPT())) >= 1;
}

function _ptNow() {
  const pt = getPT();
  return { date: ptDateStr(pt), hhmm: `${String(pt.getHours()).padStart(2, '0')}:${String(pt.getMinutes()).padStart(2, '0')}` };
}

// What the form should do for this order type + order date, right now.
//   auto: 'filled' | 'pending' | null (null = Roman chooses)
function orderEntryState(orderType, buyDate) {
  const now = _ptNow();
  if (buyDate === now.date) {
    if (orderType === 'market') {
      const session = classifySession(now.date, now.hhmm);
      if (session === 'REGULAR') return { auto: 'filled', note: 'Market order during regular hours — recorded as filled now.' };
      if (session === 'CLOSED') return { auto: 'pending', note: 'The market is closed, so this order fills at the next open. It will be added as a <strong>pending order</strong>; tap <strong>Mark filled</strong> when it does.' };
      return { auto: 'pending', note: `Extended hours (${session === 'PRE_MARKET' ? 'pre-market' : 'after-hours'}): a market order may not fill until the open. Added as a <strong>pending order</strong>; tap <strong>Mark filled</strong> with the real fill time.` };
    }
    return { auto: null, defaultFilled: false, note: `A ${ORDER_TYPE_LABEL[orderType].toLowerCase()} order doesn't fill when you place it — added as a <strong>pending order</strong> unless it already filled.` };
  }
  return { auto: null, defaultFilled: orderType === 'market', note: 'Entered after the fact — give the fill time, or mark it still pending.' };
}

// Form fragment. `prefix` namespaces the element ids (EDGE: 'pf', Warrior: 'wf').
function orderEntryFieldsHtml(prefix) {
  delete _orderEntryChoice[prefix]; // a fresh form starts with no choice made
  delete _orderEntryMode[prefix];
  const opts = ORDER_TYPES.map(([v, l]) => `<option value="${v}"${v === 'market' ? ' selected' : ''}>${l}</option>`).join('');
  return `
      <div class="form-group">
        <label class="form-label">Order type</label>
        <select id="${prefix}-order-type" class="form-input" onchange="orderEntryRefresh('${prefix}')">${opts}</select>
      </div>
      <div id="${prefix}-fill-note" class="order-fill-note"></div>
      <div id="${prefix}-fill-choose" class="hidden">
        <div class="decision-btns">
          <div class="decision-btn" id="${prefix}-fill-pending" onclick="orderEntrySetMode('${prefix}','pending')">Still pending</div>
          <div class="decision-btn" id="${prefix}-fill-filled" onclick="orderEntrySetMode('${prefix}','filled')">Already filled</div>
        </div>
        <div id="${prefix}-fill-when" class="form-row hidden">
          <div class="form-group"><label class="form-label">Fill date</label><input id="${prefix}-fill-date" class="form-input" type="date"></div>
          <div class="form-group"><label class="form-label">Fill time (PT)</label><input id="${prefix}-fill-time" class="form-input" type="time"></div>
        </div>
      </div>`;
}

// Two separate records, deliberately: what Roman CHOSE (only ever set by
// his tap) and what is in EFFECT right now. Found in the browser check
// (2026-10-09): storing the automatic "market + open -> filled" state as if
// it were his choice made a switch to Limit inherit "Already filled" -- a
// silent default recording fills that never happened.
const _orderEntryChoice = {};
const _orderEntryMode = {};

function orderEntrySetMode(prefix, mode) { // onclick: Roman's explicit choice
  _orderEntryChoice[prefix] = mode;
  _applyOrderEntryMode(prefix, mode);
}

function _applyOrderEntryMode(prefix, mode) {
  _orderEntryMode[prefix] = mode;
  document.getElementById(`${prefix}-fill-pending`).classList.toggle('selected', mode === 'pending');
  document.getElementById(`${prefix}-fill-filled`).classList.toggle('selected', mode === 'filled');
  document.getElementById(`${prefix}-fill-when`).classList.toggle('hidden', mode !== 'filled');
  _orderEntryPriceLabel(prefix);
}

// Re-evaluates the rule (order type or order date changed). Call once right
// after the modal renders, and from the date input's onchange.
function orderEntryRefresh(prefix) {
  const orderType = document.getElementById(`${prefix}-order-type`).value;
  const buyDate = document.getElementById(`${prefix}-date`).value;
  const st = orderEntryState(orderType, buyDate);
  document.getElementById(`${prefix}-fill-note`).innerHTML = st.note;
  document.getElementById(`${prefix}-fill-choose`).classList.toggle('hidden', st.auto != null);
  if (st.auto == null) {
    const now = _ptNow();
    const fd = document.getElementById(`${prefix}-fill-date`);
    const ft = document.getElementById(`${prefix}-fill-time`);
    if (!fd.value) fd.value = buyDate;
    if (!ft.value && buyDate === now.date) ft.value = now.hhmm;
    _applyOrderEntryMode(prefix, _orderEntryChoice[prefix] || (st.defaultFilled ? 'filled' : 'pending'));
  } else {
    _orderEntryMode[prefix] = st.auto;
    _orderEntryPriceLabel(prefix);
  }
}

function _orderEntryPriceLabel(prefix) {
  const label = document.getElementById(`${prefix}-price-label`);
  if (label) label.textContent = _orderEntryMode[prefix] === 'pending' ? 'Order price per share' : 'Price paid per share';
}

// Reads the form. Returns { orderType, filledAt } or { error }.
function readOrderEntry(prefix, buyDate) {
  const orderType = document.getElementById(`${prefix}-order-type`).value;
  if (!ORDER_TYPE_LABEL[orderType]) return { error: 'Choose an order type.' };
  const st = orderEntryState(orderType, buyDate);
  const mode = st.auto || _orderEntryMode[prefix];
  if (mode === 'pending') return { orderType, filledAt: null };
  if (st.auto === 'filled') return { orderType, filledAt: new Date().toISOString() };
  return _readFillInstant(document.getElementById(`${prefix}-fill-date`).value, document.getElementById(`${prefix}-fill-time`).value, buyDate, orderType);
}

// Shared by the add forms and Mark filled. A fill can't precede the order
// date or be in the future.
function _readFillInstant(fillDate, fillTime, buyDate, orderType) {
  if (!fillDate || !/^\d{2}:\d{2}$/.test(fillTime || '')) return { error: 'Enter the fill date and time (PT), or choose "Still pending".' };
  if (fillDate < buyDate) return { error: `The fill (${fillDate}) can't be before the order date (${buyDate}).` };
  const [h, m] = fillTime.split(':').map(Number);
  const instant = ptWallClockToInstant(fillDate, h, m);
  if (instant.getTime() > Date.now() + 60000) return { error: "The fill time can't be in the future." };
  return { orderType, filledAt: instant.toISOString() };
}
