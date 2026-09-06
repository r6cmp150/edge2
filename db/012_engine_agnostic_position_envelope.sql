-- Phase 7's "position envelope — engine-agnostic" (warrior-engine-spec-v2.md,
-- line 1375), the remaining three columns beyond engine_source (db/002 for
-- trades_v2, db/011 for portfolio): signalSnapshot, exitRuleId, minutesLate.
-- "Add ... to the portfolio table and the corresponding sold-trades store in
-- one migration" (line 1469) -- checked rather than assumed that trades_v2
-- needs the same three columns: grepped db/002 directly, none exist there
-- either.
--
-- signal_snapshot (jsonb): "holds the full gate result (§3 output shape)
-- plus the setups array, entry/target/stop, and suggested shares" for
-- Warrior; the spec's "Full Signal Capture" pairing for EDGE. Same
-- full-fidelity-detail-stays-jsonb convention db/002 already uses
-- (full_ure_factors_at_sale, full_peak_risk_factors_at_sale).
--
-- exit_rule_id (text): which specific exit-rule variant governed this
-- position -- 'edge.atr.multiday' or 'warrior.sameday.tightstop' per the
-- spec's envelope. Not the dispatch key itself (dispatch is by
-- engine_source, via the registry's evaluateExit -- see shell/registry.js
-- and engines/warrior/index.js's evaluateWarriorExit) -- this column is
-- descriptive, for Phase 8's per-rule breakdown, so a future third exit
-- variant on either engine doesn't get silently pooled with the first.
-- CHECK matches today's two known values; widen the constraint (not drop
-- it) if a third variant is ever added, same as engine_source's shape.
--
-- minutes_late (numeric, nullable): "WARRIOR only" per the spec's own
-- comment on the envelope -- EDGE positions leave this null, not zero.
-- Minutes between the acted-upon setup's trigger (setups.js's own
-- triggerTime, already computed live as minutesSinceTrigger and rendered
-- on the card -- see engines/warrior/setups.js:640 and index.js:360) and
-- the actual buy timestamp, computed fresh at buy time rather than reusing
-- whatever minutesSinceTrigger last rendered (that value is only as
-- current as the last scan, and a scan can be minutes stale by the time
-- Roman actually taps buy). When a candidate has more than one armed
-- setup, uses the primary setup's trigger time -- the same one the card's
-- own headline framing already treats as primary -- not an arbitrary
-- first-in-array pick.
--
-- NULL, not zero, when the acted-upon candidate has no triggerTime to
-- read at all -- a candidate that qualified on pillars without ever
-- reaching an armed setup, or a stale scan whose setups array is empty by
-- the time the buy happens. Zero minutes late (bought the instant it
-- triggered) and unknown minutes late (nothing to measure from) are
-- different facts, and this project has collapsed that exact distinction
-- into a silent zero three separate times already this session
-- (classifyGate's bare null, the float staleness gap, the QUALIFIED
-- evidence floor) -- decided here, before Step 6 writes a single row,
-- specifically so it isn't a fourth.
alter table portfolio add column if not exists signal_snapshot jsonb;
alter table portfolio add column if not exists exit_rule_id text
  check (exit_rule_id in ('edge.atr.multiday', 'warrior.sameday.tightstop'));
alter table portfolio add column if not exists minutes_late numeric;

alter table trades_v2 add column if not exists signal_snapshot jsonb;
alter table trades_v2 add column if not exists exit_rule_id text
  check (exit_rule_id in ('edge.atr.multiday', 'warrior.sameday.tightstop'));
alter table trades_v2 add column if not exists minutes_late numeric;

-- No RLS change needed on trades_v2 (db/005's anon insert+select policies
-- are row-scoped, not column-scoped) and portfolio deliberately carries no
-- RLS at all (see NOTE_portfolio_rls_not_applied.sql) -- adding a column
-- doesn't touch either.
