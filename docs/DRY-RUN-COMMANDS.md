# Pre-rebuild dry-run — paste-ready commands (nothing here activates)

Conventions: run the `git`/`pnpm` block on the machine that holds
`/home/juan/projects/meridian`. Run the `curl` block wherever the app is
reachable. Set `$BASE` to the app origin, `$SCOPE` to the workspace id, and
`$PUBLISHED` to the currently published proposal id (all visible from
`GET /api/v1/me` and the Ontology page — never guess UUIDs). Authenticate
exactly as the web app does.

What these commands do and do not do: the `validate` call mints one draft
child proposal record so the result is reviewable history. It stages no rows,
activates nothing, and publishes nothing. `publish`, `reject`, `rollback`
and re-imports are deliberately absent below — those are live steps from
REBUILD-RUNBOOK.md, not dry-run steps.

## 0. Worktree and gates (exact commit under test)

```bash
cd /home/juan/projects/meridian
git status --short
git diff --check
pnpm typecheck
pnpm build:server
```

`pnpm test` (≈90s) and `pnpm build` (web) complete the gate when you want
the full signal. Do not proceed with any red step.

## 1. App reachability (no writes)

```bash
curl -sS "$BASE/api/v1/me" | jq '{user: .user.id, workspaces: [.workspaces[].id]}'
```

Expect HTTP 200 and your `$SCOPE` in the list.

If `me` returns 401 while the web app works, your shell has no session —
log in exactly as the app does and reuse the cookie:

```bash
set -a; source /home/juan/projects/meridian/.env; set +a  # loads AUTH_PASSWORD
curl -sS -c /tmp/meridian-cookie -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -d "{\"password\":\"$AUTH_PASSWORD\"}"
curl -sS -b /tmp/meridian-cookie "$BASE/api/v1/me" | jq '{user: .user.id}'
```

If login itself 401s with the `.env` password, the running container
booted with a different value (observed 2026-10-17: healthy 8h-old stack
rejecting the current `.env`). `docker compose restart app` re-syncs the
stack with the current `.env`; or export the boot-era password instead.
Do not bake the real password into these commands — pass it via env.

## 2. Revalidate the published proposal (mints one draft, activates nothing)

```bash
curl -sS -X POST "$BASE/api/v1/workspaces/$SCOPE/proposals/$PUBLISHED/validate" \
  | tee /tmp/dryrun-validate.json | jq '{status: .data.status, valid: .data.validation.valid}'
```

- HTTP 200 + `valid: true`: inputs current; continue triage below.
- HTTP 409: stale or missing inputs — the error detail names the dataset.
  That dataset goes on the re-import/exclude list (runbook step 1). The
  last audited baseline was 20 files (4 size, 16 mtime) over 8 published
  types and 5 links; confirm the current set, do not assume it.
- HTTP 200 + `valid: false`: inspect the failures, do not publish:

```bash
jq '.data.validation.checks | map(select(.passed == false) | {name, detail})' /tmp/dryrun-validate.json
```

## 3. Omission history must be complete (no legacy markers)

```bash
jq '[.data.validation.omissions[]? | select((.reasons | join(" ")) | contains("no individual failure detail"))] | length' /tmp/dryrun-validate.json
jq '[.data.validation.omissions[]? | {kind, name, reasons}]' /tmp/dryrun-validate.json
```

First command must print `0`. Any legacy marker means the proposal predates
omission retention — stop and rebuild the suggestion instead of reasoning
about headline counts.

## 4. Plan-time notes: composites, duplicates, widgets, blanks

```bash
jq '.data.bundle.assumptions' /tmp/dryrun-validate.json
jq '.data.validation.checks | map(select(.detail | contains("blank key value")) | {name, detail})' /tmp/dryrun-validate.json
jq '[.data.validation.previews | keys[] | select(startswith("relation:")))] | length' /tmp/dryrun-validate.json
```

- `Omitted "…" from the plan` with composite key: expected for
  composite-declared entities in a schema-only plan; each needs a
  materialized build (design doc) or exclusion — never a hand-written key.
- `Omitted duplicate relationship suggestion`: expected single collapse
  (the historical double plate edge must show exactly one survivor).
- `dashboard widget … omitted`: cross-check the count against the overview
  dashboard actually served.
- Blank-key warnings: warnings only — decide per type (fix source, accept,
  or drop from setup) before any republication.
- Relation preview count must equal the published relationship count;
  every entry carries coverage/cardinality/evidence (never infer measurement
  from an `asserted` basis).

## 5. Stop conditions (all must hold; else stop, do not publish)

1. Gates green on the deployed commit; worktree matches it (no stray diff).
2. Revalidation `valid: true` with zero failed checks.
3. Zero legacy omission markers; every omitted entity/link has a retained reason.
4. Every stale-fingerprint dataset triaged to re-import (sequentially,
   largest last) or explicit exclusion.
5. Blank-key warnings dispositioned per type.

Rollback rule: any failure above → stop, keep builds paused, restore the
store snapshot. Never hand-edit fingerprints, markers, or omission history
to force green.
