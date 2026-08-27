// tests/_clock_tz_runner.js — NOT a test itself. Executed as a child
// process (by clock-timezone.test.js) under different TZ env vars, since
// Node only reads TZ at process start — it can't be changed reliably
// mid-process. Fixes `new Date()`/`Date.now()` to a specific real instant
// (passed as argv[2]) so all TZ variants observe the identical moment;
// only the process's OWN local-timezone interpretation of that moment
// differs between runs, which is exactly the variable this test exists to
// isolate. Prints one JSON line to stdout for the parent to compare.
'use strict';
const fs = require('fs');
const path = require('path');

const FIXED_EPOCH_MS = Number(process.argv[2]);

const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_EPOCH_MS);
    else super(...args);
  }
  static now() { return FIXED_EPOCH_MS; }
}
global.Date = FakeDate;

global.state = { settings: {} };

const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'clock.js'), 'utf8');
const exposeCode = `
  global.__getMarketStatus = getMarketStatus;
  global.__getCountdownToOpen = getCountdownToOpen;
  global.__hoursSincePreviousClose = hoursSincePreviousClose;
`;
// eslint-disable-next-line no-eval
eval(src + '\n' + exposeCode);

const result = {
  tz: process.env.TZ || '(system default)',
  marketStatus: global.__getMarketStatus(),
  countdown: global.__getCountdownToOpen(),
  hoursSincePreviousClose: global.__hoursSincePreviousClose(new FakeDate()),
};
process.stdout.write(JSON.stringify(result));
