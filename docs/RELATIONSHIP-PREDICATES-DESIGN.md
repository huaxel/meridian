# Relationship scoping and composite joins — design for approval (not implemented)

Status: proposal. No code changes. Published relationships today serialize
only `name/fromType/toType/fromColumn/toColumn[/fromDatasetId/toDatasetId]`:
joins are unconditional and single-column. Measured audit evidence shows
unconditional joins can be semantically incomplete, while single-column
accounting joins can multiply rows across company/year scope. This design
adds optional, provenance-tracked side predicates and conjunctive multi-column
equality joins without changing existing unscoped single-column edges.

## Measured motivation (audit archives, not fresh claims)

1. **Language-scoped code lookups fan out 2–3×.** `ZST_PERSRADIAT→ZTXT_RADIATION`
   matches all 304,590 rows but yields 609,180 pairs (2 codes × 2 languages);
   `ZPP_PARCELADDR_X→ZTXT_ADDRESSTYPE` yields 4,730,856 pairs from 1,576,952
   rows (3 languages); `ZREF_CONFLICT→ZTXT_CONFLICT` triples 12 rows. Target
   footers carry `SPRAS`; DD03L confirms the text keys are
   `(MANDT,SPRAS,code)`, not the published `DESCRIPTION` primary key.
2. **Source-side restriction changes meaning.** `ZST_OBJCONTACT.OBJECTID →
   ZST_PERSON.SAP_PERSON_ID` is 64.64% unfiltered but 100% sample match with
   the catalog's `OBJECTTYPE='0000'` restriction (fanout remains in both).
3. **Not everything is predicate-fixable.** Parcel alternate-key fanout
   (max 6 targets/key on 100% samples) is real data shape, and the ANPR
   evidence link is explicitly expected 1:N. Predicates must never be used
   to cosmeticize genuine fanout into fake to-one edges.

## Proposed record contract

### Catalog import contract (currently missing)

`CatalogJoinSchema` today has only `leftTable/leftKey/rightTable/rightKey`, plus
optional cardinality/note; it cannot express either a conjunction or a declared
constant predicate. Add an explicit catalog format v2 rather than placing new
semantics in v1: older readers currently strip unknown Zod object keys, which
could silently turn a scoped/composite join back into a scalar join.

- Keep the existing root `version: 1` format and its scalar-only joins
  unchanged. Define v2 as the same top-level `name`, `tables`, `joins`, and
  `domains` shape with root `version: 2`; v2 gets a join schema that permits
  optional `additionalJoinPairs: { leftKey: string; rightKey: string }[]` and
  optional `predicate: { side: "left" | "right"; column: string; op: "=";
  value: string }`. The existing `leftKey/rightKey` remains the primary pair.
  Select the parser by the explicit root version, reject missing/unsupported
  versions and malformed v2 entries, and never parse a v2 payload through the
  v1 schema or silently downgrade it. Make the v2 root, join, pair, and
  predicate objects strict so unknown or misspelled semantic fields reject
  instead of being stripped; retain the existing v1 parser's behavior for
  compatibility. Tables/domains keep their existing v1 shape in v2; no
  migration or implicit reinterpretation is proposed.
- During discovery, resolve every pair against the same selected left/right
  dataset variants as the primary pair. Resolve the predicate column against
  its declared side. Convert left/right pair names and predicate side into
  the suggested link's from/to orientation, and mark a catalog-supplied value
  as `predicateBasis: "asserted"`. Missing or ambiguous components fail that
  candidate closed with a named review reason; never fall back to the primary
  pair alone.
- The catalog declaration is the provenance for an asserted constant; a
  note, `cardinality`, or field-name similarity is not. Values selected by a
  reviewer continue to use the human-confirmation path below, not a catalog
  assertion.

- `RelationshipSchema` (bundle) gains optional
  `predicate?: { side: "from" | "to"; column: string; op: "="; value: string }`.
  One predicate per relationship in v1; `op` is fixed to `=` (equality is
  the only measured need; no expression language).
