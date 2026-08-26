// shell/registry.js — the ONLY dispatch mechanism into engine code.
// docs/warrior-engine-spec-v2.md Phase 2.
//
// CLAUDE.md invariant: shell/ reaches engines only through this file, never
// a direct import and never a stored module reference. That second half
// matters as much as the first — a stored reference (e.g. app.js keeping
// the object `await import(...)` resolved to) is still a way to reach
// Warrior code that bypasses this registry, even with no `if
// (engineSource === 'WARRIOR')` branch anywhere. The whole point of routing
// every call through registerEngine/getEngine is that the boundary check
// can grep for "does anything reference engines/warrior/ outside this one
// dynamic import() call" and get a mechanical yes/no — a stored reference
// would make that a judgement call instead.
//
// Classic script (not a module) — loaded before app.js, alongside
// core/*.js, so registerEngine/getEngine exist as globals by the time
// app.js's dynamic import of engines/warrior/index.js resolves and calls
// register(). engines/warrior/index.js IS an ES module (that's what makes
// dynamic import() give it its own parse/error boundary), but a module's
// top-level code still runs in the same global scope as the rest of the
// page — it can call registerEngine() as an ordinary global function call,
// no special wiring needed.
const _engines = new Map();

// registerEngine(id, {
//   label,               'EDGE' | 'Warrior' — display string
//   renderTab,            () => void — the engine's OWN tab content. In the
//                          registry deliberately, not held as a stored
//                          reference by app.js — see header comment above.
//   renderBadge,          (position) => HTMLElement — portfolio card badge
//   renderSnapshot,       (signalSnapshot) => HTMLElement — modal detail
//   evaluateExit,         (position, liveData) => { status, reasons[] }
//   summarizeForReport    (trades[]) => string — engine's own stats block
// })
function registerEngine(id, registration) {
  _engines.set(id, registration);
}

// → registration, or null if not loaded. Never throws — an engine that
// isn't registered (not yet loaded, failed to load, deliberately absent)
// is a normal, expected state the caller checks for, not an exception.
function getEngine(id) {
  return _engines.get(id) || null;
}
