-- Enable RLS on `settings`, matching current usage exactly (core/store.js):
--
--   SELECT -- loadSettingsFromSupabase (237, 261)
--   UPDATE -- existing row (264) -- all app-config columns (budget,
--            include_under2, show_watch, min_volume,
--            force_pre_market_mode, disable_macro_overlay, updated_at)
--   INSERT -- only when no row exists yet (267) -- same row shape as
--            the update, updated_at included
--   DELETE -- no call site anywhere. Blocked by absence.
--
-- No column-level narrowing on the UPDATE policy, unlike trades: this
-- table holds only app-config toggles (confirmed clean of credentials --
-- Alpaca/Groq keys are deliberately localStorage-only, never sent to
-- Supabase, core/store.js:35) and every column that exists is already
-- one saveSettingsToSupabase legitimately rewrites in a single call. A
-- full-row update policy is proportionate here; it would not be for
-- trades, where sell_price/pnl_dollars sit alongside the 5 columns that
-- actually need writing.
alter table settings enable row level security;

drop policy if exists "anon insert" on settings;
create policy "anon insert" on settings for insert to anon with check (true);

drop policy if exists "anon select" on settings;
create policy "anon select" on settings for select to anon using (true);

drop policy if exists "anon update" on settings;
create policy "anon update" on settings for update to anon
  using (true) with check (true);

-- VERIFICATION PLAN: insert a disposable dummy settings row via the
-- anon key, confirm it reads back, update one column and confirm via a
-- follow-up select that the new value actually landed, attempt a
-- delete (expect blocked, confirmed by a follow-up select showing the
-- row still exists), then remove the dummy row via the SQL editor.
