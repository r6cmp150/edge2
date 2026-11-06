# edge2 status

The open list, kept in the repo so nobody carries it from memory. Updated with every push; each line says where its
evidence is. Last updated 2026-11-06 with the push that added this file.

## Live database
- **Applied:** everything up to db/035 (run 1), db/037 (2026-11-05 ~20:00 PT; run 2 PASS), db/040.
- **Not applied:** db/036 (after the at-sale verdict build is live), db/038 (carved to main; RUN-ME-5/6/7 in the main
  checkout's folder), db/039 (gated), db/041 (on main; its insert-path enumeration says it is safe).
- **Columns known live:** `db/live-columns.json`. Update it only from a capture of the live database.

## Waiting on Roman
- Step 4 after db/037: a real buy and a real sale, both landing.
- db/038: RUN-ME-5, then RUN-ME-6 (run 2). RUN-ME-7 is the undo.
- db/041: not yet run.
- His four phone-only Settings values, recorded by hand today (`risk_per_trade_pct`, `max_loss_pct`,
  `float_threshold_shares`, `developer_tools`). They have no backup until db/038 runs and the app code that saves them
  is live.

## Being verified
- Step 5 after db/037, per workflow, by reading each `workflow_runs` row back against what the run intended: the
  backup and two Warrior logger runs verified on 2026-11-06. Still to verify: the EDGE logger and fill-outcomes (the only
  path using outcome_filler's 21 column grants). `setup_triggers`: no rows yet, so not checked.

## Gated (app code waiting on a migration)
- (c) macro observe-only, Verdict A, db/038 revisions b-d, the three-state guards: waiting on db/038 run 2.
- (d) rating_snapshots outcomes: waiting on db/039.

## Open
- One unexplained DEAD in `tests/anon-write-paths.test.js` under four parallel worktree runs: 100/100 alone, not
  reproduced in 15 reruns under concurrent load. The runner now prints a failure's whole output, so the next one names
  its path.
- The BEFORE INSERT trigger refusal measured in the harness (OLD is NULL on insert): unexplained.
- The error column in the empty-read registry, before the default-ACL fix.
- The default-ACL fix itself (scoped in the spec, not built).

## Closed recently, so they don't come back
- `scripts/lib/mutants.cjs`: timeout, SIGINT/SIGTERM restore, clean-tree precondition. On main since 99c2836.
- The test runner truncating failures: fixed in 1be51dd.
