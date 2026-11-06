# Composite record identity — design for approval (not implemented)

Status: implemented (user-approved) — `SuggestedEntity.keyKind` /
`compositeKey`, per-variant component resolution in `suggest.ts`, surrogate
promotion in `bundle.ts` (materializing only), schema-only refusal with
recorded reasons, measured pipeline checks. Catalog composite declarations
(e.g. DFKKOP's `OPBEL+OPUPW+OPUPK+OPUPZ`) remain advisory-only until the
measured promotion passes: validation still requires proven identity, and
composite expressions are never quoted as columns.

Deviation from the draft (same guarantee, less machinery): no separate
composite-evidence map was added. Promotion evidence is the pipeline's own
measured checks (surrogate uniqueness + non-null + source blank screen)
plus recorded input versions — re-asserted on every validation, fail-closed
on stale versions via the existing fingerprint guard.

## Objective (unchanged scope)

Let a catalog-declared composite become a usable record identity only when its
joint uniqueness and non-nullness are proven over the actual source data —
without rescanning large tables more than once and without weakening any
existing single-column guarantee.

## Proposed record contract

- `Info` gains `compositeKey?: { columns: string[] }` — physical, resolved
  literal columns only. Unresolvable or ambiguous components fail closed at
  suggestion time with the existing review note; nothing is invented.
- Resolution reuses `resolveColumn` per component within one extract variant
  (never the cross-extract union), exactly as single-column declarations do.
- The suggested entity carries `keyKind: "single" | "composite"` alongside
  `key`. Downstream consumers must branch on `keyKind`, never parse the key
  string. `SuggestedEntity.key` stays a display label for composites until
  promotion.

## Promotion rule (the only path to published identity)

A composite promotes to a published identity only if, over the anchor
dataset's active version:

1. Every component is non-null (`count(*)-count(c) = 0` per component — one
   pass, same scan shape as the profiler's per-column aggregates).
2. The joint tuple is unique (`count(*) = count(DISTINCT (c1, c2, …))` —
   DuckDB row-value comparison; single aggregate query, no materialization).
3. No component is an empty string (reuse the `blanks` profile count where
   measured; else count in the same pass as (1)).

All three run as read-only `persist:false` aggregates with the existing
memory-fallback discipline (approximate or abstain, never claim). Failure of
any rule keeps the entity on its fallback identity (alt/provisional key) with
a retained omission-style reason naming the failed rule and counts.

## Validation and bundle changes

- `validateBundle` gains an `Ontology: <type>` sub-check for composites:
  re-run the three aggregates against the declared components and fail closed
  (`Unknown property`, count mismatch) before any executor access beyond the
  aggregates themselves.
- `bundle.ts` materializing path: the merged-output primary key becomes a
  surrogate `keyColumns` entry computed as a normalized tuple hash
  (`lower(trim(CAST(c AS VARCHAR)))` joined with a separator), following the
  existing case-insensitive normalization pattern — never string
  concatenation, which collides (`"a"+"bc"` vs `"ab"+"c"`).
- Non-materializing path: the published `primaryKey` must be one physical
  column; a promoted composite therefore publishes through the surrogate
  only. Schema-only publication of a composite-identified type is refused
  until the surrogate exists (fail closed, explicit message).
- Proposals require the promotion evidence (the three counts + input
  versions) in `relationshipEvidence`-style saved evidence; revalidation
  re-asserts counts against current versions, and stale versions fail closed
  via the existing fingerprint guard.

## What is explicitly out of scope

- Multi-column joins (relationships already carry single from/to columns;
  composite foreign keys are a separate design).
- Backfilling promotion for the currently published generation (needs the
  rebuild runbook, a live action).
- DDIC-completeness claims: matching one DDIC key component proves nothing;
  promotion rests on measured counts only.

## Acceptance (all must hold before merge)

- New isolated fixtures: resolvable composite promotes; one null-bearing,
  one duplicate-bearing, one unresolvable-component declaration each fail
  with a named retained reason; surrogate keys never collide on adversarial
  separator cases.
- Full gate green: typecheck, full suite, web/server builds, diff-check.
- No full-table scans beyond the bounded aggregate pass; no Parquet
  rewrites; no live activation in tests (executor mocks throw).

## Spike evidence (2026-10-17, isolated DuckDB, no repo/live changes)

- Row-value joint check works: 6 rows with one duplicate pair yield
  `count(*)=6, count(DISTINCT (c1,c2))=5`. The null-bearing tuple counts as
  distinct, so the joint check is only meaningful after the non-null rule
  passes — the promotion order (1) then (2) is load-bearing, not stylistic.
- Separator requirement confirmed: naive `c1 || c2` collides `('a','bc')`
  with `('ab','c')` (1 distinct), while `chr(31)`-joined gives 2. Never
  ship plain concatenation as an identity.
- Surrogate shape `lower(trim(CAST(c AS VARCHAR)))` per component works;
  residual: a component containing chr(31) itself, or an all-NULL row
  (whole expression becomes NULL), would collide — both unreachable when
  rules (1) and (3) pass first, but an implementation must keep that order.

## Risks and unknowns

- Wide composites on huge tables may hit the 128MB aggregate limit seen
  with BUT000; mitigation is the same per-column-then-joint sequence, but
  worst-case cost is unproven — needs a bounded measurement on one large
  table before committing to the approach.
- Surrogate keys change published primaryKey values for affected types;
  downstream consumers of those IDs must be checked at implementation time.

Approval requested: proceed to implementation under these terms, amend, or
keep advisory-only.
