do $$
declare
  refused int := 0;
  accepted text := '';
begin
  set local role anon;
  begin
    insert into trades_v2 (ticker, buy_date, sell_date, shares, buy_price, sell_price, verdict_provenance)
    values ('DB035', '2026-11-02', '2026-11-02', 1, 1, 1, 'guessed');
    accepted := accepted || ' [ACCEPTED 1: a provenance value outside the three]';
  exception when check_violation then refused := refused + 1;
  end;
  begin
    insert into trades_v2 (ticker, buy_date, sell_date, shares, buy_price, sell_price, verdict_provenance, unified_recommendation_at_sale)
    values ('DB035', '2026-11-02', '2026-11-02', 1, 1, 1, 'not_recorded', 'HOLD');
    accepted := accepted || ' [ACCEPTED 2: not_recorded with a stored label]';
  exception when check_violation then refused := refused + 1;
  end;
  begin
    insert into trades_v2 (ticker, buy_date, sell_date, shares, buy_price, sell_price, verdict_provenance, signal_before_sale)
    values ('DB035', '2026-11-02', '2026-11-02', 1, 1, 1, 'not_recorded', '{"state":"PREDATES_SALE"}');
    accepted := accepted || ' [ACCEPTED 3: PREDATES_SALE without scanned_at]';
  exception when check_violation then refused := refused + 1;
  end;
  begin
    insert into trades_v2 (ticker, buy_date, sell_date, shares, buy_price, sell_price, verdict_provenance, lock_in_profits_fired)
    values ('DB035', '2026-11-02', '2026-11-02', 1, 1, 1, 'not_recorded', false);
    accepted := accepted || ' [ACCEPTED 4: not_recorded claiming lock_in false]';
  exception when check_violation then refused := refused + 1;
  end;
  raise exception 'db/035 run 4 RESULT: % of 4 bad inserts refused by a check (expected 4).%  This message is raised on purpose so the whole block rolls back: nothing was written.', refused, accepted;
end $$;
