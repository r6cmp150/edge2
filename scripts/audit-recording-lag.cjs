// scripts/audit-recording-lag.cjs -- were trades RECORDED on a different day
// from the event? (phase-10 spec §3.4 / §7.7, 2026-10-27). buy_time,
// sell_time, buy_session and the weekdays were read from the clock at
// recording, so a late recording would store the typing moment under the
// event's name. Sale recording = trades_v2.created_at (a real stamp: equals
// sell_time to the minute). Buy recording = the add's Date.now(), from the
// portfolio backups' position ids, or bounded by a same-day sale.
//   node scripts/audit-recording-lag.cjs [rev]     (default b4620bc)
// Result at b4620bc: 0 late sales of 292, 0 late buys of 268 datable, 24
// undatable; the 270 verified rows reproduce the 07:00-07:29 bucket
// (n=70, -$377, 14 days).
// HARD FLOOR: the 24 undatable buys are trades held overnight before the
// portfolio backups began (2026-09). No backup ever holds their add, so
// they stay unknown forever. A re-run showing 24 unknowns is that floor,
// not a new problem; only a count above 24 is new. Since db/033,
// trades_v2.position_id is the add's Date.now(), so new rows date directly.
const { execSync } = require('child_process');
const REV = process.argv[2] || 'b4620bc';
const sh = c => execSync(c, { maxBuffer: 1e9 }).toString();
const rows = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(sh(`git show ${REV}:data/backups/trades_v2.json`)));
const ptDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const ptHM = t => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
// Buy recordings from the portfolio backup history.
const addRec = new Map(); // key ticker|buy_date|price|shares -> earliest add recording instant
for (const rev of sh('git log --format=%h -- data/backups/portfolio.json').trim().split('\n')) {
  let ps; try { ps = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(sh(`git show ${rev}:data/backups/portfolio.json`))); } catch { continue; }
  for (const p of ps || []) {
    const id = Number(p.position_id); const t = Number.isFinite(id) && id > 1.7e12 ? id : (p.created_at ? Date.parse(p.created_at) : null);
    if (!t) continue;
    const k = `${p.ticker}|${String(p.buy_date).slice(0, 10)}|${Number(p.buy_price)}|${Number(p.shares)}`;
    if (!addRec.has(k) || t < addRec.get(k)) addRec.set(k, t);
  }
}
const out = rows.map(r => {
  const bd = String(r.buy_date).slice(0, 10), sd = String(r.sell_date).slice(0, 10), saleRec = ptDate(r.created_at);
  const k = `${r.ticker}|${bd}|${Number(r.buy_price)}|${Number(r.shares)}`;
  let buyRec = null, how = null;
  if (addRec.has(k)) { buyRec = ptDate(addRec.get(k)); how = 'backup'; }
  else if (saleRec === bd) { buyRec = bd; how = 'sandwich'; } // buy_date <= add recorded <= sale recorded
  return { r, bd, sd, saleRec, buyRec, how, hm: (r.buy_time || '').slice(0, 5) };
});
const report = (label, xs) => {
  const buyLate = xs.filter(x => x.buyRec && x.buyRec !== x.bd), buyUnknown = xs.filter(x => !x.buyRec), sellLate = xs.filter(x => x.saleRec !== x.sd);
  const b = xs.filter(x => x.hm >= '07:00' && x.hm < '07:30');
  const pnl = b.reduce((s, x) => s + Number(x.r.pnl_dollars || 0), 0);
  console.log(`\n${label}: n=${xs.length}`);
  console.log(`  buy recorded on a different day from buy_date: ${buyLate.length} | buy recording date unknown: ${buyUnknown.length} | dated by backup ${xs.filter(x => x.how === 'backup').length}, by sandwich ${xs.filter(x => x.how === 'sandwich').length}`);
  console.log(`  sale recorded on a different day from sell_date: ${sellLate.length}`);
  console.log(`  07:00-07:29 bucket: n=${b.length}, P&L $${pnl.toFixed(0)}, distinct days ${new Set(b.map(x => x.bd)).size}`);
  const inB = b.filter(x => !x.buyRec || x.buyRec !== x.bd || x.saleRec !== x.sd);
  console.log(`  of those, buy or sale recorded late, or buy recording unknown: ${inB.length}${inB.length ? ' -> ' + inB.map(x => `${x.r.ticker} buy ${x.bd} ${x.hm} (buy rec ${x.buyRec || '?'}, ${x.how || 'unmatched'}) sell ${x.sd} rec ${x.saleRec}`).join('; ') : ''}`);
  return { buyLate, buyUnknown, sellLate };
};
const all = report('all trades_v2 at ' + REV, out);
const verified = out.filter(x => !x.r.sell_price_unverified);
report('excluding sell_price_unverified', verified);
console.log('\nbuy-late detail:', all.buyLate.map(x => `${x.r.ticker} buy ${x.bd} ${x.hm} recorded ${x.buyRec}`).join('; ') || 'none');
console.log('sell-late detail:', all.sellLate.map(x => `${x.r.ticker} sell ${x.sd} recorded ${x.saleRec} ${ptHM(x.r.created_at)}`).join('; ') || 'none');
const unk = all.buyUnknown; console.log('buy-unknown detail:', unk.slice(0, 40).map(x => `${x.r.ticker} ${x.bd}->${x.sd} (sale rec ${x.saleRec})`).join('; '), unk.length > 40 ? `... +${unk.length - 40}` : '');
