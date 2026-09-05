-- Enable RLS on `rating_snapshots`, matching current usage exactly
-- (app.js, writeRatingSnapshots and its readers):
--
--   INSERT -- writeRatingSnapshots, app.js:2313
--   DELETE -- 90-day retention pruning, app.js:2315-2316 (confirmed from
--            the actual arithmetic -- 90 * 24 * 60 * 60 * 1000 ms -- not
--            assumed from the comment)
--   SELECT -- app.js:5012, 6479 (count), 6822, 6849
--   UPDATE -- no call site anywhere. Blocked by absence.
--
-- THE DELETE POLICY IS DATE-BOUNDED, revised from an earlier draft that
-- used `using (true)`. That draft's reasoning was inverted: it argued a
-- bare policy was fine because the app's own WHERE clause already
-- targets the right rows -- but the threat isn't the app deleting the
-- wrong rows, it's someone holding the public anon key deleting rows
-- WITHOUT running the app at all, where the app's WHERE clause is
-- irrelevant. This is the same shape of gap the column-level grant on
-- trades closed: permit the legitimate operation, block everything else
-- the operation could otherwise reach.
--
-- THE 80/90 GAP IS DELIBERATE, not a rounding choice. The policy window
-- (80 days) is strictly WIDER than the app's actual cutoff (90 days) --
-- "wider" meaning it permits deleting more recent rows than the app ever
-- targets, so every row the app's own delete touches (captured_at < now
-- - 90d) is also permitted by the policy (captured_at < now - 80d).
-- Setting both to 90 would let ordinary clock skew between the two
-- evaluations put a boundary row on the wrong side of the policy check,
-- failing the retention sweep silently on exactly the rows it exists to
-- remove. If app.js's retention window ever changes, this policy must
-- move with it, staying at least ~10 days looser.
alter table rating_snapshots enable row level security;

drop policy if exists "anon insert" on rating_snapshots;
create policy "anon insert" on rating_snapshots for insert to anon with check (true);

drop policy if exists "anon select" on rating_snapshots;
create policy "anon select" on rating_snapshots for select to anon using (true);

drop policy if exists "anon delete" on rating_snapshots;
drop policy if exists "anon delete aged" on rating_snapshots;
create policy "anon delete aged" on rating_snapshots for delete to anon
  using (captured_at < now() - interval '80 days');

-- VERIFICATION PLAN: insert a disposable dummy snapshot row (recent
-- captured_at, i.e. NOT aged) via the anon key, confirm it reads back,
-- attempt an update (expect blocked -- confirmed by a follow-up select
-- showing the row unchanged, not just a status code), then THE TEST THAT
-- ACTUALLY PROVES THE NARROWING: attempt to delete that same recent row
-- via the anon key and confirm via a follow-up select that it SURVIVES --
-- a bare `using (true)` policy would not have caught this, since a
-- recent row deletes just as easily as an aged one under that policy.
-- Only after confirming the recent row survives, clean it up via the SQL
-- editor (no policy permits anon to delete a row this young, by design).
