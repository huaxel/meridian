# Plan 007: Time-box Postgres and S3 imports so one stalled source cannot hold the worker forever

> **Executor instructions**: Follow step by step; verify each. STOP conditions apply. Do NOT commit or push. Do not edit `plans/README.md`. Never connect to real databases or buckets; tests are unit-level. Never print credentials.
>
> **Environment**: `ln -s /home/juan/projects/meridian/node_modules node_modules`; `pnpm` may be absent: use `node_modules/.bin/vitest run <file>` and `node_modules/.bin/tsc --noEmit`.
>
> **Drift check**: `git diff --stat 4c3f281..HEAD -- apps/api/src/connectors.ts apps/api/src/postgres-config.ts tests/postgres-config.test.ts`. Mismatch = STOP.

## Status
- **Priority**: P2 · **Effort**: S–M · **Risk**: LOW–MED (timeout too short would break big imports) · **Depends on**: none · **Category**: bug
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
The worker runs one job at a time and renews the job lease every 30 s for as long as the process is alive (`apps/api/src/jobs.ts`). A Postgres import (`DECLARE ... CURSOR` then `FETCH 1000` in a loop, `apps/api/src/connectors.ts` ~lines 425-440) has no statement/query timeout, and an S3 `GetObject` body read (~line 512) has no abort signal. A black-holed connection, locked table or half-open TCP socket therefore blocks the only worker slot forever and starves every workspace. MySQL (120 s timer) and REST (30 s per request) already have limits.

## Current state
`apps/api/src/postgres-config.ts` (end of the config builder) returns:
```ts
  return {
    host, port, user, password, database,
    application_name: applicationName,
    enableChannelBinding: !!c.enableChannelBinding,
    max: 2,
    connectionTimeoutMillis: 10000,
    ssl: tls ? { rejectUnauthorized: true, ...(c.ca ? { ca: c.ca } : {}) } : false,
  };
```
`connectors.ts`: `"DECLARE foundry_cursor NO SCROLL CURSOR FOR SELECT * FROM " + ...` then `await client.query("FETCH 1000 FROM foundry_cursor")` in a loop; S3: `new GetObjectCommand({ Bucket: c.bucket, Key: c.key })` sent via an `S3Client`, body streamed to disk. Read these regions fully before editing. Test pattern: `tests/postgres-config.test.ts`.
`pg` supports `statement_timeout` and `query_timeout` (milliseconds) on the client/pool config.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Focused test | `node_modules/.bin/vitest run tests/postgres-config.test.ts tests/connectors.test.ts` | pass |
| Typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Full tests | `node_modules/.bin/vitest run` | pass |

## Scope
**In scope**: `apps/api/src/postgres-config.ts`, `apps/api/src/connectors.ts` (Postgres FETCH loop and S3 GetObject only), `tests/postgres-config.test.ts`, optionally a new small test.
**Out of scope**: `jobs.ts` (job-level deadline is a follow-up), MySQL/REST connectors, CDC/replication code (`source-sync.ts`), heartbeat logic.

## Steps
### Step 1: Postgres per-statement timeouts
In `postgres-config.ts` add `statement_timeout` and `query_timeout`, both `Number(process.env.IMPORT_QUERY_TIMEOUT_MS) || 300_000` (5 minutes per statement; each FETCH of 1000 rows is one statement, so total import time is not limited by this). Do it where the shared config is built so every Postgres use gets it; then check the CDC/replication path (`source-sync.ts` and `hf-postgres-*` usage) does not reuse this config for a long-lived replication connection: grep for callers of the builder. If a replication/streaming caller uses it, add the timeouts only for the import path instead (e.g. a parameter) and STOP-report if that is unclear.

### Step 2: S3 abort
Wrap the `GetObject` send and body streaming with an `AbortController` aborted by a deadline timer: `Number(process.env.IMPORT_S3_TIMEOUT_MS) || 30 * 60_000`, passing `{ abortSignal: controller.signal }` to `client.send(...)` and clearing the timer in a `finally`. Make sure the destination write stream is closed/destroyed on abort and the error message says the S3 import timed out.

### Step 3: tests
Extend `tests/postgres-config.test.ts`: the built config contains `statement_timeout` and `query_timeout` equal to 300000 by default and honours `IMPORT_QUERY_TIMEOUT_MS` (set/unset env inside the test). For S3, only add a test if you can do it without network (e.g. extract the deadline helper into a small function and test that it aborts); otherwise note in your report that S3 is typecheck-verified only.
**Verify**: focused tests → pass; `node_modules/.bin/tsc --noEmit` → exit 0.

## Done criteria
- [ ] `node_modules/.bin/tsc --noEmit` exits 0
- [ ] `node_modules/.bin/vitest run` exits 0
- [ ] `grep -n "statement_timeout\|query_timeout" apps/api/src/postgres-config.ts` shows both
- [ ] `git status --short` shows only in-scope files

## STOP conditions
- The Postgres config builder is shared with a long-lived replication connection and cannot be split cheaply.
- The `S3Client` version in use does not accept `abortSignal` in `send` options (check types).
- Live code differs from the excerpts.

## Maintenance notes
Defaults are deliberately generous; document the two env vars in `docs/OPERATIONS.md` ONLY if that file has an env-var table (add rows; otherwise skip). Follow-up: a job-level deadline in `jobs.ts` and heartbeat max-age as defense in depth.
