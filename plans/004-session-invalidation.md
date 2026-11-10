# Plan 004: Invalidate password sessions when AUTH_PASSWORD changes; set Secure on HTTPS

> **Executor instructions**: Follow step by step; verify each. STOP conditions apply. Do NOT commit or push. Do not edit `plans/README.md`. Never print the password, the keys, or cookie values; tests use obviously fake values.
>
> **Environment**: `ln -s /home/juan/projects/meridian/node_modules node_modules`; `pnpm` may be absent: use `node_modules/.bin/vitest run <file>` and `node_modules/.bin/tsc --noEmit`.
>
> **Drift check**: `git diff --stat 4c3f281..HEAD -- apps/api/src/auth.ts apps/api/src/app.ts apps/api/src/config.ts`. Mismatch = STOP.

## Status
- **Priority**: P1 · **Effort**: S · **Risk**: LOW (users sign in once more) · **Depends on**: none · **Category**: security
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
Password sessions last 30 days and are stored with no link to the password that created them. Rotating `AUTH_PASSWORD` after a suspected leak does not end existing sessions, so a stolen cookie stays valid. Also the session cookie never sets `Secure`, so behind an HTTPS front (e.g. `tailscale serve`) it can still travel over HTTP.

## Current state
`apps/api/src/auth.ts`: `createPasswordSession(store, userId)` stores `{ userId, viaPassword: true, expiresAt }`; `SESSION_COOKIE = "foundry_session"`; `verifyPassword` uses an in-memory scrypt verifier with a random per-boot salt (so it cannot serve as a persistent fingerprint).
`apps/api/src/app.ts` login route (~line 313-333) calls `createPasswordSession` then `reply.setCookie(SESSION_COOKIE, session.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS })`. The cookie-session branch of `user(req)` (after `const sessionId = req.cookies?.[SESSION_COOKIE]; if (isSessionCookieId(sessionId)) {...`) loads the session and accepts it if it is a password session that has not expired: read that code first.
`apps/api/src/config.ts` exposes `config.authPassword`, `config.requireAuth`, the public origin (find the exact field name, likely `config.origin`/`publicOrigin`, and the INTERNAL key field) — read it; do not guess.
Existing tests: `tests/auth.test.ts`.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Focused test | `node_modules/.bin/vitest run tests/auth.test.ts` | pass |
| Typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Full tests | `node_modules/.bin/vitest run` | pass |

## Scope
**In scope**: `apps/api/src/auth.ts`, `apps/api/src/app.ts` (login cookie options and the cookie-session check only), `tests/auth.test.ts`.
**Out of scope**: rate limiting (separate finding), token logic (plan 003), cookie/localStorage renames (`foundry_*` names must not change), logout semantics.

## Steps
### Step 1: password fingerprint
In `auth.ts` add `export function passwordFingerprint(): string | undefined`: when `config.authPassword` is set, return `createHmac("sha256", <internal key from config>).update("meridian-session-v1:" + config.authPassword).digest("hex")`; else undefined. (HMAC under the server's INTERNAL key, so nothing password-equivalent that is offline-guessable is persisted. Add a comment saying so.) Store it as `pw: passwordFingerprint()` in the session data in `createPasswordSession`.

### Step 2: enforce on use
In the cookie-session branch of `user(req)`: for a password session, reject (same 401 behavior as an expired/invalid session) when `session.data.pw !== passwordFingerprint()`. Sessions created before this change have no `pw`, so they are rejected too (intended: one-time re-login).
**Verify**: `node_modules/.bin/tsc --noEmit` → exit 0.

### Step 3: Secure cookie
In the login `setCookie` options add `secure: <public origin>.startsWith("https://")` using the config field you identified. Do the same for `clearCookie` in logout only if its options must match to clear it (`secure` is not required to match; leave logout unchanged otherwise).

### Step 4: tests (`tests/auth.test.ts`, follow its existing harness)
(a) after login a session works; then change the password in the config the same way the existing tests do (reconfigure `config.authPassword`) and the same cookie now gets 401; (b) a session stored without `pw` is rejected; (c) with an `https://` public origin the `set-cookie` header contains `Secure`, with `http://` it does not.
**Verify**: focused test → pass.

## Done criteria
- [ ] `node_modules/.bin/tsc --noEmit` exits 0
- [ ] `node_modules/.bin/vitest run` exits 0 incl. new tests
- [ ] `git status --short` shows only in-scope files

## STOP conditions
- The config has no INTERNAL key / origin field you can read at runtime in `auth.ts`.
- Existing tests rely on pre-built password sessions without `pw` and cannot be adapted within `tests/auth.test.ts`.
- The cookie-session branch differs materially from the description.

## Maintenance notes
Rotating `INTERNAL_KEY` also invalidates sessions now (acceptable). Deferred: a revoke-all endpoint, per-session listing. Reviewer: confirm no persisted value allows offline password guessing.
