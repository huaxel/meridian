# Plan 002: Make `scripts/restore.sh` validate the backup before destroying anything

> **Executor instructions**: Follow step by step; verify each step. STOP conditions apply. Do NOT commit or push; leave changes uncommitted. Do not edit `plans/README.md`. NEVER run `restore.sh --replace`, `docker compose down`, `docker volume rm`, or anything touching real volumes: tests use a fake `docker` shim only. NEVER print or cat `.env` or any `config.env`.
>
> **Environment**: no `node_modules` in your worktree: `ln -s /home/juan/projects/meridian/node_modules node_modules` (gitignored). `pnpm` may be absent; use `node_modules/.bin/vitest run <file>`.
>
> **Drift check**: `git diff --stat 4c3f281..HEAD -- scripts/restore.sh scripts/backup.sh`. On change, compare with excerpts; mismatch = STOP.

## Status
- **Priority**: P1 · **Effort**: S–M · **Risk**: MED (destructive path; edit carefully) · **Depends on**: none · **Category**: bug/tests
- **Planned at**: commit `4c3f281`, 2026-11-10

## Why this matters
Restore is the data-loss safety net. Today `scripts/restore.sh` checks only that three files exist, stops the app, then for each volume runs `find /data ... rm -rf` **before** `tar xzf`. A truncated or corrupt archive leaves an empty volume, and `set -e` stops after the damage. It also overwrites `.env` (which holds the encryption key) from an unvalidated `config.env`. Nothing tests either script.

## Current state (`scripts/restore.sh` at 4c3f281)
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_dir="$(cd "${1:?Usage: scripts/restore.sh BACKUP_DIR --replace}" && pwd)"
[ "${2:-}" = '--replace' ] || { echo 'Pass --replace ...'; exit 1; }
for file in helix-data.tgz foundry-data.tgz config.env; do [ -f "$backup_dir/$file" ] || { echo "Missing $file"; exit 1; }; done
docker compose stop app worker executor helix
project_name="${COMPOSE_PROJECT_NAME:-helix-foundry}"
for volume in helix-data foundry-data; do
  docker run --rm -v "${project_name}_$volume:/data" -v "$backup_dir:/backup:ro" alpine:3.22 sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar xzf "/backup/$1.tgz" -C /data' sh "$volume"
done
cp "$backup_dir/config.env" .env
chmod 600 .env
docker compose up -d helix executor app worker
```
Project rules (AGENTS.md): the Compose project name stays `helix-foundry` and volume names stay `helix-data`/`foundry-data` (do not rename). Never print `.env`/`config.env` contents. `backup.sh` writes the same `*.tgz` and `config.env` files.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Shell syntax | `bash -n scripts/restore.sh` | exit 0 |
| Focused test | `node_modules/.bin/vitest run tests/restore-script.test.ts` | pass |
| Full tests | `node_modules/.bin/vitest run` | pass |

## Scope
**In scope**: `scripts/restore.sh`, `tests/restore-script.test.ts` (create).
**Out of scope**: `scripts/backup.sh`, image pinning (`alpine:3.22` digest), encrypting `config.env`, docs.

## Steps
### Step 1: validate before anything destructive
After the existing missing-file loop and BEFORE `docker compose stop`, add:
1. For each of `helix-data.tgz` and `foundry-data.tgz`: `docker run --rm -v "$backup_dir:/backup:ro" alpine:3.22 tar tzf "/backup/$f" >/dev/null` and abort with `"Backup archive $f is unreadable or corrupt; nothing was changed."` (exit 1) on failure.
2. Validate `config.env` without printing it: `grep -Eq '^ENCRYPTION_KEY=.{32,}$' "$backup_dir/config.env" && grep -Eq '^INTERNAL_KEY=.{32,}$' "$backup_dir/config.env"` else abort with `"config.env is missing a valid ENCRYPTION_KEY or INTERNAL_KEY; nothing was changed."`.
**Verify**: `bash -n scripts/restore.sh` → exit 0.

### Step 2: extract before deleting
Change the per-volume shell so extraction goes to a staging directory first and old contents are removed only after extraction succeeded:
`set -e; rm -rf /data/.restore-staging; mkdir /data/.restore-staging; tar xzf "/backup/$1.tgz" -C /data/.restore-staging; find /data -mindepth 1 -maxdepth 1 ! -name .restore-staging -exec rm -rf {} +; cd /data/.restore-staging; find . -mindepth 1 -maxdepth 1 -exec mv {} /data/ \; ; cd /; rmdir /data/.restore-staging`
(Keep `docker run ... alpine:3.22 sh -c '...' sh "$volume"` form. Keep dotfiles: `find` handles them.)
**Verify**: `bash -n scripts/restore.sh` → exit 0.

### Step 3: test with a fake `docker` shim (`tests/restore-script.test.ts`)
Create a temp dir containing an executable `docker` bash script that appends its arguments to a log file and exits with a status controlled by an env var (`FAKE_TAR_TEST_FAIL=1` makes any invocation whose args include `tzf` exit 1). Run `bash scripts/restore.sh <tmpBackupDir> --replace` with `PATH=<shimdir>:$PATH`. Tmp backup dir contains empty `helix-data.tgz`, `foundry-data.tgz` and a `config.env` whose key lines are 64 chars of `a` (obviously fake). Run from a temp copy of the repo layout so `.env` is NOT overwritten in the real worktree: copy `scripts/restore.sh` into `<tmp>/scripts/` and run it there.
Cases: (a) `tzf` failure → exit non-zero, log contains no `compose stop` and no `rm -rf` run; `.env` absent in tmp. (b) config.env with short keys → non-zero, no `compose stop`. (c) all valid → exit 0, log shows `tzf` checks before `compose stop`, and `.env` exists in tmp with mode 600.
Model on `tests/executor-runner-launch.test.ts` for style; use `node:child_process` `spawnSync`.
**Verify**: focused test → 3 tests pass.

## Done criteria
- [ ] `bash -n scripts/restore.sh` exits 0
- [ ] `node_modules/.bin/vitest run` exits 0 with the 3 new tests passing
- [ ] In test case (a), the shim log has zero `compose stop` lines
- [ ] `git status --short` shows only `scripts/restore.sh` and `tests/restore-script.test.ts`
- [ ] No real docker command was executed (shim only)

## STOP conditions
- `restore.sh` differs from the excerpt.
- You find a need to rename volumes/project name (forbidden).
- Any step would require running real docker or reading a real `.env`.

## Maintenance notes
If `backup.sh` ever adds files to the backup, extend the validation list here. A reviewer should read Step 2's `sh -c` string slowly: it is the destructive line. Deferred: digest-pinning `alpine:3.22`, encrypting `config.env`, a `backup:verify` command.