- `SuggestedLinkSchema` gains the same optional `predicate`, plus
  `predicateBasis?: "asserted" | "confirmed"` (provenance, mirroring
  `matchBasis`) and `predicateCandidates?` (measured value options for
  review — see below). Each candidate identifies its `side` as well as its
  `column`; the same-named field on the opposite endpoint is a distinct
  candidate. Zod enforces shape; provenance is enforced by confirm/build
  logic, since a bare string type cannot tell declared
  values from invented ones.
- The predicate column must resolve to a literal profile column exactly
  like join columns do (per-variant resolution, never union-guessed). This
  v1 predicate contract is deliberately text-only: accept only known scalar
  text types (`VARCHAR`, `CHAR`, `TEXT`, `STRING`, including supported length
  parameters) and a string value; reject numeric, date/time, boolean, nested,
  and unknown profile types with a named reason. Do not rely on SQL implicit
  casts or stringify profile values. Supporting other scalar types requires
  an explicit typed-literal contract, not an inference in this version.
- `sourceLinkIdentity` includes the complete join-pair mapping and predicate:
  same endpoints with different scopes are distinct mappings; identical
  mappings still collapse.
- Cardinality is evidence-based over the complete equality tuple, with any
  predicate applied. Individual `fromColumn.primaryKey` flags are not enough
  to infer composite cardinality. Preview reports the raw primary-pair,
  full-tuple, and predicated results separately so scope restriction and
  fanout stay distinguishable.

## Value provenance (the crux — never guessed)

A predicate value is accepted from exactly two sources, recorded in evidence:

1. **Catalog-declared** (e.g. `OBJECTTYPE='0000'` alongside the join
   assertion): record `predicateBasis: "asserted"`. The relationship's
   `matchBasis` continues to describe the join assertion/evidence and is not
   reused to encode the predicate's provenance.
2. **Human-confirmed at review**: the confirm screen offers the measured
   candidate values (e.g. distinct `SPRAS` codes with per-value match
   counts). This needs a real channel that does not exist today:
   `OntologyConfirmSchema` (currently hash + excluded + names only) gains
   `predicates: record<linkId, { side, column, value }>`; each complete
   selection must exactly match one candidate's side, column, and value for
   that link, else 409. An omitted link remains unscoped. This prevents a
   value measured for one field from authorizing a different field; these
   membership/provenance checks belong in confirm logic, not Zod alone. The
   server sets `predicateBasis: "confirmed"` only after membership succeeds.
   Preserve the current hash roles: the request's `hash` remains the current
   suggestion freshness token checked by confirm; do not overload it with
   reviewer choices. After applying edits, compute the persisted
   confirmation/approval digest over the resolved ontology, including each
   selected predicate's side, column, value, and provenance. Serialize that
   resolved value deterministically (including stable relationship/property
   ordering) before hashing; do not hash raw request-map order. The current
   implementation uses `digest(JSON.stringify(value))` and deliberately avoids
   reparsing the value before digest verification because Zod may reorder keys.
   Predicate support must preserve or explicitly replace that invariant, with
   tests for equivalent request key orders yielding the same approval digest
   and different predicate choices yielding different digests. Build/run records
   bind the resolved ontology digest, while existing signature and input-drift
   guards remain in force.

Model-invented, default-language, or majority-value predicates are forbidden:
a lookup with no declared or confirmed value keeps its honest fanout and a
review note naming the unscoped dimension (`SPRAS`, …). The language-stability
issue (DESCRIPTION-as-PK on multilingual text tables) is surfaced by the
same note, not silently repaired.

## Validation and bundle changes

- `validateBundle` `Relationship:` check: construct the ON clause from the
  primary pair plus every `additionalJoinPairs` equality, then apply any
  predicate. Without either optional field, behavior is byte-identical to
  today's scalar join.
