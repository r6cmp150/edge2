// tests/build-status.test.js — is the app.js this page loaded the newest
// deployed build? (2026-10-22) Three states: current, stale (both stamps),
// unknown (with why). Never "current" when the check didn't run or failed.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const fnSrc = name => {
  const m = app.match(new RegExp(String.raw`(async )?function ${name}\([^)]*\) \{[\s\S]*?\n\}`));
  assert.ok(m, `${name} found`);
  return m[0];
};
function load(running, fetchImpl) {
  global.VERSION = running; global.SCORING_VERSION = 2; global.SCORING_HASH = 'abcdef0123456789';
  global.fetch = fetchImpl;
  global.document = { querySelectorAll: () => [] };
  let banner = 0;
  global._showUpdateAvailableBanner = () => { banner++; };
  // eslint-disable-next-line no-eval
  eval(`let _buildStatus = { state: 'unknown', running: VERSION, reason: 'not checked yet' }; let _buildCheckedAt = 0;\n`
    + ['checkBuildStatus', 'buildStatusText', 'buildProvenanceLine', 'renderBuildStatus'].map(fnSrc).join('\n')
    + '\nglobal.__check = checkBuildStatus; global.__text = buildStatusText; global.__prov = buildProvenanceLine; global.__status = () => _buildStatus;');
  return () => banner;
}
const page = stamp => async () => ({ ok: true, text: async () => `<html><script src="app.js?v=${stamp}"></script></html>` });

(async () => {
await run('before any check: unknown, never current', () => {
  load('20261022020000', page('20261022020000'));
  assert.strictEqual(global.__status().state, 'unknown');
  assert.ok(/not confirmed latest: not checked yet/.test(global.__prov()), global.__prov());
});

await run('current: the deployed index.html names this stamp', async () => {
  load('20261022020000', page('20261022020000'));
  const st = await global.__check({ force: true });
  assert.strictEqual(st.state, 'current');
  assert.ok(/Build 20261022020000 · scoring v2 · latest/.test(global.__text().text));
});

await run('stale: both stamps named, the reopen instruction, and the update banner', async () => {
  const banners = load('20261021060000', page('20261022020000'));
  const st = await global.__check({ force: true });
  assert.strictEqual(st.state, 'stale');
  assert.ok(/Running 20261021060000, latest is 20261022020000 — close the app fully and reopen/.test(global.__text().text), global.__text().text);
  assert.strictEqual(banners(), 1, 'the existing update banner is shown');
  assert.ok(/NOT the latest: 20261022020000/.test(global.__prov()));
});

await run('unknown, never current: network failure, HTTP error, missing tag, older server copy, no own stamp', async () => {
  const cases = [
    ['20261022020000', async () => { throw new TypeError('Failed to fetch'); }, /couldn't reach the server \(Failed to fetch\)/],
    ['20261022020000', async () => ({ ok: false, status: 503 }), /HTTP 503/],
    ['20261022020000', async () => ({ ok: true, text: async () => '<html>no tag</html>' }), /no app\.js\?v= tag/],
    ['20261022020000', page('20261021060000'), /older build \(20261021060000\)/],
    ['unavailable', page('20261022020000'), /no \?v= stamp/],
  ];
  for (const [running, impl, why] of cases) {
    load(running, impl);
    const st = await global.__check({ force: true });
    assert.strictEqual(st.state, 'unknown', `${why}: got ${st.state}`);
    assert.ok(why.test(st.reason), `reason ${st.reason}`);
    assert.ok(/not confirmed latest/.test(global.__text().text));
  }
});

await run('the check bypasses every cache: no-store and a unique URL (an offline SW fallback cannot answer it)', async () => {
  let seen = null;
  load('20261022020000', async (url, opts) => { seen = { url, opts }; return page('20261022020000')(); });
  await global.__check({ force: true });
  assert.strictEqual(seen.opts.cache, 'no-store');
  assert.ok(/^\.\/index\.html\?build-check=\d+$/.test(seen.url), seen.url);
});

await run('VERSION is the loaded stamp, not a literal; reports state provenance with the build status', () => {
  assert.ok(/^const VERSION = currentCodeVersion\(\)\.app;$/m.test(app), 'VERSION is read from the loaded app.js tag');
  assert.ok(!/const VERSION = '/.test(app), 'no hand-maintained version string');
  assert.ok(!/App Version: \$\{VERSION\}/.test(app), 'report headers use buildProvenanceLine(), not a bare VERSION');
  assert.strictEqual((app.match(/\$\{buildProvenanceLine\(\)\}/g) || []).length, 3, 'both report headers and the configuration line');
  for (const f of ['scripts/log-signals-edge.mjs', 'scripts/log-signals-warrior.mjs']) {
    assert.ok(!/refusing to log/.test(readSource(f)), `${f} never refuses to log over a version`);
  }
});
})();
