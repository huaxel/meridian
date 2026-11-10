import {
  type Bundle,
  type ColumnProfile,
  datasetTable,
  MAX_BUNDLE_PIPELINES,
  type Resource,
  type SuggestedEntity,
  type SuggestedLink,
  type ValidationOmission,
  type SuggestedOntology,
} from "../../../../packages/shared/src/index.js";
import { pipelineId } from "../datasets.js";
import { assert } from "../security.js";
import { entityColumn, entityColumns } from "./columns.js";
import { sourceLinkIdentity } from "./link-identity.js";
import {
  datasetLabel,
  entityName,
  lit,
  lowerFirst,
  plural,
  q,
  slug,
  sourceLabel,
  tableName,
} from "./names.js";

export type OntologyBundlePlan = Pick<
  Bundle,
  | "summary"
  | "assumptions"
  | "catalog"
  | "pipelines"
  | "ontology"
  | "analyticalSources"
  | "relationships"
> & {
  relationshipEvidence: Map<string, SuggestedLink>;
  // Definitions the plan refuses before validation runs. Validation would prune
  // them and re-execute every pipeline to discover the same thing, but the
  // published report must still explain each refusal in the same shape.
  omissions: ValidationOmission[];
};

export function ontologyBundle(
  o: SuggestedOntology,
  datasets: Map<string, Resource>,
  options: {
    materializeMerges?: boolean;
    promoteCompositeIdentities?: boolean;
  } = {},
): OntologyBundlePlan {
  const materializeMerges = options.materializeMerges !== false;
  // A schema-only plan normally has to drop composite identities: nothing
  // computes their surrogate, and a quoted "a + b" expression is not a key.
  // Promoting them costs one key-only scan of each anchor table, which is
  // affordable where merging whole members is not, so large workspaces keep
  // their composite endpoints (and the links that need them).
  const promoteComposites =
    !materializeMerges && options.promoteCompositeIdentities === true;
  const compositeNotes: string[] = [];
  // Composite identities publish only through a measured materialized
  // surrogate. Without merges there is nothing to compute it from, so the
  // entity (and its links) stay out of the plan with a recorded reason —
  // never a quoted "a + b" expression as a primary key.
  let records = o.entities.filter(
    (e) =>
      e.kind === "record" && e.members.every((m) => datasets.has(m.datasetId)),
  );
  const droppedComposite = new Set<string>();
  const structuredOmissions: ValidationOmission[] = [];
  const droppedUnanchored = new Set<string>();
  // A source that exported no rows cannot assert an identity: profiling marks
  // no column a key with zero rows, so validation refuses every type anchored
  // there. Discovering that by validating costs a full second pass over every
  // pipeline (hours on a large workspace), so decide it here and record it.
  // Unknown row counts stay in: unprofiled is not empty.
  for (const e of records) {
    const rows = datasets.get(e.anchorDatasetId)?.data.profile?.rows;
    if (typeof rows === "number" && rows === 0) {
      droppedUnanchored.add(e.id);
      compositeNotes.push(
        `Omitted "${e.name}" from the plan: its source exported no rows, so its identity cannot be asserted yet.`,
      );
      structuredOmissions.push({
        kind: "objectType",
        name: e.name,
        reasons: [
          "The key projection returned no rows, so this identity cannot be asserted yet",
        ],
      });
    }
  }
  // A published primary key must be a column this type projects: a suggestion
  // whose key is a business label ("CODE + LANG") or a member's column
  // ("PROTOCOL_GUID" on a table that has no such column) cannot anchor a type.
  // Publishing it produces "Unknown property", and validation then prunes it
  // and re-runs every pipeline to discover the same thing. The profile already
  // measured whether a key column is unique and non-null, so decide it here.
  // Merged multi-member types project aliases across members; leave those to
  // validation, where the merged output is what gets checked.
  // A key string with " + " is composite even when the suggestion never filled
  // compositeKey: the discovery sometimes names the identity ("CODE + LANG")
  // without mapping it to columns.
  const isComposite = (e: SuggestedEntity) =>
    e.keyKind === "composite" ||
    (e.compositeKey?.length ?? 0) > 0 ||
    / \+ /.test(String(e.key ?? ""));
  const anchorScoped = (e: SuggestedEntity) =>
    !materializeMerges ||
    e.members.every((m) => m.datasetId === e.anchorDatasetId);
  for (const e of records) {
    if (droppedUnanchored.has(e.id) || !anchorScoped(e)) continue;
    if (isComposite(e)) continue; // composites are decided by the promotion pass
    const anchor = datasets.get(e.anchorDatasetId);
    const key = String(e.key ?? "");
    // Unprofiled is not unkeyed: with no column profile there is nothing to
    // decide on here, so leave the type to validation.
    if (!anchor?.data.profile?.columns) continue;
    const column = anchor.data.profile.columns.find(
      (c: ColumnProfile) => c.name === key,
    );
    if (column?.primaryKey) continue;
    droppedUnanchored.add(e.id);
    compositeNotes.push(
      column
        ? `Omitted "${e.name}" from the plan: its key "${key}" is not unique and non-null on ${anchor?.name ?? "its source"}.`
        : `Omitted "${e.name}" from the plan: its key "${key}" is not a column on ${anchor?.name ?? "its source"}.`,
    );
    structuredOmissions.push({
      kind: "objectType",
      name: e.name,
      reasons: [
        column
          ? "Primary key must be unique and non-null"
          : `Unknown property ${key}`,
      ],
    });
  }
  if (droppedUnanchored.size)
    records = records.filter((e) => !droppedUnanchored.has(e.id));
  // A promoted identity needs its components on the anchor: the surrogate is
  // computed there, and no join runs to fetch a member's copy of them.
  const promotable = (e: SuggestedEntity) =>
    promoteComposites &&
    (e.compositeKey?.length ?? 0) > 0 &&
    e.compositeKey!.every((c) =>
      datasets
        .get(e.anchorDatasetId)
        ?.data.profile?.columns?.some((col: ColumnProfile) => col.name === c),
    );
  if (!materializeMerges)
    for (const e of records)
      if (isComposite(e) && !promotable(e)) {
        droppedComposite.add(e.id);
        compositeNotes.push(
          `Omitted "${e.name}" from the plan: it declares composite key (${(e.compositeKey ?? []).join(" + ") || e.key}); ${
            promoteComposites
              ? "its key components do not all resolve to anchor columns, so no surrogate identity can be measured."
              : "schema-only publication is refused until a materialized build measures a surrogate identity."
          }`,
        );
        structuredOmissions.push({
          kind: "objectType",
          name: e.name,
          reasons: [
            (e.compositeKey?.length ?? 0) > 0
              ? "No surrogate identity could be measured from its key components"
              : `Unknown property ${e.key}`,
          ],
        });
      }
  if (!materializeMerges)
    records = records.filter((e) => !droppedComposite.has(e.id));
  let byId = new Map(records.map((e) => [e.id, e]));
  const type = (datasetId: string, column: string) =>
    datasets
      .get(datasetId)
      ?.data.profile.columns.find((c: ColumnProfile) => c.name === column)
      ?.type;
  const outputType = (e: SuggestedEntity, as: string) =>
    entityColumns(e, datasets).find((c) => c.as === as)?.type;
  // Raw-source links must keep the literal column AND dataset together. Merged
  // aliases (and via-key remapping) only exist in materialized entity outputs.
  const relationshipColumn = (
    entity: SuggestedEntity | undefined,
    datasetId: string,
    column: string,
  ) => {
    if (!entity) return undefined;
    if (materializeMerges)
      return entityColumn(entity, datasets, datasetId, column);
    return entity.members.some((m) => m.datasetId === datasetId) &&
      type(datasetId, column)
      ? column
      : undefined;
  };
  const droppedLinkNotes: string[] = [];
  let planned = o.links.flatMap((l) => {
    const from = byId.get(l.from),
      to = byId.get(l.to);
    const fromColumn = relationshipColumn(from, l.fromDatasetId, l.fromColumn),
      toColumn = relationshipColumn(to, l.toDatasetId, l.toColumn),
      additionalJoinPairs = (l.additionalJoinPairs || []).map((pair) => ({
        fromColumn: relationshipColumn(from, l.fromDatasetId, pair.fromColumn),
        toColumn: relationshipColumn(to, l.toDatasetId, pair.toColumn),
      })),
      predicateColumn = l.predicate
        ? relationshipColumn(l.predicate.side === "from" ? from : to, l.predicate.side === "from" ? l.fromDatasetId : l.toDatasetId, l.predicate.column)
        : undefined;
    if (!from || !to || !fromColumn || !toColumn || additionalJoinPairs.some((pair) => !pair.fromColumn || !pair.toColumn) || (l.predicate && !predicateColumn)) {
      // Both endpoints planned but a column unresolvable: record it instead
      // of dropping the suggestion silently (either materialization mode).
      if (from && to)
        droppedLinkNotes.push(
          `Omitted relationship suggestion "${l.id}": ${
            !fromColumn || !toColumn
              ? "a link column does not resolve"
              : "an additional join pair or predicate column does not resolve"
          } against the planned outputs of "${from.name}" -> "${to.name}".`,
        );
      return [];
    }
    const normalize =
      materializeMerges &&
      (l.caseInsensitive ||
        outputType(from, fromColumn) !== outputType(to, toColumn));
    return [{
      l, from, to, fromColumn, toColumn, normalize,
      additionalJoinPairs: additionalJoinPairs as { fromColumn: string; toColumn: string }[],
      ...(l.predicate && predicateColumn ? { predicate: { ...l.predicate, column: predicateColumn } } : {}),
    }];
  });
  // Links whose endpoint never made the plan name the missing endpoint so
  // the omission is reviewable, not silent.
  for (const l of o.links) {
    const from = byId.get(l.from),
      to = byId.get(l.to);
    if (from && to) continue;
    const unanchored = [l.from, l.to].find((id) => droppedUnanchored.has(id));
    if (unanchored) {
      const entity = o.entities.find((e) => e.id === unanchored);
      const endpoint = entity?.name ?? unanchored;
      compositeNotes.push(
        `Omitted relationship suggestion "${l.id}": endpoint "${endpoint}" has no source it can be anchored on.`,
      );
      structuredOmissions.push({
        kind: "relationship",
        name: l.name || l.id,
        reasons: [`Object type "${endpoint}" was omitted from the plan`],
      });
      continue;
    }
    // Name the composite endpoint even when the other end is absent for
    // another reason; links lost for non-composite reasons stay silent as
    // before.
    const missing = [l.from, l.to].find((id) => droppedComposite.has(id));
    if (!missing) continue;
    const entity = o.entities.find((e) => e.id === missing);
    compositeNotes.push(
      `Omitted relationship suggestion "${l.id}": endpoint "${entity?.name ?? missing}" was omitted (composite identity requires a materialized build).`,
    );
  }
  const keysFor = new Map<string, Set<string>>();
  for (const p of planned)
    if (p.normalize)
      for (const [e, c] of [
        [p.from, p.fromColumn],
        [p.to, p.toColumn],
      ] as const)
        keysFor.set(e.id, new Set([...(keysFor.get(e.id) || []), c]));
  const piped = new Set<string>();
  // Over budget: recorded refusal instead of a silent omission. Dropping an
  // entity also drops the links that name it, so each one is noted too.
  const dropUnpromoted = (over: SuggestedEntity[], reason: string) => {
    for (const e of over) {
      droppedComposite.add(e.id);
      compositeNotes.push(
        `Omitted "${e.name}" from the plan: it declares composite key (${(e.compositeKey ?? []).join(" + ") || e.key}); ${reason}`,
      );
      structuredOmissions.push({
        kind: "objectType",
        name: e.name,
        reasons: [reason],
      });
    }
    if (!over.length) return;
    const dropped = new Set(over.map((e) => e.id));
    records = records.filter((e) => !dropped.has(e.id));
    byId = new Map(records.map((e) => [e.id, e]));
    planned = planned.filter((p) => {
      const keep = !dropped.has(p.from.id) && !dropped.has(p.to.id);
      if (!keep) {
        const endpoint = dropped.has(p.from.id) ? p.from.name : p.to.name;
        compositeNotes.push(
          `Omitted relationship suggestion "${p.l.id}": endpoint "${endpoint}" was omitted (composite identity requires a materialized build).`,
        );
        structuredOmissions.push({
          kind: "relationship",
          name: p.l.name || p.l.id,
          reasons: [`Object type "${endpoint}" was omitted from the plan`],
        });
      }
      return keep;
    });
  };
  if (materializeMerges) {
    // Composites must merge: the surrogate is computed in the pipeline.
    // They take pipeline budget first so promotion is deterministic.
    for (const e of records)
      if (e.keyKind === "composite" && piped.size < 10) piped.add(e.id);
    for (const e of records
      .filter((e) => e.members.length > 1)
      .slice(0, Math.max(0, 10 - piped.size)))
      piped.add(e.id);
    for (const e of records)
      if (keysFor.has(e.id) && piped.size < 10) piped.add(e.id);
    dropUnpromoted(
      records.filter((e) => e.keyKind === "composite" && !piped.has(e.id)),
      "the materialized pipeline budget is exhausted.",
    );
  } else if (promoteComposites) {
    // Every promoted identity is one key-only scan, so the widest link
    // coverage takes the budget first; the order is fixed by link count and
    // then by id, so the same workspace always plans the same way.
    const linksTouching = (id: string) =>
      o.links.filter((l) => l.from === id || l.to === id).length;
    const candidates = records
      .filter((e) => e.keyKind === "composite")
      .sort(
        (a, b) =>
          linksTouching(b.id) - linksTouching(a.id) ||
          a.id.localeCompare(b.id),
      );
    for (const e of candidates)
      if (piped.size < MAX_BUNDLE_PIPELINES) piped.add(e.id);
    dropUnpromoted(
      candidates.filter((e) => !piped.has(e.id)),
      `the promoted-identity budget (${MAX_BUNDLE_PIPELINES}) is exhausted.`,
    );
  }
  const pipelines: Bundle["pipelines"] = [],
    ontology: Bundle["ontology"] = [],
    available = new Map<string, Set<string>>(),
    keyColumns = new Map<string, Map<string, string>>();
  let promotedCount = 0;
  for (const e of records) {
    const anchorOnly = {
      anchorDatasetId: e.anchorDatasetId,
      members: e.members.filter((m) => m.datasetId === e.anchorDatasetId),
    };
    const merged = materializeMerges && piped.has(e.id);
    const cols = entityColumns(merged ? e : anchorOnly, datasets);
    // A promoted identity projects its key components only. Projecting the
    // whole anchor makes the executor profile every column with an exact
    // count(DISTINCT): measured on a 162-column, 49M-row table that spills and
    // exceeds 25 minutes, while the key projection finishes in about 3. From
    // whole-member merges only the merged path needs the wide output.
    const components =
      e.keyKind === "composite" ? (e.compositeKey ?? []) : [];
    // Project the components straight off the anchor rather than filtering the
    // entity's column list: that list drops a member's via-column and collapses
    // case-insensitive duplicates, which would silently leave a promoted
    // identity's own key columns out of its published properties.
    const projected =
      piped.has(e.id) && !merged
        ? components.flatMap((c) => {
            const componentType = datasets
              .get(e.anchorDatasetId)
              ?.data.profile?.columns?.find(
                (col: ColumnProfile) => col.name === c,
              )?.type;
            return componentType
              ? [
                  {
                    datasetId: e.anchorDatasetId,
                    column: c,
                    as: c,
                    type: componentType,
                  },
                ]
              : [];
          })
        : cols;
    if (piped.has(e.id) && !merged) promotedCount++;
    const names = new Set(projected.map((c) => c.as));
    let datasetId = e.anchorDatasetId;
    let surrogate: string | undefined;
    const pipelineNames = new Set(pipelines.map((p) => p.name));
    if (piped.has(e.id)) {
      const alias = new Map(e.members.map((m, i) => [m.datasetId, `m${i}`]));
      alias.set(e.anchorDatasetId, "a");
      const keys = new Map<string, string>(),
        select = projected.map(
          (c) =>
            `${alias.get(c.datasetId)}.${q(c.column)}` +
            (c.as === c.column ? "" : ` AS ${q(c.as)}`),
        );
      for (const as of keysFor.get(e.id) || []) {
        const c = projected.find((x) => x.as === as)!;
        let key = `${as}_key`;
        for (
          let n = 2;
          [...names].some((x) => x.toLowerCase() === key.toLowerCase());
          n++
        )
          key = `${as}_key_${n}`;
        names.add(key);
        keys.set(as, key);
        select.push(
          `lower(trim(CAST(${alias.get(c.datasetId)}.${q(c.column)} AS VARCHAR))) AS ${q(key)}`,
        );
      }
      keyColumns.set(e.id, keys);
      // Composite promotion: one normalized separator-joined surrogate over
      // the resolved anchor components. Plain concatenation collides
      // ("a"+"bc" vs "ab"+"c"); chr(31) keeps the tuple boundary.
      // The pipeline checks below measure joint uniqueness, non-nullness
      // and blank-freedom at validation time — no promotion without them.
      let blankGuard = "";
      if (components.length) {
        const a = alias.get(e.anchorDatasetId)!;
        const expr = components
          .map((c) => `lower(trim(CAST(${a}.${q(c)} AS VARCHAR)))`)
          .join(" || chr(31) || ");
        surrogate = "composite_key";
        for (
          let n = 2;
          [...names].some((x) => x.toLowerCase() === surrogate!.toLowerCase());
          n++
        )
          surrogate = `composite_key_${n}`;
        names.add(surrogate);
        select.push(`${expr} AS ${q(surrogate)}`);
        // Empty strings survive in components as distinct surrogate values,
        // so text components are screened on the source table. Non-text
        // components cannot be blank; missing columns fail the pipeline
        // itself, which fails validation closed.
        const textComponents = components.filter((c) =>
          /^(VARCHAR|CHAR|TEXT|STRING)(\(.*\))?$/i.test(
            String(type(e.anchorDatasetId, c) ?? "").trim(),
          ),
        );
        if (textComponents.length)
          blankGuard = textComponents
            .map((c) => `${q(datasetTable(e.anchorDatasetId))}.${q(c)} = ''`)
            .join(" OR ");
      }
      const joined = new Set([e.anchorDatasetId]),
        joins: string[] = [];
      // Only a merge fetches member columns; a promoted identity reads its
      // anchor alone, so its output stays one row per anchor row even when a
      // member join would have fanned out.
      for (let grew = merged; grew; ) {
        grew = false;
        for (const m of e.members)
          if (
            m.via &&
            !joined.has(m.datasetId) &&
            joined.has(m.via.targetDatasetId)
          ) {
            const cast =
              type(m.datasetId, m.via.column) !==
              type(m.via.targetDatasetId, m.via.targetColumn);
            const side = (a: string, c: string) =>
              cast ? `CAST(${a}.${q(c)} AS VARCHAR)` : `${a}.${q(c)}`;
            joins.push(
              `LEFT JOIN ${q(datasetTable(m.datasetId))} ${alias.get(m.datasetId)} ON ${side(alias.get(m.datasetId)!, m.via.column)} = ${side(alias.get(m.via.targetDatasetId)!, m.via.targetColumn)}`,
            );
            joined.add(m.datasetId);
            grew = true;
          }
      }
      const name = merged
        ? `${plural(e.name)} (${[...new Set(e.members.filter((m) => joined.has(m.datasetId)).map((m) => sourceLabel(m.source)))].join(" + ")})`
        : `${plural(e.name)} (${sourceLabel(e.members.find((m) => m.datasetId === e.anchorDatasetId)?.source ?? "")} key)`;
      let unique = name;
      for (let n = 2; pipelineNames.has(unique); n++) unique = `${name} ${n}`;
      pipelineNames.add(unique);
      datasetId = pipelineId(unique);
      pipelines.push({
        name: unique,
        description: e.description,
        inputs: [...joined],
        sql: `SELECT ${select.join(", ")} FROM ${q(datasetTable(e.anchorDatasetId))} a ${joins.join(" ")}`.trim(),
        nodes: [],
        checks: [
          {
            name: `One row per ${lowerFirst(e.name)}`,
            sql: `SELECT count(*) = count(DISTINCT ${q(surrogate ?? e.key)}) AND count(${q(surrogate ?? e.key)}) = count(*) AS ok FROM ${q(datasetTable(datasetId))}`,
          },
          // Blanks hide inside distinct surrogate values, so text
          // components are screened on the source table in the same check
          // pass. A missing component fails the pipeline itself, closed.
          // sum() over an empty table is NULL, not 0, and "NULL = 0" is not
          // true: without the coalesce an empty source (16 of this workspace's
          // 462 tables export no rows) would fail a check it vacuously passes.
          ...(surrogate && blankGuard
            ? [
                {
                  name: `Composite key components have no blanks for ${lowerFirst(e.name)}`,
                  sql: `SELECT coalesce(sum(CASE WHEN ${blankGuard} THEN 1 ELSE 0 END), 0) = 0 AS ok FROM ${q(datasetTable(e.anchorDatasetId))}`,
                },
              ]
            : []),
        ],
      });
    }
    available.set(e.id, names);
    ontology.push({
      name: e.name,
      datasetId,
      primaryKey: surrogate ?? e.key,
      properties: [
        ...new Set([
          surrogate ?? e.key,
          ...e.properties.filter((p) => names.has(p)),
        ]),
      ],
      description: e.description,
    });
  }
  const relationships: Bundle["relationships"] = [],
    duplicateNotes: string[] = [],
    retainedMappings = new Map<string, string>(),
    evidenceByRelationship = new Map<
      Bundle["relationships"][number],
      SuggestedLink
    >();
  for (const p of planned) {
    const fromColumn = p.normalize
        ? keyColumns.get(p.from.id)?.get(p.fromColumn)
        : p.fromColumn,
      toColumn = p.normalize
        ? keyColumns.get(p.to.id)?.get(p.toColumn)
        : p.toColumn;
    if (!fromColumn || !toColumn) {
      // Normalized join columns resolve only through a merge pipeline;
      // a non-pipelined entity drops the link with a reason, never silently.
      droppedLinkNotes.push(
        `Omitted relationship suggestion "${p.l.id}": normalized join columns for "${p.from.name}" -> "${p.to.name}" need a merge pipeline that was not built.`,
      );
      continue;
    }
    if (
      materializeMerges &&
      (!available.get(p.from.id)!.has(fromColumn) ||
        !available.get(p.to.id)!.has(toColumn) ||
        p.additionalJoinPairs.some((pair) => !available.get(p.from.id)!.has(pair.fromColumn) || !available.get(p.to.id)!.has(pair.toColumn)) ||
        (p.predicate && !(p.predicate.side === "from" ? available.get(p.from.id)! : available.get(p.to.id)!).has(p.predicate.column)))
    ) {
      // Only reached in materialized plans: a member-side alias has no
      // anchor-only output column without its merge pipeline.
      droppedLinkNotes.push(
        `Omitted relationship suggestion "${p.l.id}": "${fromColumn}" / "${toColumn}" are not all in the materialized outputs of "${p.from.name}" -> "${p.to.name}" (non-anchor member columns need a merge pipeline).`,
      );
      continue;
    }
    const identity = sourceLinkIdentity(p.l);
    const retained = retainedMappings.get(identity);
    if (retained !== undefined) {
      duplicateNotes.push(
        `Omitted duplicate relationship suggestion "${p.l.id}": same source mapping as "${retained}".`,
      );
      continue;
    }
    retainedMappings.set(identity, p.l.id);
    const relationship: Bundle["relationships"][number] = {
      name: p.l.name,
      fromType: p.from.name,
      toType: p.to.name,
      fromColumn,
      toColumn,
      ...(p.additionalJoinPairs.length ? { additionalJoinPairs: p.additionalJoinPairs } : {}),
      ...(p.predicate ? { predicate: p.predicate, predicateBasis: p.l.predicateBasis } : {}),
      ...(!materializeMerges
        ? {
            fromDatasetId: p.l.fromDatasetId,
            toDatasetId: p.l.toDatasetId,
          }
        : {}),
    };
    relationships.push(relationship);
    evidenceByRelationship.set(relationship, p.l);
  }
  // Relationship names are identities, so repeated verbs name their subject.
  const repeated = (r: (typeof relationships)[number]) =>
    relationships.filter((x) => x.name === r.name).length > 1;
  const named = relationships.map((r) =>
    repeated(r) ? { ...r, name: `${r.fromType} ${r.name}` } : { ...r },
  );
  const seen = new Set<string>();
  for (const r of named) {
    const base = seen.has(r.name) ? `${r.name} ${r.toType}` : r.name;
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base} ${n}`;
    seen.add(name);
    r.name = name;
  }
  const relationshipEvidence = new Map<string, SuggestedLink>();
  if (!materializeMerges)
    named.forEach((r, i) => {
      const evidence = evidenceByRelationship.get(relationships[i]);
      if (evidence) relationshipEvidence.set(r.name, evidence);
    });
  const catalog = [
    ...o.entities.flatMap((e) =>
      e.members
        .filter((m) => datasets.has(m.datasetId))
        .map((m) => ({
          datasetId: m.datasetId,
          description:
            datasets.get(m.datasetId)!.description ||
            `${datasetLabel({ source: m.source, table: tableName(m.datasetName, m.source) })}: ${e.name} ${e.kind === "activity" ? "activity" : "records"}.`,
          tags: [slug(e.name), m.source],
        })),
    ),
    // Tables outside the schema still feed dashboards.
    ...o.unplaced.flatMap((id) => {
      const d = datasets.get(id);
      return d
        ? [
            {
              datasetId: id,
              description: d.description || `${d.name}: rows kept as a table.`,
              tags: [slug(tableName(d.name, d.data.sampleSource || ""))],
            },
          ]
        : [];
    }),
    ...(o.analyticalSources || []).flatMap((source) => {
      const d = datasets.get(source.datasetId);
      return d ? [{
        datasetId: source.datasetId,
        description: source.description || `${d.name}: reviewed ${source.role} analytical source; no record identity asserted.`,
        tags: [slug(source.name), source.role],
      }] : [];
    }),
  ];
  return {
    summary: o.summary,
    omissions: structuredOmissions,
    assumptions: [
      ...o.notes
        .filter((n) => n.kind === "case" || n.kind === "unmatched")
        .map((n) =>
          n.kind === "case"
            ? `${n.text} They are linked on lower-cased values.`
            : n.text,
        ),
      ...duplicateNotes,
      ...compositeNotes,
      // One line for the whole projection policy: a reviewer comparing a
      // promoted type with its source table should know the difference is
      // planned, not lost.
      ...(promotedCount
        ? [
            `Promoted ${promotedCount} composite identit${promotedCount === 1 ? "y" : "ies"} from key-only projections: those types list their key columns, not every source column.`,
          ]
        : []),
      ...droppedLinkNotes,
    ],
    catalog,
    pipelines,
    ontology,
    analyticalSources: o.analyticalSources || [],
    relationships: named,
    relationshipEvidence,
  };
}

// A dashboard computed from a confirmed ontology, for a build whose model-designed
// widgets all fail: the hub entity's records, records per entity, and new records
// per month. Plain counts over the source tables, so it validates without a model.
export function overviewDashboard(
  o: SuggestedOntology,
  datasets: Map<string, Resource>,
  options: { compact?: boolean } = {},
): Bundle["dashboards"][number] {
  const degree = (e: SuggestedEntity) =>
    o.links.filter((l) => l.from === e.id || l.to === e.id).length;
  const records = o.entities
    .filter((e) => e.kind === "record" && datasets.has(e.anchorDatasetId))
    .sort((a, b) => degree(b) - degree(a))
    .slice(0, 20);
  // Without records, each table counts for itself.
  const groups = (
    records.length
      ? records.map((e) => ({
          name: plural(e.name),
          datasetId: e.anchorDatasetId,
        }))
      : [...datasets.values()].map((d) => ({
          name: plural(
            entityName(tableName(d.name, d.data.sampleSource || "")),
          ),
          datasetId: d.id,
        }))
  ).slice(0, 20);
  assert(groups.length, "Connect or upload a dataset first");
  const from = (id: string) => q(datasetTable(id));
  if (options.compact) {
    const group = groups[0];
    return {
      name: "Overview",
      description: `${o.summary} A single source-table count keeps this large workspace responsive.`,
      widgets: [
        {
          title: group.name,
          type: "metric",
          sql: `SELECT count(*) AS "records" FROM ${from(group.datasetId)}`,
          inputs: [group.datasetId],
        },
      ],
    };
  }
  const counts = groups
    .map(
      (g) =>
        `SELECT ${lit(g.name)} AS "type", count(*) AS "records" FROM ${from(g.datasetId)}`,
    )
    .join(" UNION ALL ");
  const inputs = [...new Set(groups.map((g) => g.datasetId))];
  const widgets: Bundle["dashboards"][number]["widgets"] = [
    records.length
      ? {
          title: groups[0].name,
          type: "metric",
          sql: `SELECT count(*) AS "records" FROM ${from(groups[0].datasetId)}`,
          inputs: [groups[0].datasetId],
        }
      : {
          title: "Records",
          type: "metric",
          sql: `SELECT CAST(sum("records") AS BIGINT) AS "records" FROM (${counts})`,
          inputs,
        },
  ];
  if (groups.length > 1)
    widgets.push({
      title: "Records by type",
      type: "bar",
      sql: `SELECT * FROM (${counts}) ORDER BY "records" DESC, "type"`,
      inputs,
      x: "type",
      y: "records",
    });
  const temporal = (c: ColumnProfile) => /^(DATE|TIMESTAMP)/i.test(c.type);
  const dated = [/creat/i, /date|start|sign.?up|joined/i]
    .flatMap((pattern) =>
      records.flatMap((e) => {
        const c = datasets
          .get(e.anchorDatasetId)!
          .data.profile?.columns.find(
            (c: ColumnProfile) => temporal(c) && pattern.test(c.name),
          );
        return c ? [{ e, column: q(c.name) }] : [];
      }),
    )
    .at(0);
  if (dated)
    widgets.push({
      title: `New ${plural(lowerFirst(dated.e.name))} per month`,
      type: "line",
      sql: `SELECT strftime(CAST(${dated.column} AS TIMESTAMP), '%Y-%m') AS "month", count(*) AS "records" FROM ${from(dated.e.anchorDatasetId)} WHERE ${dated.column} IS NOT NULL GROUP BY 1 ORDER BY 1`,
      inputs: [dated.e.anchorDatasetId],
      x: "month",
      y: "records",
    });
  return { name: "Overview", description: o.summary, widgets };
}