- Suggested links gain:
  `predicateCandidates?: { side: "from" | "to"; column: string; values:
  { value: string; candidateRows: number; matchedSourceRows: number;
  eligibleSourceRows: number; joinPairs: number }[] }[]`. Measure these
  with bounded `persist:false` aggregates, never row materialization:
  `candidateRows` counts rows on the declared predicate side with that exact
  value; `matchedSourceRows` counts source rows participating in at least one
  full-tuple join under that candidate; `eligibleSourceRows` is source rows
  with the value when `side="from"`, otherwise all source rows; `joinPairs`
  is the bag-semantics pair count. These denominators are per candidate, and
  source-row coverage must not be presented as join-pair count. Keep
  blank/NULL-component diagnostics separate; do not normalize candidate
  values beyond the exact predicate equality semantics.
- Staging applies the exact same full ON condition: the primary equality plus
  all additional pair equalities, then any predicate as
  `AND <side-alias>.<quoted-col> = <encoded-string-literal>` on the owning
  side's table (checked against that side's dataset columns at plan time).
  Quote identifiers with the executor's identifier encoder and encode the
  string value with its SQL string-literal encoder (doubling embedded single
  quotes); never interpolate raw catalog/reviewer text or treat a value as an
  identifier. Keep this behavior centralized in a safe API. Staged relation
  rows stay lean `{from, to, generation}` — no per-row scope bloat across
  millions of pairs. Persist all pair definitions and predicate provenance
  on the proposal validation, publication record, and preview.
- Schema-only plans carry predicates as metadata with zero queries
  (values must already be declared/confirmed — schema-only never
  measures); `!stageRecords` skips staging untouched.
- Stale inputs fail closed via the existing fingerprint guard; predicate
  value distributions are part of the validated input versions.
- Before any bundle or persisted proposal can contain `additionalJoinPairs`
  or `predicate`, advance the persisted global schema version from 2 to 3
  through the app-owned monotonic migration gate. `BundleSchema` and
  `RelationshipSchema` are ordinary stripping Zod objects today, so adding a
  marker field alone would not protect a downgrade: an older binary could
  discard the new fields and execute only the scalar pair. The existing
  startup guard rejects databases whose global schema version is newer than
  the binary; preserve that fail-closed behavior. The v2→v3 bump may be
  metadata-only if no backfill is needed, but it must complete before v3
  semantics are persisted or consumed. Unpredicated scalar relationships
  retain their current behavior.
- Definitions export/import has a separate `{version: 1, proposals}` envelope;
  the database guard does not protect bundles moved between installations.
  Preserve v1 for scalar-only bundles. If any relationship uses
  `additionalJoinPairs` or `predicate`, export envelope version 2. The v2
  importer must select a semantics-aware strict parser, reject malformed or
  unknown semantic fields, and never route such bundles through legacy
  `BundleSchema` parsing. Continue accepting legacy v1 scalar bundles. Because
  older importers require literal version 1, they must reject v2 rather than
  silently stripping new relationship fields. The versionless proposal update
  API must also protect existing scoped semantics: use a versioned write
  contract or reject a legacy payload that would remove or alter stored
  `additionalJoinPairs`/`predicate`. Revalidation, rollback, and other
  server-side proposal round-trips must preserve these fields atomically.

## Composite equality joins (new scope)

### Measured motivation

On the current isolated Local snapshot, active DD03L declares the BKPF header
key `(MANDT,BUKRS,BELNR,GJAHR)`; BSEG's line-item key adds `BUZEI`, and
ACDOCA's key includes `RCLNT,RLDNR,RBUKRS,GJAHR,BELNR,DOCLN`. The draft has
both `BSEG.BELNR -> BKPF.BELNR` and `ACDOCA.BELNR -> BKPF.BELNR` as asserted
single-column links.

Freshness-guarded exact aggregates show why that is insufficient:

- BSEG (14,282,422 rows) to BKPF (3,050,268): BELNR-only emits 112,984,448
  pairs; 548,313 target BELNR groups have fanout. Joining on
  `(MANDT,BUKRS,BELNR,GJAHR)` matches all 3,050,268 source tuples and all
  14,282,422 source rows, with exactly 14,282,422 pairs and no target fanout.
