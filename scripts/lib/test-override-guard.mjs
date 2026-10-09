// Shared guard: a test override must never be able to write production rows
// (2026-10-09). Found when Warrior scan 3da6957d -- run by hand on Saturday
// 2026-10-03 at 7:28pm PT with --session=OPEN --write -- stored
// session='OPEN' for a closed market, and 24 signal_log rows inherited it.
// The override existed to exercise session-dependent logic; nothing stopped
// its forced value from landing in scan_runs as if it had been observed.
//
// ONE GUARD, ALLOWLIST NOT DENYLIST. With --write present the script refuses
// to start if it was given:
//   * any CLI argument not in its explicit allowlist (default: only --write)
//     -- so a test flag added later is refused automatically, rather than
//     relying on someone remembering to add it to a list of forbidden ones;
//   * any environment variable whose name starts with TEST_ and is non-empty
//     -- the convention for test-only overrides (TEST_FORCE_TRIGGER_SYMBOL
//     appends a synthetic QUALIFIED result and, with --write, a synthetic
//     setup_triggers row).
// Overrides still work in dry runs, which write nothing. Exits non-zero with
// the offending names; never silently drops the override and proceeds.
export function refuseTestOverridesWithWrite(scriptName, { argv = process.argv.slice(2), env = process.env, allowedArgs = ['--write'] } = {}) {
  if (!argv.includes('--write')) return;
  const badArgs = argv.filter(a => !allowedArgs.includes(a));
  const badEnv = Object.keys(env).filter(k => k.startsWith('TEST_') && env[k] !== '');
  if (badArgs.length || badEnv.length) {
    const parts = [...badArgs.map(a => `argument ${a}`), ...badEnv.map(k => `env ${k}`)];
    const msg = `${scriptName}: refusing --write with test override(s): ${parts.join(', ')}. A forced value must never reach a stored column -- drop --write (dry run) or drop the override.`;
    const err = new Error(msg);
    err.code = 'TEST_OVERRIDE_WITH_WRITE';
    throw err;
  }
}
