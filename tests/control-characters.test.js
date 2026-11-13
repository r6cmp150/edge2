// tests/control-characters.test.js -- 2026-11-13. A check run by hand twice becomes a committed test (the reviewer's
// rule), and this one had been run by hand more than five times. Text passed through a string literal in another
// language (a Python or shell heredoc, a node -e) turned "\r?\n" into a real carriage return and line feed, or halved
// its backslashes: in a test's regex (1ad78c1's first mutant run, voided by it), in the spec entry describing exactly
// that, in a declaration script, an assertion sed, a render anchor and the _lib helper edits. Each was caught by an
// ad-hoc control-character check. This is that check, committed.
// What it holds:
//   1. no control character other than tab and line feed in any tracked text file outside data/ (bot-written backups);
//   2. in Markdown, the escape sequences \r?\n and \r\n appear only inside a backtick code span, where they are quoted
//      on purpose, never in prose, where they would mean a regex was meant and text was written.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { run, REPO_ROOT } = require('./_lib');

const TEXT = /\.(md|js|mjs|cjs|yml|yaml|html|css|sql|json|txt)$/;
function trackedText() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(f => f && TEXT.test(f) && !f.startsWith('data/'));
}
// Every control character but tab (9) and line feed (10), and DEL (127): [{ line, col, code }].
function controlChars(text) {
  const found = [];
  let line = 1, col = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) { line++; col = 0; continue; }
    col++;
    if ((c < 32 && c !== 9) || c === 127) found.push({ line, col, code: c });
  }
  return found;
}
// Literal \r?\n or \r\n outside backtick code spans, line by line: [{ line, text }].
const ESCAPES = /\\r\?\\n|\\r\\n/;
function escapesInProse(md) {
  const found = [];
  let fenced = false;
  md.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) { fenced = !fenced; return; }
    if (fenced) return;
    const prose = l.split('`').filter((_, k) => k % 2 === 0).join(' ');
    if (ESCAPES.test(prose)) found.push({ line: i + 1, text: l.trim().slice(0, 100) });
  });
  return found;
}

run('the scanner can fail: it finds a planted carriage return, and an escape in prose but not in a code span', () => {
  assert.deepStrictEqual(controlChars('a\tb\nc' + String.fromCharCode(13) + 'd'), [{ line: 2, col: 2, code: 13 }]);
  assert.deepStrictEqual(controlChars('fine\ttext\n'), []);
  const md = ['ok `\\r?\\n` quoted', 'bad \\r?\\n in prose', '```', 'fenced \\r\\n is code', '```'].join('\n');
  assert.deepStrictEqual(escapesInProse(md).map(f => f.line), [2]);
});

run('no tracked text file outside data/ carries a control character other than tab and line feed', () => {
  const files = trackedText();
  assert.ok(files.length > 200, `scanned ${files.length} files`);
  const bad = [];
  for (const f of files) {
    const found = controlChars(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
    for (const x of found.slice(0, 3)) bad.push(`${f}:${x.line}:${x.col} code ${x.code}`);
  }
  assert.deepStrictEqual(bad, [], 'a control character in a text file: written through a string literal in another language?');
});

run('in Markdown, \\r?\\n and \\r\\n appear only inside code spans, never as prose', () => {
  const bad = [];
  for (const f of trackedText().filter(f => f.endsWith('.md'))) {
    for (const x of escapesInProse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))) bad.push(`${f}:${x.line}: ${x.text}`);
  }
  assert.deepStrictEqual(bad, []);
});