- ACDOCA (14,799,612 rows) to the same BKPF: BELNR-only emits 118,748,366
  pairs with 548,313 target groups fanning out. Joining on
  `(RCLNT=MANDT,RBUKRS=BUKRS,BELNR,GJAHR)` emits 14,281,973 pairs, covers
  14,281,973 source rows, and has no target fanout; 3,991 scoped source
  tuples / 517,639 rows remain unmatched. An exact cross-check found none of
  those tuples in BSEG under the same client/company/document/year scope.
  Of the 3,991, 3,603 (507,587 rows) have a BKPF row with the same
  client/company/BELNR but a different fiscal year; all such alternate BKPF
  years are earlier by 1–12 years. 3,240 tuples match multiple alternate
  years; 148 match only an adjacent year and 215 only a nonadjacent year.
  The remaining 388 tuples (10,052 rows) have no BKPF row for that BELNR in
  any scope. This narrows but does not explain the residual; do not hide it
  with a guessed filter.

These exact current-snapshot results are design evidence, not approval to
change either asserted edge or to claim the ACDOCA residual is valid.

### Record contract and semantics

- Add optional `additionalJoinPairs?: { fromColumn: string; toColumn: string }[]`
  to `RelationshipSchema` and `SuggestedLinkSchema`. The existing
  `fromColumn/toColumn` remains the displayed/legacy primary pair; the complete
  ON condition is that pair plus every additional pair, each joined with AND.
  When the field is absent, stored relationships retain their exact one-pair
  behavior. A composite relationship must not be persisted or published until
  every planner, validator, preview, staging, serializer, and hash path consumes
  the full mapping; old scalar fields alone are not sufficient to execute it.
- Each pair resolves to literal columns on the selected source and target
  dataset variant, with no union-schema guessing. Reject missing or repeated
  source/target components, malformed tuples, or stale evidence before
  planning/staging. Equality is conjunctive: the ON clause is the AND of all
  declared pairs. Preserve the current scalar join's exact SQL equality and
  NULL behavior; do not silently trim, case-fold, cast, or synthesize values.
- Join-pair identity is the complete conjunction, not just the primary pair.
  For deduplication and hashes, canonicalize the full set of `(fromColumn,
  toColumn)` pairs in stable lexical order so reordering an equivalent AND
  condition does not create another edge. Preserve declared/DDIC order for
  display if useful. Reject duplicate source or target components and duplicate
  pairs. Do not collapse distinct scopes that share only the primary pair.
  Evidence matching and published records bind the canonical full mapping.
- A constant-side `predicate` remains separate from endpoint equality pairs.
  If both exist, the complete ON condition is all join-pair equalities AND
  the explicitly sourced side predicate. Predicate provenance rules above
  still apply; composite columns alone never authorize a filter.
- Do not infer relationship cardinality from `primaryKey` flags on individual
  components. Validate target-tuple uniqueness and report source tuple/row
  coverage, matched tuples, join-pair count, target duplicate groups/max
  fanout, and invalid component rows. Keep tuple-level and row-level metrics
  distinct; a source line-item table can repeat its document tuple while each
  line item still maps to one header.
- Saved relationship evidence must bind the complete pair list, endpoint
  dataset IDs, metric definition, and active input versions. The existing
  mounted-source fingerprint guard remains upstream and fail-closed. For
  evidence-backed schema-only review, preserve the full tuple and its measured
  metrics without new scans; materialized staging must use exactly the same
  conjunction as validation and preview.

## Explicitly out of scope

- Multi-valued/range/like predicates, join-time computed expressions, and
  automatic choice of language, client, ledger, or other business scope.
- Automatically converting BELNR-only edges to composite joins: each mapping
  needs authoritative source correspondence and owner review. In particular,
  no ACDOCA filter is inferred from its unmatched scoped tuples.
- Backfilling predicates or composite joins onto the live generation (rebuild
  runbook territory).
- Changing unpredicated, one-pair edges: zero behavior delta when neither
  optional field is present.

