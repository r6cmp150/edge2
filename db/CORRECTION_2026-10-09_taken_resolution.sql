-- CORRECTION 2026-10-09: signal_log.taken_resolution re-resolved under the
-- two rules fill-outcomes now enforces (scripts/lib/taken-precedence.mjs):
--
--   1. CAUSALITY: a signal can only be taken / traded against by a trade
--      ORDERED at or after its first_shown_at. 4 rows (marked below) were
--      morning orders credited to a ~12:10pm PT sighting the same day.
--   2. MOST RECENT PRIOR SIGNAL ONLY: one trade credits at most one signal
--      day. One FLNC order had been credited to four signal days; 40
--      taken-by-fallback rows were really 20 trades. After: 17.
--
-- fill-outcomes Pass 2 only resolves 'unresolved' rows and only reads the
-- last 12 days, so existing rows can't fix themselves -- hence this file.
-- The 3 rows set to 'unresolved' (10/1 signals, window open to 10/10) are
-- left for fill-outcomes to resolve; every other row's 9-day window has
-- closed with no qualifying trade, so it's set to its final state here.
-- Computed by replaying the new rules over production on 2026-10-09.
--
-- ATOMIC BY CONSTRUCTION (rewritten 2026-10-09, before first run): the whole
-- correction is ONE statement -- a DO block with the 29 rows as an inline
-- VALUES list. A single statement is atomic in Postgres regardless of how
-- the client batches or autocommits, so the raise exception undoes every
-- row the block touched -- no reliance on the SQL editor honouring
-- begin/commit, no begin/commit to get separated from its body, and no
-- helper table (_fix) that could survive the session and be re-run later.
-- GUARDED per row: each row updates only if it still holds its exact old
-- state (resolution + matched trade); the block aborts unless exactly 29
-- changed. The trailing SELECT is read-only: the re-select.
-- Run as ONE paste in the Supabase SQL editor.

