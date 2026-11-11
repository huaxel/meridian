# Plan 006: Decide exact vs approximate distinct counts per column, not sticky for the whole profile

> **Executor instructions**: Follow step by step; verify each. STOP conditions apply. Do NOT commit or push. Do not edit `plans/README.md`.
>
> **Environment**: `ln -s /home/juan/projects/meridian/node_modules node_modules`; `pnpm` may be absent: use `node_modules/.bin/vitest run <file>` and `node_modules/.bin/tsc --noEmit`.
>
> **Drift check**: `git diff --stat 4c3f281..HEAD -- services/executor/src/engine.ts tests/engine-memory-fallback.test.ts`. Mismatch = STOP.

## Status
- **Priority**: P2 · **Effort**: S · **Risk**: LOW–MED · **Depends on**: none (touches `engine.ts`, so do not run in parallel with a plan editing the same lines) · **Category**: bug
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
`services/executor/src/engine.ts` profiles each column with an exact `count(DISTINCT)`; if DuckDB hits a memory limit it falls back to `approx_count_distinct`. The flag that records the fallback, `approximateDistincts`, is a single `let` shared by all columns, and each column starts with `exact = !approximateDistincts`. So after ONE memory error every later column skips the exact pass. `primaryKey` detection requires `exact`, so a genuine key column that happens to come after a wide column is never recognised, and discovery then drops entities for lack of a key. The comment directly above the declaration says the intent is the opposite: "a single wide column never strips key evidence from the other columns".

## Current state (`services/executor/src/engine.ts` at 4c3f281, ~lines 500-560)
```ts
    // ... strips key evidence from the other columns.
    let approximateDistincts = job.approximateProfile === true;
    const columns = [];
    for (const [i, col] of schema.entries()) {
      ...
      let null_count: unknown, distincts: unknown, blanks: unknown,
        exact = !approximateDistincts;
      if (exact) {
        try { ...exact count(DISTINCT)... }
        catch (error) {
          if (!isMemoryLimitError(error)) throw error;
          approximateDistincts = true;
          exact = false;
        }
      }
      if (!exact) {
        try { ...approx_count_distinct... }
        catch (error) {
          if (!isMemoryLimitError(error)) throw error;
          approximateDistincts = true;
          ...sampled fallbacks...
        }
      }
```
Later (~line 626) `approximateDistincts || approximateDuplicates` decides the profile-level `approximate` marker, and `primaryKey` (~line 577-581) requires the per-column `exact`. Read the whole loop and the code at 570-630 before editing. Existing test to model on and keep green: `tests/engine-memory-fallback.test.ts`.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `node_modules/.bin/vitest run tests/engine-memory-fallback.test.ts tests/engine.test.ts` | pass |
| Typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Full tests | `node_modules/.bin/vitest run` | pass |

## Scope
**In scope**: `services/executor/src/engine.ts`, `tests/engine-memory-fallback.test.ts` (extend) or a new `tests/engine-profile-per-column.test.ts`.
**Out of scope**: partitioning code, the persist/sandbox logic in `execute`, `server.ts`, the profile output shape.

## Steps
### Step 1: read the existing test first
Open `tests/engine-memory-fallback.test.ts`. If it asserts that columns AFTER a failing column are approximate (i.e. it encodes the sticky behavior as intended), STOP and report that conflict.

### Step 2: separate the two meanings of the flag
Introduce `const forceApproximate = job.approximateProfile === true;` and keep `let approximateDistincts = forceApproximate;` ONLY as the profile-level "any column was approximate" marker. Change per-column initialisation to `exact = !forceApproximate` (not `!approximateDistincts`). Leave both `approximateDistincts = true` assignments in the catch blocks (they still mark the profile-level flag). Do not change any other logic.
**Verify**: `node_modules/.bin/tsc --noEmit` → exit 0.

### Step 3: test
Follow how `engine-memory-fallback.test.ts` simulates a memory limit (read it; reuse its mechanism, do not invent one). Add a case: a table whose FIRST column triggers the fallback and whose LAST column is a unique non-null key. Assert the last column is reported `primaryKey: true` (exact) while the first is approximate, and the profile-level `approximate` marker is still true.
**Verify**: focused tests → pass. Also confirm the new test FAILS on the old code: `git stash` is forbidden here; instead temporarily revert Step 2 with an edit, run the new test to see it fail, then restore.

## Done criteria
- [ ] `node_modules/.bin/tsc --noEmit` exits 0
- [ ] `node_modules/.bin/vitest run` exits 0 incl. the new test
- [ ] `git status --short` shows only in-scope files

## STOP conditions
- The existing test encodes the sticky behavior (Step 1).
- You cannot reproduce a memory-limit failure in a test using the existing mechanism.
- The live loop differs from the excerpt.

## Maintenance notes
Trade-off: after one OOM, later columns now attempt the exact pass first (each may also hit the limit and fall back individually, costing time on very wide tables). Reviewer: watch profile time on wide tables; if it regresses, add a bounded retry budget rather than restoring stickiness.