## Acceptance (all must hold before merge)

- Catalog fixtures: v1 imports remain scalar-only and unchanged; v2 root
  version round-trips additional pairs and predicates; missing/unsupported
  versions, malformed v2 entries, and unknown/misspelled v2 fields reject,
  never falling back to v1 or stripping semantics.
- Persistence compatibility: the v2→v3 schema migration is monotonic and
  completes before scoped semantics are written; a v2 binary refuses startup
  against schema v3, while v3 reads existing scalar-only records unchanged.
  Scalar-only definitions export as envelope v1; scoped/composite definitions
  export as v2, which an old literal-v1 importer rejects. The new importer
  round-trips v2 semantics and continues to accept v1 scalar bundles. A
  versionless legacy update cannot erase scoped semantics from an existing
  proposal; test rejection or exact preservation, plus revalidation/rollback
  round-trips.
- SQL safety and typing: a predicate value containing an apostrophe and SQL
  metacharacters is encoded as one string literal and cannot change the ON
  expression; predicate column names are resolved from the selected schema
  and quoted as identifiers, never interpolated raw. Known scalar text types
  compare as exact strings; numeric, date/time, boolean, nested, and unknown
  types fail closed without implicit casts.
- Fixtures: candidate metrics distinguish predicate-side row counts, eligible
  and matched source rows, and join-pair fanout (including when the predicate
  is on `from` versus `to`); language-scoped lookup collapses 2×→1× with a
  confirmed value. Changing the selected predicate changes the
  resolved-ontology approval digest while the request still carries the
  unchanged current suggestion hash; equivalent predicate-map key ordering
  yields the same approval digest;
  when identical values are candidates on different sides or columns, confirm
  accepts only the exact side/column/value tuple; an omitted choice stays
  unscoped and wrong tuples fail with 409. Unscoped lookup keeps fanout plus
  the review note; catalog-asserted
  source restriction validates without queries; values outside a link's
  candidate set are rejected by confirm/build provenance checks and never
  reach planning.
- Composite fixtures: legacy scalar relationship stays byte/behavior stable;
  complete two-or-more pair joins validate and stage with every equality;
  wrong, missing, repeated, or stale components fail closed; proposal and
  approval hashes cover every pair; single-column evidence cannot authorize a
  composite mapping; predicates compose with, but remain distinct from,
  endpoint join pairs.
- Reproduce the BSEG→BKPF 112,984,448 vs 14,282,422 pair counts on a current
  fixture and preserve ACDOCA's residual as unmatched (never filtered away).
- Dedup matrix test: same/different predicates × same/different labels ×
  same/different complete pair lists.
- Full gate green; no Parquet rewrites; no live activation in tests.

## Risks and unknowns

- The correct `SPRAS` value for this deployment is a human/business
  decision (likely French-first, but that is an assumption until confirmed).
- Source-side language columns may not exist on all lookup sources; where
  neither side offers a scoping dimension, the honest answer stays fanout.
- Predicate confirmation UI is not implemented. It must present measured
  candidates by exact side/column/value, preserve an explicit unscoped option,
  and bind the chosen tuple into the resolved-ontology approval digest as
  specified above.
- Current ACDOCA→BKPF composite match leaves 3,991 scoped tuples / 517,639
  rows unmatched. None occurs in BSEG at the same scope; 3,603 match BKPF
  only under earlier fiscal years (offsets of 1–12 years), and 388 lack any
  BKPF BELNR match. These are useful diagnostics, not a business explanation.
  Keep them visible;
  do not infer omitted ledger/company filters from aggregate counts.
- Existing validation evidence is keyed by relationship name and one pair.
  Implementation must change that binding atomically across schema,
  deduplication, preview, proposal/publication hashes, rollback, and staging;
  partial support could validate one mapping and stage another.

Approval boundary: the owner authorized this design amendment only.
Implementation, changes to the isolated draft's BELNR links, and any live
activation each require separate approval. No code or workspace changes were
made for this design pass.
