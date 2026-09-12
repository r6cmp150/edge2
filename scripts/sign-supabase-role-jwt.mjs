#!/usr/bin/env node
// Signs a Supabase-compatible JWT carrying a custom `role` claim, using
// only Node's built-in crypto -- no npm install, no dependency on
// Supabase's own tooling. Exists to test (db/009) and later to mint the
// real credential for the deferred outcome-filling job: PostgREST trusts
// ANY JWT signed with the project's JWT secret and switches to whatever
// role its `role` claim names, as long as that Postgres role exists and
// is granted to `authenticator` -- no Supabase Auth/GoTrue user account
// or Auth Hook required for this path.
//
// THE SECRET NEVER LEAVES THIS MACHINE. Run this locally with the
// project's JWT secret (Supabase dashboard -> Project Settings -> API ->
// JWT Settings) passed as an environment variable, never pasted into
// chat, never committed anywhere. The output is the signed token --
// share THAT with whatever verification step needs it, not the secret.
//
// Usage:
//   SUPABASE_JWT_SECRET='...' node scripts/sign-supabase-role-jwt.mjs <role> <days>
//
// <days> is REQUIRED, no default -- found live 2026-09-10: this used to
// default to 3650 (~10 years) when omitted, and the outcome_filler
// production token's first minting did exactly that, silently, because
// the argument was left off. A decade-long bearer token with UPDATE
// rights over the forward test's own results is not a reasonable
// default for anyone to hit by omission -- the fix is not a shorter
// default, it's no default: lifetime has to be a choice the caller
// states every time, not a number that falls out of forgetting an
// argument. Pick a lifetime proportionate to what the role can do and
// how it'll be rotated (see db/017's header for the reasoning behind
// outcome_filler's own choice) -- rotate by re-running this script and
// updating the Actions secret, not by re-authenticating.
import { createHmac } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

const role = process.argv[2];
const daysArg = process.argv[3];
const days = Number(daysArg);
const secret = process.env.SUPABASE_JWT_SECRET;

if (!role || !daysArg) {
  console.error('usage: SUPABASE_JWT_SECRET=... node scripts/sign-supabase-role-jwt.mjs <role> <days>');
  console.error('<days> is required -- no default. State the lifetime deliberately; see this file\'s header for why.');
  process.exit(1);
}
if (!Number.isFinite(days) || days <= 0) {
  console.error(`<days> must be a positive number, got "${daysArg}".`);
  process.exit(1);
}
if (!secret) {
  console.error('SUPABASE_JWT_SECRET is not set. Get it from the Supabase dashboard -> Project Settings -> API -> JWT Settings. Never paste it into chat or a file that gets committed.');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const payload = {
  role,
  iss: 'supabase',
  iat: now,
  exp: now + days * 86400,
};

const token = signJwt(payload, secret);
console.log(token);
console.error(`\n(signed for role="${role}", expires ${new Date((now + days * 86400) * 1000).toISOString()} -- token printed to stdout above, this line is stderr so it doesn't pollute a captured token)`);
