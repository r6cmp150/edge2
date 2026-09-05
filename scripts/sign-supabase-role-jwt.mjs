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
//   SUPABASE_JWT_SECRET='...' node scripts/sign-supabase-role-jwt.mjs outcome_filler_test [days]
//
// [days] (default 3650, ~10 years): token lifetime. Long-lived by design
// for a credential meant to sit in a GitHub Actions secret like the
// Alpaca keys already do -- rotate by re-running this script and
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
const days = Number(process.argv[3] || 3650);
const secret = process.env.SUPABASE_JWT_SECRET;

if (!role) {
  console.error('usage: SUPABASE_JWT_SECRET=... node scripts/sign-supabase-role-jwt.mjs <role> [days]');
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
