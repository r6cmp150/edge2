// scripts/lib/frozen-inputs.mjs -- THE SECOND STANDING CHECK (the reviewer, CC-the-inputs-were-free-and-the-check-only-
// covers-one-direction §1, 2026-11-27). The first check (tests/frozen-references-out.test.js) asks whether frozen code
// CALLS an OUT name. renderPortfolioTab was invisible to it: it was OUT, it called frozen code, and it WROTE the state
// frozen code reads (peakPrice, momentumProtectionActivated, ...). A frozen function fed by free inputs is not frozen.
// This finds the other direction: every OUT app.js declaration that writes something a frozen reader reads.
//
// What counts as a write, in an OUT declaration's code (comments stripped; strings KEPT, as the closure keeps them: an
// apostrophe in a template literal made a string-stripper swallow real code, here as on 2026-11-25; text that looks
// like an assignment over-includes, the safe direction):
//   - an assignment or update (=, +=, ||=, ??=, ++, --, ...) to a member, a property path or a top-level name;
//   - delete of a member; Object.assign(target, ...); a mutating call on a member (push, splice, set, add, ...);
//   - persist('X') (it saves state.X); localStorage/sessionStorage setItem(key, ...).
// What it is keyed by, and what counts as a frozen read of that key (frozen app.js declarations and frozen files):
//   - state.X (state.settings.Y for a setting)  <- the text `state.X` (`.settings.Y` / `settings.Y`) anywhere frozen;
//   - a member of anything else, by its last property name `.p`  <- `.p`, `?.p`, `'p'` or `"p"` anywhere frozen:
//     keyed by name, not by object, because the object is usually a local (`p.peakPrice`), so a write to a
//     same-named property of an unrelated object also counts -- over-inclusive, the safe direction for a freeze;
//   - a top-level name N (var:N)  <- the identifier N anywhere frozen;
//   - a storage key K (storage:K)  <- the token K anywhere frozen.
// Reads are not separated from writes on the frozen side: frozen code mentioning a key counts as consuming it.
import { chunks, normalize, frozenDeclarations } from './instrument-freeze.mjs';

const ID = '[A-Za-z_$][\\w$]*';
const LHS = `${ID}(?:\\s*(?:\\??\\.\\s*${ID}|\\[[^\\[\\]]*\\]))*`;
const ASSIGN = new RegExp(`(?<![\\w$.])(${LHS})\\s*(?:=(?![=>])|\\+=|-=|\\*=|/=|%=|\\|\\|=|&&=|\\?\\?=|\\+\\+|--)`, 'g');
const PREFIX = new RegExp(`(?:\\+\\+|--)\\s*(${LHS})`, 'g');
const DELETE = new RegExp(`\\bdelete\\s+(${LHS})`, 'g');
const ASSIGN_OBJ = new RegExp(`\\bObject\\.assign\\(\\s*(${LHS})\\s*,`, 'g');
const MUTATE = new RegExp(`(?<![\\w$.])(${LHS})\\s*\\.\\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|set|add|delete|clear)\\s*\\(`, 'g');
const PERSIST = /\bpersist\(\s*['"]([\w$]+)['"]/g;
const STORAGE = /\b(?:localStorage|sessionStorage)\s*\.\s*setItem\(\s*([^,()]+?)\s*,/g;

// the key a written left-hand side names, or null for a local
export function keyOf(lhs, topNames, self) {
  const parts = lhs.replace(/\[[^\[\]]*\]/g, '').split(/\s*\??\.\s*/).filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'window' || parts[0] === 'globalThis') parts.shift();
  if (parts.length === 1) return topNames.has(parts[0]) && parts[0] !== self ? `var:${parts[0]}` : null;
  if (parts[0] === 'state') return parts[1] === 'settings' && parts[2] ? `state.settings.${parts[2]}` : `state.${parts[1]}`;
  return `.${parts[parts.length - 1]}`;
}
// every key one declaration's code writes
export function writesOf(text, topNames, self) {
  const code = normalize(text), keys = new Set();
  for (const re of [ASSIGN, PREFIX, DELETE, ASSIGN_OBJ, MUTATE]) for (const m of code.matchAll(re)) { const k = keyOf(m[1], topNames, self); if (k) keys.add(k); }
  for (const m of code.matchAll(PERSIST)) keys.add(`state.${m[1]}`);
  for (const m of code.matchAll(STORAGE)) keys.add(`storage:${m[1].trim()}`);
  return keys;
}
const esc = s => s.replace(/[$]/g, '\\$');
// a mention followed by a plain "=" is frozen code WRITING the key, not reading it (a compound operator reads first)
const NOT_SET = '(?![\\w$])(?!\\s*=(?![=>]))';
// does frozen text read this key?
export function reads(frozenText, key) {
  if (key.startsWith('var:')) return new RegExp(`(?<![\\w$.])${esc(key.slice(4))}${NOT_SET}`).test(frozenText);
  if (key.startsWith('storage:')) return frozenText.includes(key.slice(8));
  if (key.startsWith('state.settings.')) { const p = esc(key.slice(15)); return new RegExp(`settings\\s*\\??\\.\\s*${p}${NOT_SET}`).test(frozenText); }
  if (key.startsWith('state.')) { const p = esc(key.slice(6)); return new RegExp(`(?<![\\w$])state\\s*\\??\\.\\s*${p}${NOT_SET}`).test(frozenText); }
  const p = esc(key.slice(1));
  return new RegExp(`\\??\\.\\s*${p}${NOT_SET}|['"]${p}['"]`).test(frozenText);
}
// THE CALL CHANNEL (added beyond the ruling, 2026-11-27): an OUT declaration that CALLS a frozen function passes it
// values without writing any state (renderPortfolioTab handed calcUnifiedRecommendation its RSI this way). Map of OUT
// caller -> the frozen functions it calls, a call inside an onclick string included (strings are kept).
export function outCallsFrozen(appSrc, spec) {
  const cs = chunks(appSrc), frozen = new Set(frozenDeclarations(appSrc, spec));
  const fns = cs.filter(c => frozen.has(c.name) && /^(?:async\s+)?function/.test(c.text)).map(c => c.name);
  const out = new Map();
  for (const c of cs) {
    if (frozen.has(c.name)) continue;
    const t = normalize(c.text);
    const calls = fns.filter(f => new RegExp(`(?<![\\w$.])${esc(f)}\\s*\\(`).test(t));
    if (calls.length) out.set(c.name, calls);
  }
  return out;
}
// [{ writer, key }]: an OUT app.js declaration writes `key`, and frozen code (a frozen declaration or a frozen file)
// reads it. frozenFiles: { path: source } of the frozen JS files.
export function outWritesReadByFrozen(appSrc, spec, frozenFiles = {}) {
  const cs = chunks(appSrc), topNames = new Set(cs.map(c => c.name));
  const frozen = new Set(frozenDeclarations(appSrc, spec));
  const frozenText = [...cs.filter(c => frozen.has(c.name)).map(c => normalize(c.text)), ...Object.values(frozenFiles).map(normalize)].join('\n');
  const memo = new Map(), out = [];
  for (const c of cs) {
    if (frozen.has(c.name)) continue;
    for (const key of writesOf(c.text, topNames, c.name)) {
      if (!memo.has(key)) memo.set(key, reads(frozenText, key));
      if (memo.get(key)) out.push({ writer: c.name, key });
    }
  }
  return out;
}
