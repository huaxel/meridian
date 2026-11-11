# Plan 003: Restrict API token minting to sign-in sessions and give tokens an expiry

> **Executor instructions**: Follow step by step; verify each step. STOP conditions apply. Do NOT commit or push. Do not edit `plans/README.md`. Never print secret values (tokens, passwords, keys) in logs or test output you paste.
>
> **Environment**: `ln -s /home/juan/projects/meridian/node_modules node_modules` (gitignored); `pnpm` may be absent, use `node_modules/.bin/vitest run <file>` and `node_modules/.bin/tsc --noEmit`.
>
> **Drift check**: `git diff --stat 4c3f281..HEAD -- apps/api/src/routes/workspace.ts apps/api/src/app.ts`. Mismatch with excerpts = STOP.

## Status
- **Priority**: P1 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: security
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
`POST /api/v1/workspaces/:w/tokens` creates tokens with no `expiresAt`, and any caller with owner access (including a Bearer token) can call it. A leaked non-read-only token therefore gives permanent owner access and can mint replacement tokens that survive revocation of the original. The auth path (`app.ts`, `user()`) already honours `t.data.expiresAt`; nothing ever sets it.

## Current state
`apps/api/src/routes/workspace.ts` (~line 683):
```ts
app.post("/api/v1/workspaces/:w/tokens", async (req) => {
  const a = await access(req, "owner"),
    b = z.object({ name: z.string(), readOnly: z.boolean().default(true) }).parse(req.body),
    raw = token();
  await transaction(store, "global", async (tx) =>
    tx.put(resource("global", "token", b.name,
      { userId: a.user.id, workspaceId: a.scope, readOnly: b.readOnly }, digest(raw))));
  return { token: raw, id: digest(raw) };
});
```
`apps/api/src/app.ts` `user(req)`: for a Bearer header it loads `t = store.get("global", digest(bearer))` and requires `t.kind === "token" && (!t.data.expiresAt || t.data.expiresAt > Date.now())`, returning `{ user, session: t }`. So `a.session.kind === "token"` for token callers; browser/local sessions have `kind === "session"`. `app.ts` already blocks workspace creation by tokens (~line 362-370): look there for the exact assertion style (`assert(cond, message, status)`) and match it. Existing tests: `tests/auth.test.ts` (use as the structural pattern for building an app and calling routes).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Find callers | `grep -rn "/tokens" apps packages docs tests --include=*.ts --include=*.tsx --include=*.md` | review every hit |
| Focused test | `node_modules/.bin/vitest run tests/auth.test.ts` | pass |
| Typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Full tests | `node_modules/.bin/vitest run` | pass |

## Scope
**In scope**: `apps/api/src/routes/workspace.ts`, `tests/auth.test.ts` (or a new `tests/api-tokens.test.ts` if cleaner), `docs/API.md` only if it documents token creation (add the new field and rule).
**Out of scope**: `app.ts` auth flow, the web UI, SDK, token listing/last-used tracking, session changes (plan 004).

## Steps
### Step 1: see who calls the endpoint
Run the grep above. If the web app or SDK mints tokens using a token credential (not a browser session), STOP and report.

### Step 2: block minting by tokens
After `const a = await access(req, "owner")`, add `assert(a.session.kind !== "token", "Create API tokens from a signed-in session, not another token", 403)` (use the file's existing `assert` import/style).

### Step 3: add an expiry
Extend the body schema with `expiresInDays: z.number().int().min(1).max(365).default(90)`. Store `expiresAt: Date.now() + b.expiresInDays * 86_400_000` in the token data. Return it as `expiresAt` in the response along with `token` and `id`.
**Verify**: `node_modules/.bin/tsc --noEmit` → exit 0.

### Step 4: tests
Using the `tests/auth.test.ts` harness: (a) a session creates a token and the response has an `expiresAt` about 90 days ahead; (b) `expiresInDays: 400` is rejected (400); (c) calling the endpoint with a Bearer token returns 403; (d) a token whose `expiresAt` is in the past is rejected by an authenticated route with 401 (create it through the store with a past `expiresAt`).
**Verify**: focused test → pass.

## Done criteria
- [ ] `node_modules/.bin/tsc --noEmit` exits 0
- [ ] `node_modules/.bin/vitest run` exits 0 including new tests
- [ ] `git status --short` shows only in-scope files

## STOP conditions
- A caller mints tokens with a token credential (Step 1).
- `a.session.kind` is not `"token"` for Bearer callers in the live code.
- The fix appears to need changes to `app.ts`.

## Maintenance notes
Existing tokens keep working without expiry (no migration; intentional). A follow-up (not here): list endpoint with creation time/last-used. Reviewer: confirm `readOnly` default stays `true`.
