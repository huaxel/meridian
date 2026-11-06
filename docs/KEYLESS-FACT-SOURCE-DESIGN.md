# Keyless analytical sources: design

**Status:** implemented locally after user approval; live workspaces, catalogs, and publications remain untouched.

## Problem

Meridian's ontology object type is a *record* type. Each object receives a durable logical ID derived from `typeId + primaryKey`; record paging, direct lookup, edits, related-record navigation, and relationship staging all depend on that key. Making `primaryKey` optional would therefore create unstable or colliding objects, not merely relax validation.

Some selected Local Parquet datasets have no defensible record identity. The current 461-input review draft has 65 such datasets unplaced. Missing keys do not establish that a dataset is a fact table, and observed tuple uniqueness alone does not establish durable business identity.

## Proposed model

Keep record identity strict and introduce a separate **analytical source** definition, stored alongside (not inside) object types:

```ts
 type AnalyticalSource = {
   datasetId: string;
   name: string;
   description: string;
   role: "fact" | "dimension" | "other";
   grain?: string;             // reviewer-authored, explicit row meaning
   dimensions?: string[];      // physical columns
   measures?: string[];        // physical columns
 };
```

The exact field names are provisional. The invariant is not: analytical sources have **no primary key, logical record IDs, or implied row-level identity**. Role and grain are review metadata, not model-inferred facts. A dataset may be classified as `other` when its analytical role is unclear; do not force every keyless table into `fact`.

Represent these definitions in a new `Bundle.analyticalSources` collection, separate from `Bundle.ontology`. Do not make `OntologySchema.primaryKey` optional or synthesize row numbers, hashes, or snapshot-specific IDs. Each source references its existing dataset and physical columns; it does not copy or rewrite source rows.

## Behavior and boundaries

- Analytical sources are visible in ontology review and publication summaries, with an explicit “not a record type” label and no record-count/key claims.
- They remain queryable by existing dataset-backed dashboard and metric SQL. Inclusion in this model does not itself generate metrics, pipelines, or joins.
- They do not appear in Records, object lookup, edit/action flows, record references, or object relationship endpoints. Validation must reject any dependency that treats an analytical source as an object type.
- Existing `relationships` remain object-to-object graph edges. A join to or from a keyless source must not be staged as a record relationship. If analytical joins are needed, introduce a separate, explicitly query-scoped join definition with its own cardinality/fanout evidence and review; do not overload graph edges. Until that is designed, dashboard SQL may express a join directly, with validation and resulting fanout visible.
- A source with a newly established authoritative or owner-approved durable key can be reviewed for promotion to a record type through the existing key-validation path. Promotion is an explicit semantic change, never automatic based on distinctness or a changing snapshot.

## Validation and freshness

For every analytical source, verify that the dataset is selected, belongs to the proposal's authorized workspace, has an active version, and that all declared dimension/measure columns exist in that version's profile. Preserve the normal mounted-source fingerprint guard before validation and publication. Reject stale, missing, nested/unsupported, or cross-dataset columns. Do **not** run uniqueness or non-null checks as a condition of analytical-source validity: those are record-key requirements and have no bearing on whether a table is analytically queryable.

A passing check means only that the reviewed metadata binds to a current queryable dataset. It does not certify business grain, measure additivity, referential integrity, or join safety. Those require separately named evidence.

## Persistence and compatibility

Keep the current `Bundle` record contract intact. The implementation adds the analytical collection through strict definitions v3; unsupported versions are rejected rather than allowing Zod's unknown-field stripping to erase semantics. Scalar-only definitions retain v1 export, and scoped relationships without analytical sources retain v2. The app-owned persisted schema advances monotonically to v4 before these definitions can be stored, so older binaries fail closed. Versionless proposal updates cannot erase existing analytical-source definitions; the v3 update envelope is semantics-aware. Confirmation and proposal hashes bind role, grain, and selected columns.

## Review UX

The review page should account for every selected dataset exactly once across record types, analytical sources, and explicitly unplaced items. For each keyless source, show:

1. why it was not promoted to a record (no defensible key evidence),
2. its current dataset/version and profiled columns,
3. proposed role and grain as editable, clearly marked reviewer assertions,
4. selected dimensions/measures with column validation,
5. that it has no row-level browsing, graph edges, or record actions.

Keep “unplaced” available. Do not auto-classify by table name, row count, timestamp presence, or absence of a primary key. A review can leave a dataset unplaced when its role/grain is unknown.

## Acceptance criteria

1. A keyless dataset can be classified as an analytical source and round-trip through proposal review, confirmation, definitions export/import, publication, and rollback without gaining an object type or row IDs.
2. Existing scalar record bundles, object IDs, records APIs, and graph relationships are unchanged.
3. Validation rejects unknown datasets/columns, stale source versions, duplicate dataset classification, and any attempt to use an analytical source as a graph relationship endpoint or record action target.
4. Confirmation hashes change when role, grain, dimensions, or measures change; stale or versionless updates cannot silently erase those fields.
5. Dashboard/metric queries continue to use authorized dataset IDs and source snapshots; no new query capability bypasses the executor or source-freshness checks.
6. Published counts distinguish records from analytical sources; passing validation is not described as proof of business grain or safe joins.
7. Tests cover a genuinely keyless table, a table with repeated rows, unknown grain, v1/v2 compatibility, downgrade rejection, stale sources, and dataset-accounting completeness.

## Scope and next decision

This implementation enables explicit analytical classification and accounting; it does **not** claim to solve all remaining datasets, determine their business roles, or explain their relationships. The UI allows a reviewer to select an unplaced dataset, choose `fact`, `dimension`, or `other`, enter an optional asserted grain, and select scalar dimensions and numeric measures. A classification is stored separately from record types and does not create row IDs, graph edges, or actions. No workspace, catalog, source file, or publication was changed as part of implementation. Full test/build verification and residual limits are reported in the handoff.