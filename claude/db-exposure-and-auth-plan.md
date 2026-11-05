# Database exposure and auth plan

**Canonical copy:** this file, `claude/db-exposure-and-auth-plan.md` in
the repo (decided 2026-11-02). The claude.ai project copy becomes a
pointer here plus a current-state summary.

**Status:** scoped, not built.

**Provenance (keep this until it is cleared):** reconstructed 2026-11-02
and reconciled against the review messages sent in the build session
that day, read back from its transcript. It has NOT been checked against
the claude.ai project copy, which may hold material that was never sent.
Drop this label only once that copy has been compared.

## Why

The app talks to Supabase with the public anon (publishable) key, which
ships in the page. Anyone holding it can do whatever the anon policies
allow. The preflight (2026-11-02) found:
- `portfolio` and `db_meta` with RLS OFF;
- `settings` and `workflow_runs` with an anon UPDATE policy;
- `rating_snapshots` with an anon DELETE policy.

RLS alone cannot fix `portfolio`: the app writes it as anon (update on
save, delete at sale), so enabling RLS with permissive anon policies
changes the label, not the exposure. db/037 (interim hardening) removes
anon UPDATE/DELETE wherever nothing uses them. **This plan:** Supabase
Auth, one account for Roman, policies keyed to his uid, anon policies
removed (Roman's decision).

## Hard constraints

- **Item zero is load-bearing.** Step 3 mints a job-role JWT with the
  project's signing secret. If that secret were public, anyone could mint
  any role, and the design would protect nothing. Item zero found it
  absent from repo history (534 commits, 1,331 blobs), the Pages site,
  and 1,091 of 1,104 Actions logs. Roman has declined rotation; **if the
  secret is ever found exposed, rotation stops being his preference and
  becomes mandatory.**
- **Nothing touches a table outside db/001–db/037.** This Supabase
  project is shared with Roman's shark-attack work (incidents,
  named_zones, pipeline_state, regions, risk_estimates,
  shark_migrations). `rls_auto_enable()` and the sign-ups setting span
  both projects.
- **Not during market hours.** The cutover runs after the close or on a
  weekend, and Roman is told the window in advance.
- **No production write attempt without explicit approval,** including a
  probe designed to affect zero rows. Pre-approved, scoped exactly: the
  negative anon write test after step 5.

## The five design requirements (from the start)

1. **Public sign-ups OFF is a prerequisite, not a follow-up.** It isn't
   an emergency today: no table has a write policy reaching
   `authenticated`, so that role is inert. It stops being inert the
   moment step 4 writes policies, which is why it flips at step 0.
   - Prefer policies keyed to Roman's specific uid over the bare
     `authenticated` role. With sign-ups open until he flips them, that
     is the difference between a safe step 4 and a hole.
   - The setting is project-wide, so check whether the shark-attack
     project has a sign-in flow of its own before turning it off.
2. **Cutover order:** add auth and the uid policies, verify signed-in
   writes with a real insert-and-reselect, and only THEN remove the anon
   policies. Never the reverse. Status codes prove nothing, and
   `has_table_privilege` does not consult RLS.
3. **Not during market hours** (above).
4. **No silent write failure during the cutover.** A failed signed-in
   write must be visible.
   - **Correction (2026-11-02):** `saleWriteFailures` was never silent.
     The red "sale NOT recorded" banner with Retry has existed since
     10-27.
   - **The real gaps were narrower:** a failed buy snapshot (a Settings
     line only, which is how 72 were lost) and a failed `rating_snapshots`
     write (console only). Both go to the banner in step 1.
5. **The scripts authenticate differently,** so for each: does it break,
   and does it rely on an anon policy about to be removed? The daily
   backup is the mitigation this plan leans on; it must not be what
   breaks.

## Steps

0. **Sign-ups off** (Authentication settings, project-wide; check
   shark-attack first), **then create Roman's user.**
1. **Surfacing and backup floors.** *(Built in the working tree; ships
   with the at-sale push.)*
   - Buy-snapshot and rating-batch failures reach the banner with Retry.
   - The rating Retry has FOUR states: landed, not landed, partly
     landed, and **cannot tell**. The fourth was added 2026-11-02,
     because the landed check is itself deniable: a positive control
     read must see a row first, or nothing is retried.
   - **The backup-empties-silently finding.** If anon SELECT goes before
     the backup has its own credential, RLS returns an empty list, the
     backup "succeeds" and writes nothing. The mitigation fails quietly,
     and the same is true today of any policy mistake. So the backup
     asserts a minimum row count for every table, aborts below it, and
     records what it wrote (`scripts/lib/backup-rules.mjs`,
     `data/backups/_manifest.json`).
2. **App sign-in.** Roman signs in; the session is what the uid policies
   key on.