do $$
declare n int;
begin
  update signal_log s
     set taken_resolution = f.new_res,
         matched_trade_id = null
    from (values
      ('91d5b85f-f03a-46a0-9f59-ae8c2111c91b'::uuid, 'taken-by-fallback', 'ce92b9b9-1bee-4347-ba5e-ed0d5e7754c9'::uuid, 'not-taken-confirmed'),  -- COTY 2026-09-22 SHOWN
      ('39024247-5191-4f37-a403-0092182e0cfc'::uuid, 'taken-by-fallback', '3926bf32-b5c1-4e96-9b50-95aeff422b26'::uuid, 'not-taken-confirmed'),  -- FLNC 2026-09-18 SHOWN
      ('fb616ea5-a9b5-4229-8fc6-08f242bf8861'::uuid, 'taken-by-fallback', 'd76943a7-4017-4adc-94df-0d56dbeb95a0'::uuid, 'not-taken-confirmed'),  -- ALM 2026-09-22 SHOWN
      ('22ab8030-a3f1-4398-8b84-562add46a394'::uuid, 'traded-against-engine', 'd87ce85b-92e2-4928-905b-7b0fce74913c'::uuid, 'not-taken-confirmed'),  -- AREN 2026-09-22 BELOW_THRESHOLD
      ('bc8d13c2-c9e8-44fa-ab3e-754cef8a537d'::uuid, 'taken-by-fallback', '4f1cf44f-dc92-4a46-bf3d-f69bdfb81438'::uuid, 'not-taken-confirmed'),  -- SNAP 2026-09-22 SHOWN
      ('d2eee0fe-17d9-4b5f-a0cd-856f57b43ba2'::uuid, 'taken-by-fallback', 'cd4e5d52-51d9-4ab5-88ce-15430f4b8434'::uuid, 'not-taken-confirmed'),  -- HUN 2026-09-18 SHOWN
      ('db41ae9a-1ee0-466e-84c2-905906cf0f7f'::uuid, 'traded-against-engine', 'fd5a7de1-302f-41f8-ad25-602ca853b779'::uuid, 'not-taken-confirmed'),  -- UPXI 2026-09-22 BELOW_THRESHOLD
      ('92062fa2-4d1d-4d5d-8fae-b6c4ea79b3ba'::uuid, 'taken-by-fallback', 'c8fbd8e7-9809-43c8-bcc3-22075bc834df'::uuid, 'not-taken-confirmed'),  -- CCO 2026-09-23 SHOWN
      ('18543147-95a9-4eb9-92ce-3851a20d23c5'::uuid, 'taken-by-fallback', '72c045ec-4583-4eb4-afe5-9adc01ace5f7'::uuid, 'not-taken-confirmed'),  -- STUB 2026-09-22 SHOWN
      ('e2123e91-a30f-4da5-8c85-715299d3b98f'::uuid, 'taken-by-fallback', 'a72c6982-7546-4cee-8c00-36f89627afd7'::uuid, 'not-taken-confirmed'),  -- STUB 2026-09-18 SHOWN  [order predates signal]
      ('fe9f3f26-e264-4bc0-9134-8fa6429a4cb3'::uuid, 'taken-by-fallback', '3eb71993-390e-4c63-898e-f9b1516f3867'::uuid, 'not-taken-confirmed'),  -- COUR 2026-09-22 SHOWN
      ('6a9db08f-88ab-409c-8e09-abc0deaf2b75'::uuid, 'taken-by-fallback', '3926bf32-b5c1-4e96-9b50-95aeff422b26'::uuid, 'not-taken-confirmed'),  -- FLNC 2026-09-23 SHOWN
      ('e59f39fb-b485-4283-8802-b3f53831c9de'::uuid, 'traded-against-engine', 'd76943a7-4017-4adc-94df-0d56dbeb95a0'::uuid, 'not-taken-confirmed'),  -- ALM 2026-09-18 BELOW_THRESHOLD
      ('9dc293d7-d7ea-491c-9168-d8fb527c9c5e'::uuid, 'taken-by-fallback', '3926bf32-b5c1-4e96-9b50-95aeff422b26'::uuid, 'not-taken-confirmed'),  -- FLNC 2026-09-22 SHOWN
      ('eeeb9dac-0ff7-4cf7-a1b3-68e9b0a7b9ae'::uuid, 'taken-by-fallback', 'cd4e5d52-51d9-4ab5-88ce-15430f4b8434'::uuid, 'not-taken-confirmed'),  -- HUN 2026-09-23 SHOWN
      ('c3de5a9d-869b-4d71-8d26-27c2eff88e71'::uuid, 'taken-by-fallback', '544d5516-05dc-46f8-81f3-dc8a14177373'::uuid, 'not-taken-confirmed'),  -- IE 2026-09-22 SHOWN
      ('9c45a9f6-3ec1-4af6-b081-09f7709f175b'::uuid, 'taken-by-fallback', '4f1cf44f-dc92-4a46-bf3d-f69bdfb81438'::uuid, 'not-taken-confirmed'),  -- SNAP 2026-09-23 SHOWN
      ('f4c166ad-a10b-47af-82cd-e5c122d43c76'::uuid, 'traded-against-engine', 'd76943a7-4017-4adc-94df-0d56dbeb95a0'::uuid, 'not-taken-confirmed'),  -- ALM 2026-09-23 BELOW_THRESHOLD
      ('59624e05-cef5-4b38-b160-9f7994d0fdb1'::uuid, 'traded-against-engine', 'd87ce85b-92e2-4928-905b-7b0fce74913c'::uuid, 'not-taken-confirmed'),  -- AREN 2026-09-23 BELOW_THRESHOLD
      ('6ab907d8-349e-4372-8e66-a42dc18983cd'::uuid, 'taken-by-fallback', 'b35fa609-b1ce-4253-8615-9dd4a1374008'::uuid, 'not-taken-confirmed'),  -- LUMN 2026-09-25 SHOWN
      ('db0e1bbd-4304-419b-8e0e-ea85271bd2dc'::uuid, 'taken-by-fallback', '72c045ec-4583-4eb4-afe5-9adc01ace5f7'::uuid, 'not-taken-confirmed'),  -- STUB 2026-09-23 SHOWN
      ('d63ff4c3-ad5b-4b32-888b-3b17c2ef8d14'::uuid, 'taken-by-fallback', '544d5516-05dc-46f8-81f3-dc8a14177373'::uuid, 'not-taken-confirmed'),  -- IE 2026-09-23 SHOWN
      ('1992ff1b-b197-4c3d-94b3-7299180b0036'::uuid, 'taken-by-fallback', '7dff89ea-2575-4b91-97e9-c987269205ac'::uuid, 'not-taken-confirmed'),  -- UAMY 2026-09-25 SHOWN
      ('f953fca6-9dc3-41a3-b2b4-7c25535eee6a'::uuid, 'taken-by-fallback', '3eb71993-390e-4c63-898e-f9b1516f3867'::uuid, 'not-taken-confirmed'),  -- COUR 2026-09-23 SHOWN
      ('840f85f7-bb6d-4973-a7d8-22cc2d30a079'::uuid, 'taken-by-fallback', 'c8fbd8e7-9809-43c8-bcc3-22075bc834df'::uuid, 'unresolved'),  -- CCO 2026-10-01 SHOWN  [order predates signal]
      ('e4a6ad82-db96-4ca8-9b7b-b53031d4d2d2'::uuid, 'taken-by-fallback', '15088fd1-ccb4-4716-b142-0856274aa5bb'::uuid, 'unresolved'),  -- TDAY 2026-10-01 SHOWN  [order predates signal]
      ('bb949611-7b64-42a4-a43d-3cf95030f0ae'::uuid, 'traded-against-engine', '9f98084e-ef91-4c5b-acf2-aed00b595dd9'::uuid, 'not-taken-confirmed'),  -- AMC 2026-09-25 BELOW_THRESHOLD
      ('483b7bcc-a201-4050-8a2e-665df6edf5d4'::uuid, 'taken-by-fallback', 'b35fa609-b1ce-4253-8615-9dd4a1374008'::uuid, 'not-taken-confirmed'),  -- LUMN 2026-09-23 SHOWN
      ('28dbaf9d-5e85-4ff0-87c9-684d39ee00ed'::uuid, 'taken-by-fallback', 'c31f964f-770a-470d-b5d9-38bdbccb170c'::uuid, 'unresolved')  -- GO 2026-10-01 SHOWN  [order predates signal]
    ) as f(id, old_res, old_trade, new_res)
   where s.id = f.id
     and s.taken_resolution = f.old_res
     and s.matched_trade_id = f.old_trade;
  get diagnostics n = row_count;
  if n <> 29 then
    raise exception 'expected 29 rows to change, got % -- nothing applied', n;
  end if;
