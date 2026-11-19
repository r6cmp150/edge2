// tests/macro-capability-test.test.js -- 2026-11-19 (the reviewer). scripts/macro-capability-test.mjs, driven by a fake
// Groq: the plan's arithmetic, the prompts and request equal to production's, and the stop rule in both halves (a run
// that fits reports COMPLETE; one that would cross the cap stops BEFORE sending, and says INCOMPLETE with the count,
// first and last); a 429 retried once, a second refused; the key never printed. No network.
'use strict';
const assert = require('assert');
const { run, REPO_ROOT } = require('./_lib');
const path = require('path');
const { pathToFileURL } = require('url');

const HELD = [{ id: 1, created_at: 'x', source: 'benzinga', headline: 'Fed holds' }, { id: 2, created_at: 'y', source: 'benzinga', headline: 'Chips fall' }];
const okReply = (content, total = 400) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content, reasoning: 'thinking' } }], usage: { total_tokens: total } }), text: async () => '' });

(async () => {
const M = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/macro-capability-test.mjs')).href);
const prod = M.loadProduction(REPO_ROOT);
const plan1 = () => M.planArm(1, { prod, heldHeadlines: HELD });
const drive = async ({ cap = 150000, replies, key = 'SECRET-KEY' }) => {
  const lines = [], sent = [];
  let i = 0;
  const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }); const r = replies(i++); return r; };
  const r = await M.runArm({ arm: 1, asks: plan1(), prod, key, cap, paceMs: 0, fetchImpl, sleep: async () => {}, print: l => lines.push(l) });
  return { r, lines, sent, text: lines.join('\n') };
};

await run('the plan: arm 1 is 18 asks (3 inputs x 2 headline conditions x 3), production prompts, worst case under the cap', () => {
  const asks = plan1();
  assert.strictEqual(asks.length, 18);
  assert.deepStrictEqual([...new Set(asks.map(a => a.hlabel))], ['no headlines', `held set ${M.HEADLINE_SET_HASH}`]);
  for (const a of asks) assert.strictEqual(a.prompt, prod.buildMacroGroqPrompt(a.moves, a.headlines), 'the production prompt');
  assert.ok(asks.filter(a => a.hlabel === 'no headlines').every(a => /\(no recent headlines available\)/.test(a.prompt)), 'the production empty branch');
  assert.strictEqual(prod.MACRO_GROQ_MAX_TOKENS, 2000, 'production max_tokens');
  const total = asks.reduce((s, a) => s + M.worstCase(a.prompt, 2000), 0);
  assert.ok(total < 150000 && total > 18 * 2000, `worst case ${total}`);
  assert.strictEqual(M.worstCase('x'.repeat(301), 2000), 101 + 30 + 2000, 'ceil(chars / 3) + 30 + max_tokens');
});

await run('a run that fits: COMPLETE 18 of 18, first in the report and last; every request is production\'s body', async () => {
  const { r, lines, sent } = await drive({ replies: () => okReply('BROAD_RALLY — everything up') });
  assert.strictEqual(r.complete, true);
  assert.strictEqual(sent.length, 18);
  // compared as JSON: the production body is built inside the VM, whose objects have the VM's prototypes
  for (const s of sent) assert.strictEqual(JSON.stringify(s.body), JSON.stringify(prod.macroGroqRequestBody(s.body.messages[0].content)));
  assert.strictEqual(lines[lines.length - 1], 'ARM 1 COMPLETE: 18 of 18');
  assert.ok(lines.includes('\nARM 1 COMPLETE: 18 of 18'), 'at the head of the report too');
  assert.ok(lines.some(l => /sign: \+ 3 \| condition: BROAD_RALLY 3 \| pattern rule: BROAD_RALLY \[\+\]/.test(l)), 'by sign first, then condition, the rule beside');
});

await run('a run that would cross the cap stops BEFORE sending: INCOMPLETE with the count, and the next ask is never sent', async () => {
  const one = M.worstCase(plan1()[0].prompt, 2000);
  const { r, sent, lines } = await drive({ cap: one * 5 + 1, replies: () => okReply('CHOPPY — flat') });
  assert.strictEqual(r.complete, false);
  assert.strictEqual(sent.length, 0, 'the plan exceeds the cap: nothing at all is sent');
  assert.ok(/^ARM 1 INCOMPLETE: 0 of 18 \(the plan's worst case \d+ exceeds the cap/.test(lines[lines.length - 1]), lines[lines.length - 1]);
  // There is no mid-run case to test: a plan whose whole worst case fits under the cap cannot cross it part-way, so the
  // per-ask reservation in runArm is a second guard behind the plan check, not a path a real run can reach.
});

await run('a 429 is retried once after retry-after; a second refusal stops the arm INCOMPLETE at that ask', async () => {
  const r429 = { ok: false, status: 429, headers: new Map([['retry-after', '7']]), text: async () => 'rate limited', json: async () => ({}) };
  const once = await drive({ replies: i => (i === 0 ? r429 : okReply('CHOPPY — flat')) });
  assert.strictEqual(once.r.complete, true, once.lines.slice(-3).join('|'));
  assert.ok(once.text.includes('ask 1: 429, retrying once after 7 s'));
  const twice = await drive({ replies: i => (i < 2 ? r429 : okReply('CHOPPY — flat')) });
  assert.strictEqual(twice.r.complete, false);
  assert.strictEqual(twice.sent.length, 2, 'the first ask twice, nothing after');
  assert.ok(/^ARM 1 INCOMPLETE: 0 of 18 \(ask 1 failed: HTTP 429 after one retry/.test(twice.lines[twice.lines.length - 1]), twice.lines[twice.lines.length - 1]);
});

await run('the key is never printed, even when a failure echoes it', async () => {
  const echo = { ok: false, status: 401, headers: new Map(), text: async () => 'bad key SECRET-KEY', json: async () => ({}) };
  const { text, sent } = await drive({ replies: () => echo });
  assert.strictEqual(sent[0].auth, 'Bearer SECRET-KEY', 'it is sent');
  assert.ok(!text.includes('SECRET-KEY') && text.includes('bad key <key>'), 'and scrubbed from every line');
});

await run('arms 3 and 2: every stored ask x 3; the mirror flips all five moves and keeps the headlines', () => {
  const stored = [{ fetched_at: 'T1', etf_moves: { SPY: -1, XLE: 0.5, XLK: -2, XBI: null, XLF: 0.1 }, groq_headlines: HELD, groq_condition: 'RISK_OFF' }];
  const a3 = M.planArm(3, { prod, stored }), a2 = M.planArm(2, { prod, stored });
  assert.strictEqual(a3.length, 3); assert.strictEqual(a2.length, 3);
  assert.deepStrictEqual(a2[0].moves, { SPY: 1, XLE: -0.5, XLK: 2, XBI: null, XLF: -0.1 });
  assert.strictEqual(a2[0].headlines, HELD);
  assert.throws(() => M.planArm(4, { prod }), /no arm 4/, 'arm 4 was cut');
});
})();
