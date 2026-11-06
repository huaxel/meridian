# Trusted rebuild runbook — plan only (no live steps executed)

Objective: bring the live published generation up to the current code's
guarantees (omission retention, evidence-required relationships, duplicate
collapse, blank-key warnings, post-publication revision separation) without
regenerating source Parquets and without surprise pruning.

Preconditions (do not start otherwise):

- Full gate green on the exact commit being deployed.
- A fresh backup/snapshot of the workspace store exists and restores cleanly.
- Maintenance window accepted: builds and publications are paused; no
  half-applied state is possible mid-run (each step below is read-only until
  the explicit republication step).

Step 1 — Fingerprint triage (read-only):

- Run the app's source-freshness validation (dry-run/revalidate path that
  performs no writes) and list every dataset whose stored fingerprint differs
  from its mounted file. Known baseline from the last audit: 20 files
  (4 size, 16 mtime) affecting 8 published types and 5 published links.
- For each stale dataset decide: re-import (reprofiles; machine-cost guilty —
  do them sequentially, largest last, watching memory) or exclude from setup
  if no longer needed. Do not publish while any published endpoint is stale:
  validation fails closed (409) by design.

Step 2 — Preview the new suggestion (read-only):

- Trigger a fresh suggestion and compare against the live published bundle:
  expect the 19 previously-missing member links to appear with raw
  dataset+column pairings, the exact-duplicate plate edge to collapse to one
  entry with a duplicate note, and composite/unresolved keys to carry review
  notes instead of usable identities.
- Confirm every omitted entity/link carries a retained reason (no
  "no individual failure detail" markers) and every relationship carries
  saved evidence with a stated match basis.

Step 3 — Review blank-key warnings (read-only):

- New imports record `blanks`; legacy profiles stay silent until re-import.
  Known cases to watch: ZBP_ADDRESS, ZBP_ADDRESS_WITH_ADDR_CODE,
  ZALCC_INFRACTION, ZPP_ADDRESS, ZFI_UNAUTH_IBAN, ZBP_BANK_ACCOUNT, HR
  definitions sheet Unnamed:3. Warnings never prune — decide per type
  whether to fix source data, accept, or drop the type from setup before
  publishing.

Step 4 — Republication (the only write step):

- Confirm the reviewed suggestion (approval hash pins the exact inputs) and
  let the confirmed build prune with retained reasons, then publish through
  the ordinary human-review route.
- Verify: same generation throughout; validation `valid:true` with all
  checks passing; omissions list complete; relationship previews show
  coverage/cardinality/evidence; no succeeded-run histories rewritten
  (parentId lineage only).

Step 5 — Legacy cleanup (verified after):

- Legacy anchor-only publications without a mode marker still require a
  rebuild rather than guessing — do not backfill markers by hand.
- Keep the pre-rebuild audit archives
  (`/home/juan/helix-foundry-audits/atom-ontology-20261017-172039/`) as the
  historical record; record the new generation ID and validation summary
  alongside them.

Rollback: if any verification fails, stop, keep the paused state, and restore
the store snapshot. Never hand-edit fingerprints, markers, or omission
history to force a green run — a forced green is worse than a red hold.
