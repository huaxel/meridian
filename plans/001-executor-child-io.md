# Plan 001: Make executor child I/O crash-safe and UTF-8-correct

> **Executor instructions**: Follow step by step. Run every verification command and confirm the expected result before the next step. If a STOP condition occurs, stop and report; do not improvise. Do NOT commit or push; leave changes uncommitted in your worktree. Do not edit `plans/README.md` (the reviewer maintains it).
>
> **Environment**: your worktree has no `node_modules`. Run `ln -s /home/juan/projects/meridian/node_modules node_modules` (it is gitignored). `pnpm` may not be on PATH; use `node_modules/.bin/vitest run <file>` and `node_modules/.bin/tsc --noEmit` instead of `pnpm test` / `pnpm typecheck`.
>
> **Drift check (run first)**: `git diff --stat 4c3f281..HEAD -- services/executor/src/server.ts`. If it changed, compare the excerpts below with the live code; on mismatch STOP.

## Status
- **Priority**: P1 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: bug
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
In `services/executor/src/server.ts` the `/execute` handler spawns a child process and writes the job to its stdin. (1) There is no `error` listener on `child.stdin`: if the child exits before reading (user-namespace denied, seccomp, import failure, SIGKILL at timeout), Node emits `EPIPE` on stdin, which with no listener is an uncaught exception that kills the whole executor and every in-flight job. (2) `out += x` and `err += x` concatenate raw `Buffer` chunks with string coercion, so a multi-byte UTF-8 character split across two chunks becomes U+FFFD, silently corrupting non-ASCII sample values and profile text.

## Current state (at 4c3f281)
`services/executor/src/server.ts`, inside `app.post("/execute", ...)`, around lines 248-283:
```ts
let out = "",
    err = "";
...
child.stdout.on("data", (x) => {
  out += x;
  if (out.length > 10_000_000) child.kill("SIGKILL");
});
child.stderr.on("data", (x) => (err += x));
child.on("error", (e) => { ... });
child.on("close", (code) => { ... });
child.stdin.end(JSON.stringify(job));
```
Conventions: ESM TypeScript, 2-space indent, double quotes, vitest tests in `tests/`, no semicolon-free style. Model the new test on `tests/executor-runner-launch.test.ts` (small pure-unit test of an executor helper).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Focused test | `node_modules/.bin/vitest run tests/executor-child-io.test.ts` | all pass |
| Typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Full tests | `node_modules/.bin/vitest run` | all pass (some skipped) |

## Scope
**In scope**: `services/executor/src/server.ts`, `services/executor/src/child-io.ts` (create), `tests/executor-child-io.test.ts` (create).
**Out of scope**: `engine.ts`, `scratch.ts`, sandbox/mount code, any other `server.ts` logic (e.g. persist handling), `gate.ts`.

## Steps
### Step 1: create `services/executor/src/child-io.ts`
Export `attachChildIo(child: ChildProcessWithoutNullStreams, opts: { maxOut: number; onOverflow: () => void })` returning `{ out(): string; err(): string }`. It must: call `child.stdout.setEncoding("utf8")` and `child.stderr.setEncoding("utf8")`; append chunks to strings; call `opts.onOverflow()` once when `out.length > opts.maxOut`; and register `child.stdin.on("error", () => {})` (the `close`/exit path already reports failure). Add a comment explaining why the stdin listener must exist (EPIPE on early child exit).
**Verify**: `node_modules/.bin/tsc --noEmit` → exit 0.

### Step 2: use it in `server.ts`
Replace the `let out/err` string accumulation and the two `data` listeners with `const io = attachChildIo(child, { maxOut: 10_000_000, onOverflow: () => child.kill("SIGKILL") })`; replace later reads of `out`/`err` with `io.out()`/`io.err()` (including `err.slice(0, 1500)` and `JSON.parse(out)`). Keep the `error`/`close` handlers and the `child.stdin.end(...)` call unchanged.
**Verify**: `grep -n "out += x\|err += x" services/executor/src/server.ts` → no matches; `node_modules/.bin/tsc --noEmit` → exit 0.

### Step 3: tests (`tests/executor-child-io.test.ts`)
Use `node:child_process` `spawn`:
1. Spawn `node -e` that writes the 3-byte UTF-8 char "€" as two separate stdout writes of raw bytes (first 1 byte, then 2 bytes, with a short delay between) and assert `io.out()` equals "€" after `close` (without `setEncoding` it would contain U+FFFD).
2. Spawn `node -e "process.exit(0)"`, then write a large string to `child.stdin` and `end()`; assert the process does not throw an uncaught exception (the test completes and `close` fires).
3. Output over `maxOut` triggers `onOverflow` exactly once.
**Verify**: focused test command → 3 tests pass.

## Done criteria
- [ ] `node_modules/.bin/tsc --noEmit` exits 0
- [ ] `node_modules/.bin/vitest run` exits 0 with the 3 new tests passing
- [ ] `grep -n "out += x\|err += x" services/executor/src/server.ts` returns nothing
- [ ] `git status --short` shows only the three in-scope files (plus the gitignored node_modules symlink)

## STOP conditions
- The excerpts above do not match `server.ts`.
- Typing `attachChildIo`'s child parameter requires changes outside the in-scope files.
- A step's verification fails twice after a reasonable fix.

## Maintenance notes
Any new code that spawns the runner must use `attachChildIo` so it inherits both protections. Reviewer: confirm the 10 MB cap is still measured in characters as before (behavior unchanged), and that error text sent to clients is unchanged apart from correct decoding.