end $$;

select symbol, signal_date, tier, taken_resolution, matched_trade_id
  from signal_log
 where id in (
    '91d5b85f-f03a-46a0-9f59-ae8c2111c91b',
    '39024247-5191-4f37-a403-0092182e0cfc',
    'fb616ea5-a9b5-4229-8fc6-08f242bf8861',
    '22ab8030-a3f1-4398-8b84-562add46a394',
    'bc8d13c2-c9e8-44fa-ab3e-754cef8a537d',
    'd2eee0fe-17d9-4b5f-a0cd-856f57b43ba2',
    'db41ae9a-1ee0-466e-84c2-905906cf0f7f',
    '92062fa2-4d1d-4d5d-8fae-b6c4ea79b3ba',
    '18543147-95a9-4eb9-92ce-3851a20d23c5',
    'e2123e91-a30f-4da5-8c85-715299d3b98f',
    'fe9f3f26-e264-4bc0-9134-8fa6429a4cb3',
    '6a9db08f-88ab-409c-8e09-abc0deaf2b75',
    'e59f39fb-b485-4283-8802-b3f53831c9de',
    '9dc293d7-d7ea-491c-9168-d8fb527c9c5e',
    'eeeb9dac-0ff7-4cf7-a1b3-68e9b0a7b9ae',
    'c3de5a9d-869b-4d71-8d26-27c2eff88e71',
    '9c45a9f6-3ec1-4af6-b081-09f7709f175b',
    'f4c166ad-a10b-47af-82cd-e5c122d43c76',
    '59624e05-cef5-4b38-b160-9f7994d0fdb1',
    '6ab907d8-349e-4372-8e66-a42dc18983cd',
    'db0e1bbd-4304-419b-8e0e-ea85271bd2dc',
    'd63ff4c3-ad5b-4b32-888b-3b17c2ef8d14',
    '1992ff1b-b197-4c3d-94b3-7299180b0036',
    'f953fca6-9dc3-41a3-b2b4-7c25535eee6a',
    '840f85f7-bb6d-4973-a7d8-22cc2d30a079',
    'e4a6ad82-db96-4ca8-9b7b-b53031d4d2d2',
    'bb949611-7b64-42a4-a43d-3cf95030f0ae',
    '483b7bcc-a201-4050-8a2e-665df6edf5d4',
    '28dbaf9d-5e85-4ff0-87c9-684d39ee00ed'
 )
 order by signal_date, symbol;
