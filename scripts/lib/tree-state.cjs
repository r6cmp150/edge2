// scripts/lib/tree-state.cjs -- the code a test run ran against (2026-11-04). The queue-pacing
// failure can never be explained partly because it ran on a working tree and nothing recorded
// its state. Printed by the runner and the mutation harness, so a result is attributable.
//   "<commit> clean", "<commit> dirty <hash of the changes>", or "unknown (<why>)"
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

function treeState(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 2e9, stdio: ['ignore', 'pipe', 'ignore'] });
  let commit;
  try { commit = git('rev-parse', '--short=12', 'HEAD').toString().trim(); } catch (_) { return 'unknown (not a git checkout)'; }
  try {
    const root = git('rev-parse', '--show-toplevel').toString().trim();
    const status = git('status', '--porcelain', '--untracked-files=all').toString();
    if (!status) return `${commit} clean`;
    const hash = createHash('sha256').update(git('diff', 'HEAD', '--binary'));
    const untracked = git('ls-files', '--others', '--exclude-standard').toString().split('\n').filter(Boolean).sort();
    for (const f of untracked) hash.update(f).update(fs.readFileSync(path.join(root, f)));
    return `${commit} dirty ${hash.digest('hex').slice(0, 12)}`;
  } catch (e) {
    return `${commit} dirty unhashed (${String(e.message).slice(0, 80)})`;
  }
}
module.exports = { treeState };
