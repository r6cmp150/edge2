begin;
set local role anon;
insert into trades_v2 (ticker, buy_date, sell_date, shares, buy_price, sell_price, position_id,
                       verdict_provenance, unified_recommendation_at_sale, lock_in_profits_fired, signal_before_sale)
values ('DB035', '2026-11-02', '2026-11-02', 1, 1, 1, 'db035-verify-rolled-back',
        'not_recorded', null, null, '{"state":"NOT_ESTABLISHED","reason":"db/035 verification, rolled back"}');
rollback;
