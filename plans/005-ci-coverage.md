# Plan 005: Make CI build the server, run the sandbox suite, and stop duplicate runs

> **Executor instructions**: Follow step by step; verify each. STOP conditions apply. Do NOT commit or push. Do not edit `plans/README.md`. Do not push to GitHub or trigger workflows.
>
> **Environment**: `ln -s /home/juan/projects/meridian/node_modules node_modules`; `pnpm` may be absent: use `node_modules/.bin/tsc` and `node_modules/.bin/vitest` directly where noted.
>
> **Drift check**: `git diff --stat 4c3f281..HEAD -- .github/workflows/ci.yml package.json tests/executor-sandbox.test.ts`. Mismatch = STOP.

## Status
- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: dx/tests
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
CI (`.github/workflows/ci.yml`) runs only install, typecheck, test, build. The Dockerfile runs `pnpm build:server` (the NodeNext emit used in production), so an emit failure appears only at image build. The streaming-executor escape-regression suite (`tests/executor-sandbox.test.ts`, the repo's main isolation claim, documented in `docs/VALIDATION.md`) is gated behind `TEST_EXECUTOR_SANDBOX=1` and never runs in CI. The workflow also triggers on both `push` and `pull_request` (duplicate runs per PR push) and has no concurrency group or timeout.

## Current state
`.github/workflows/ci.yml` (entire file):
```yaml
name: CI
on: [push, pull_request, workflow_dispatch]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.7.0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```
`package.json` scripts: `build:server` = `tsc -p tsconfig.server.json`. Line 10 of `tests/executor-sandbox.test.ts` shows the env gate; read the top of the file to learn the exact variable and what it needs (`unshare`, user namespaces).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Server emit | `node_modules/.bin/tsc -p tsconfig.server.json --noEmit` | exit 0 |
| YAML parse | `python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'))"` | exit 0 (if `yaml` missing, review by eye and say so) |
| Sandbox suite locally (optional) | `TEST_EXECUTOR_SANDBOX=1 node_modules/.bin/vitest run tests/executor-sandbox.test.ts` | pass or report precise skip/failure |

## Scope
**In scope**: `.github/workflows/ci.yml` only.
**Out of scope**: adding lint/prettier (would reformat the repo), Playwright in CI, Dependabot, Dockerfile, any test code.

## Steps
### Step 1: tighten triggers and add hygiene to `check`
Change `on:` to `push: { branches: [main] }`, `pull_request:`, `workflow_dispatch:`. Add top-level `concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` and `timeout-minutes: 30` on the job.

### Step 2: build the server emit
After `pnpm build` add `- run: pnpm build:server`.
**Verify**: the `tsc -p tsconfig.server.json --noEmit` command above → exit 0.

### Step 3: add a non-blocking sandbox job
Add job `sandbox` (ubuntu-latest, `timeout-minutes: 20`, `continue-on-error: true`) with the same checkout/pnpm/node/install steps, then `- run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true` (GitHub runners may restrict unprivileged user namespaces; the `|| true` keeps it harmless where the sysctl is absent) and `- run: TEST_EXECUTOR_SANDBOX=1 pnpm vitest run tests/executor-sandbox.test.ts`. Add a YAML comment stating it is non-blocking until it has proven stable on GitHub runners, after which `continue-on-error` should be removed.
**Verify**: YAML parse command → exit 0.

## Done criteria
- [ ] YAML parses
- [ ] `node_modules/.bin/tsc -p tsconfig.server.json --noEmit` exits 0
- [ ] The workflow still contains the original typecheck/test/build steps unchanged
- [ ] `git status --short` shows only `.github/workflows/ci.yml`

## STOP conditions
- `tsconfig.server.json` emit check fails on a clean tree (report; it means CI would break).
- The sandbox suite's gate variable is not `TEST_EXECUTOR_SANDBOX`.

## Maintenance notes
Once the sandbox job is green for a while, drop `continue-on-error`. Deferred: prettier check (needs a one-off format commit first), Playwright job, `pnpm audit` step, Dependabot.