3. **A job-role JWT for the scheduled scripts, covering READS as well as
   writes** (corrected 2026-11-02). Every scheduled script reads with
   the anon key today. After step 5 those reads come back empty, so
   fill-outcomes would resolve signals as "not taken", credit the wrong
   signal day, and the scan gate would fire every cron.
   - **The job role gets SELECT on everything the scripts read,** taken
     from `tests/empty-read-sites.test.js`:
     - for the backup: trades, trades_v2, signal_log, settings,
       portfolio, signal_snapshot_at_buy, rating_snapshots;
     - for the loggers, fill-outcomes, the scan gate and the schema
       check: scan_runs, setup_triggers.
   - **Plus its writes:** the loggers' inserts and fill-outcomes'
     outcome_filler PATCHes. Pattern: outcome_filler,
     `OUTCOME_FILLER_JWT`.
   **3½. PREREQUISITE OF STEP 4 (2026-11-04): read the schema first.** Step 4
   writes policies against tables whose definitions nobody here has read.
   `db_meta`, `portfolio`, `rating_snapshots`, `settings` and `trades` have no
   CREATE in db/, and `portfolio` is one of the two with RLS off. So their
   constraints are inferred from behaviour. The anon key can't read the schema
   (REST root: 401, "Secret API key required"), so what is public has only ever
   been inferred too: the six shark-attack tables above are public and unnamed by
   this code, and there may be others.
   - **Roman runs `db/inspect-public-schema-read-only.sql`** (one SELECT, after
     db/035, not before) and the result is read and recorded here.
   - **Step 4 doesn't start until that is done.** Its policies, and the first
     hard constraint's list of what not to touch, are then written from the
     definitions, not from this list.
   - `tests/tables-without-create.test.js` keeps the five-table list true.
4. **Migration A, additive:** uid policies alongside the existing anon
   ones. Nothing breaks if the app or a job still runs as anon.
   Verified by signed-in insert-and-reselect.

   **4½. PREREQUISITE OF STEP 5 (accepted 2026-11-02): empty-read
   handling.** RLS answers a denied read with an EMPTY LIST, not an
   error. Under uid policies, any session not signed in as Roman (a
   failed sign-in, an expired session, a job without its JWT) reads
   empty everywhere.
   - **The count:** of 39 read sites in the app and the workflow-run
     scripts, 34 treated empty as a meaningful state when classified:
     14 silent, 13 checks that pass having read nothing, and 7 that
     WRITE on that basis.
   - **Two are fixed:**
     - the settings save, which used to insert the defaults as a new
       newest row (shipped 67308c3, 2026-11-02; it now refuses and says
       to reload);
     - the rating Retry, now with its fourth state (working tree, ships
       with step 1).
   - **Five still write, worst first:**
     1. fill-outcomes permanently resolves signals as not-taken;
     2. fill-outcomes' later-signal check credits the wrong signal day;
     3. the scan gate fires every cron;
     4. the sold list overwrites its phone cache with empty;
     5. analysis periods overwrite theirs.
   - **Recount, 2026-11-02 after the carve-out:** 40 sites (the Retry's
     control read is new). 8 OK, 14 silent, 13 pass-on-empty, 5 write.
     Step 3's SELECT list re-checked against it: unchanged.
   - **STATUS 2026-11-02 (working tree, ships with the db/038 build): 42
     sites, 30 OK, 12 silent, 0 write, 0 pass-on-empty.** This item's
     condition for step 5 is met in code.
     - The five script writers and all 13 pass-on-empty checks now run a
       positive control first (`scripts/lib/readable.mjs`: a table that is
       never empty must return a row, or the run stops red). Every
       post-write re-read is asserted.
     - The two app cache-overwrites now keep the phone's copy and say so on
       the banner.
     - `tests/empty-read-controls.test.js` checks each control is still in
       place, before the reads it guards (7 mutants killed), and fails if
       any site is re-classified as writing or passing on empty.
     - The 12 silent sites (empty shown as "none") remain, and are listed
       in the guard. They write nothing and fail no check.

   Every site is classified in `tests/empty-read-sites.test.js`, which
   fails when a new read appears unclassified.

   **Step 5 doesn't start until no site there is WRITES_FROM_EMPTY.**
   The 13 pass-on-empty checks also get real assertions (a verification
   that can't fail when it sees nothing is the `has_table_privilege`
   mistake again), in the same change.
5. **Migration B, removal, off-hours:** drop the anon policies.
   - **Before it, a tested rollback block:** the SQL that restores the
     anon policies is written in advance and verified by applying and
     reverting it in the window, so a failure at 6am is a paste, not an
     improvisation.
   - **After it, a negative test:** an anon WRITE attempt must be
     REFUSED (pre-approved, scoped to exactly this). An anon READ must
     come back empty. And the app, signed out, must show the error
     screen, not defaults.

## Standing rules that apply

- Every migration opens with a guard that aborts unless the live schema
  agrees, and is verified by a behaviour run that raises to roll back.
- Verify by behaviour, not by catalog.
- When a guardrail stops a step, stopping is the answer.
