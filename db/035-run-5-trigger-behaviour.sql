do $$
declare
  rid uuid;
  n0 bigint;
  n1 bigint;
  orig jsonb;
  now_row jsonb;
  cnt int;
  ra text := 'NOT REFUSED (the trigger is not working)';
  rb text := 'NOT REFUSED (the trigger is not working)';
  rc text;
  re text;
begin
  select id into rid from trades_v2 where verdict_provenance = 'mixed_moment' order by created_at limit 1;
  if rid is null then
    raise exception 'db/035 run 5: no mixed_moment row found. Was run 1 applied?';
  end if;
  select count(*) into n0 from trades_v2;
  select to_jsonb(t) into orig from trades_v2 t where id = rid;

  -- a) a different VALID provenance (the CHECK allows it): only the trigger can refuse it
  begin
    update trades_v2 set verdict_provenance = 'sale_moment' where id = rid;
  exception when others then ra := 'refused: ' || sqlerrm;
  end;

  -- b) a different VALID signal_before_sale: only the trigger can refuse it
  begin
    update trades_v2 set signal_before_sale = '{"state":"NOT_ESTABLISHED","reason":"db/035 run 5 test"}'::jsonb where id = rid;
  exception when others then rb := 'refused: ' || sqlerrm;
  end;

  -- c) a column the trigger does not guard (fill-outcomes writes it): must SUCCEED;
  --    undone by raising inside its own sub-block once the update is confirmed
  begin
    update trades_v2 set price_at_plus1_day = coalesce(price_at_plus1_day, 0) + 1 where id = rid;
    get diagnostics cnt = row_count;
    raise exception 'run5-c-applied:%', cnt;
  exception when others then
    rc := case when sqlerrm = 'run5-c-applied:1' then 'SUCCEEDED (1 row) and was undone' else 'FAILED: ' || sqlerrm end;
  end;

  -- e) rls_auto_enable() as anon: an event-trigger function can't be called directly
  begin
    set local role anon;
    perform rls_auto_enable();
    re := 'NOT REFUSED';
  exception when others then re := 'refused: ' || sqlerrm;
  end;

  -- d) the row and the table are exactly as they were
  select count(*) into n1 from trades_v2;
  select to_jsonb(t) into now_row from trades_v2 t where id = rid;

  raise exception 'db/035 run 5 RESULT (row %): a) verdict_provenance change %. b) signal_before_sale change %. c) price_at_plus1_day %. d) row unchanged: %; row count unchanged: % (% rows). e) rls_auto_enable() as anon %. This message is raised on purpose so everything rolls back: nothing was written.',
    rid, ra, rb, rc, (orig = now_row), (n0 = n1), n1, re;
end $$;
