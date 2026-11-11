# Plan 008: Stop poison-job loops and stop re-running jobs that already succeeded

> **Executor instructions**: Follow step by step; verify each. STOP conditions apply. Do NOT commit or push. Do not edit `plans/README.md`.
>
> **Environment**: `ln -s /home/juan/projects/meridian/node_modules node_modules`; `pnpm` may be absent: use `node_modules/.bin/vitest run <file>` and `node_modules/.bin/tsc --noEmit`.
>
> **Drift check**: `git diff --stat 4c3f281..HEAD -- apps/api/src/jobs.ts tests/jobs.test.ts`. Mismatch = STOP.

## Status
- **Priority**: P2 · **Effort**: S · **Risk**: MED (job ordering/ retry semantics; `tests/jobs.test.ts` guards it) · **Depends on**: none · **Category**: bug
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
In `apps/api/src/jobs.ts` (worker loop) two retry-accounting holes exist. (1) The claim transaction increments `attempts` every time, including when it reclaims a job whose lease expired because the worker died mid-job (OOM/crash). The 3-attempt cap is checked only in the `catch` path, which a crashing worker never reaches, so a job that kills the worker is reclaimed forever (attempts 4, 5, ...) with no `failed` status and no finding. (2) The success-completion transaction sits inside the same `try` as the handler; if it throws (for example repeated 409 conflicts), the `catch` treats a handler that already succeeded as failed and re-queues it, re-running a completed import or sync.

## Current state (`apps/api/src/jobs.ts` at 4c3f281, claim at ~line 103, completion ~line 140-165)
```ts
const claimed = await transaction(store, scope, async (tx) => {
  const r = await tx.get(candidate.id);
  if (!r || !["queued","running"].includes(r.data.status) ||
      (r.data.status === "running" && r.data.leaseUntil > Date.now())) return false;
  tx.update(r, { ...r.data, status: "running", leaseUntil: Date.now() + 180000,
                 attempts: (r.data.attempts || 0) + 1 });
  return true;
});
if (!claimed) continue;
...
try {
  if (candidate.kind === "run") await buildWorkspace(store, scope, candidate.id);
  else {
    ... await handler(store, scope, candidate);
    await transaction(store, scope, async (tx) => {   // completion
      const r = await tx.get(candidate.id);
      if (r && r.data.status !== "canceled")
        tx.update(r, { ...r.data, status: "succeeded", error: null, progress: { message: "Complete snapshot ready" } });
    });
  }
} catch (e) {
  await transaction(store, scope, async (tx) => {
    const r = await tx.get(candidate.id);
    if (r && r.data.status !== "canceled") {
      tx.update(r, { ...r.data,
        status: r.kind === "job" && (r.data.attempts || 0) < 3 ? "queued" : "failed",
        error: e instanceof Error ? e.message : "Job failed",
        retryAt: Date.now() + Math.min(60000, 1000 * 2 ** (r.data.attempts || 1)) });
      if (r.kind === "job" && (r.data.attempts || 0) >= 3)
        tx.put(resource(scope, "finding", "Failed " + r.name, { kind: "failure", jobId: r.id, dismissed: false,
          evidence: { error: ..., pipelineId: r.data.pipelineId, sourceId: r.data.sourceId } }, "failure_" + r.id));
    }
  });
} finally { clearInterval(heartbeat); }
```
Read the whole worker loop and `tests/jobs.test.ts` (use as the pattern for harness, fake stores and handlers) before editing. `runs` (kind "run") share the loop but the cap logic applies only to `kind === "job"`; keep that.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Focused test | `node_modules/.bin/vitest run tests/jobs.test.ts` | pass |
| Typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Full tests | `node_modules/.bin/vitest run` | pass |

## Scope
**In scope**: `apps/api/src/jobs.ts`, `tests/jobs.test.ts` (extend) or new `tests/jobs-retry.test.ts`.
**Out of scope**: workspace fairness (`break` after one job), heartbeat/lease timing, job deadlines, handlers, `source-sync.ts`.

## Steps
### Step 1: cap on reclaim
In the claim transaction, before updating: if `r.kind === "job" && r.data.status === "running" && (r.data.attempts || 0) >= 3` (an expired-lease reclaim past the cap), instead `tx.update` it to `status: "failed"` with `error: "Job exceeded its retry limit after the worker was interrupted"`, `tx.put` the same `finding` resource shape as the catch path, and `return false`. Factor the finding creation into a small local function used by both places so the shapes cannot diverge.
**Verify**: `node_modules/.bin/tsc --noEmit` → exit 0.

### Step 2: separate completion failures from handler failures
Track `let handlerDone = false;` set true immediately after `await handler(...)` resolves (and after `buildWorkspace` for runs). Run the completion transaction with up to 5 attempts and backoff (250 ms × attempt), outside the handler's `catch` handling: if completion keeps failing, log with `console.error` and leave the job `running` so the lease expires normally — do NOT requeue it as failed. In the `catch` block, if `handlerDone` is true, do nothing except log. Keep the existing `canceled` check.

### Step 3: tests (`tests/jobs.test.ts`, using its harness)
(a) a job whose `attempts` is already 3 with `status: "running"` and an expired `leaseUntil` is marked `failed` and a failure finding exists, and its handler is NOT invoked; (b) a job whose handler succeeds but whose completion transaction is forced to throw once keeps `attempts === 1`, is never requeued, and is `succeeded` after the retry; (c) the existing retry-on-handler-error behavior still requeues until attempt 3 then fails.
**Verify**: focused test → pass.

## Done criteria
- [ ] `node_modules/.bin/tsc --noEmit` exits 0
- [ ] `node_modules/.bin/vitest run` exits 0 incl. new tests
- [ ] `git status --short` shows only in-scope files

## STOP conditions
- The live worker loop differs materially from the excerpt.
- You cannot force a completion-transaction failure in the test harness without restructuring `jobs.ts` beyond this plan.
- Existing tests assert that an over-cap running job is re-run.

## Maintenance notes
A re-queued job's handler must stay idempotent (this plan reduces but does not eliminate re-runs after a real crash mid-handler). Reviewer: scrutinize that `handlerDone` is set before any code that can throw. Deferred: per-tick workspace fairness, job-level deadline, pruning succeeded job history.
