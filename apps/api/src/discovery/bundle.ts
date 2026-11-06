import {
  type Bundle,
  type ColumnProfile,
  datasetTable,
  type Resource,
  type SuggestedEntity,
  type SuggestedLink,
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
> & { relationshipEvidence: Map<string, SuggestedLink> };

export function ontologyBundle(
  o: SuggestedOntology,
  datasets: Map<string, Resource>,
  options: { materializeMerges?: boolean } = {},
): OntologyBundlePlan {
  const materializeMerges = options.materializeMerges !== false;
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
  if (!materializeMerges)
    for (const e of records)
      if (e.keyKind === "composite") {
        droppedComposite.add(e.id);
        compositeNotes.push(
          `Omitted "${e.name}" from the plan: it declares composite key (${(e.compositeKey ?? []).join(" + ") || e.key}); schema-only publication is refused until a materialized build measures a surrogate identity.`,
        );
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
      if (from && to && (!fromColumn || !toColumn))
        droppedLinkNotes.push(
          `Omitted relationship suggestion "${l.id}": a link column does not resolve against the planned outputs of "${from.name}" -> "${to.name}".`,
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
    // Over budget: same recorded refusal as the schema-only path.
    const over = records.filter(
      (e) => e.keyKind === "composite" && !piped.has(e.id),
    );
    for (const e of over) {
      droppedComposite.add(e.id);
      compositeNotes.push(
        `Omitted "${e.name}" from the plan: it declares composite key (${(e.compositeKey ?? []).join(" + ") || e.key}); the materialized pipeline budget is exhausted.`,
      );
    }
    if (over.length) {
      const dropped = new Set(over.map((e) => e.id));
      records = records.filter((e) => !dropped.has(e.id));
      byId = new Map(records.map((e) => [e.id, e]));
      planned = planned.filter((p) => {
        const keep = !dropped.has(p.from.id) && !dropped.has(p.to.id);
        if (!keep)
          compositeNotes.push(
            `Omitted relationship suggestion "${p.l.id}": endpoint "${dropped.has(p.from.id) ? p.from.name : p.to.name}" was omitted (composite identity requires a materialized build).`,
          );
        return keep;
      });
    }
  }
  const pipelines: Bundle["pipelines"] = [],
    ontology: Bundle["ontology"] = [],
    available = new Map<string, Set<string>>(),
    keyColumns = new Map<string, Map<string, string>>();
  for (const e of records) {
    const anchorOnly = {
      anchorDatasetId: e.anchorDatasetId,
      members: e.members.filter((m) => m.datasetId === e.anchorDatasetId),
    };
    const cols = entityColumns(piped.has(e.id) ? e : anchorOnly, datasets);
    const names = new Set(cols.map((c) => c.as));
    let datasetId = e.anchorDatasetId;
    let surrogate: string | undefined;
    if (piped.has(e.id)) {
      const alias = new Map(e.members.map((m, i) => [m.datasetId, `m${i}`]));
      alias.set(e.anchorDatasetId, "a");
      const keys = new Map<string, string>(),
        select = cols.map(
          (c) =>
            `${alias.get(c.datasetId)}.${q(c.column)}` +
            (c.as === c.column ? "" : ` AS ${q(c.as)}`),
        );
      for (const as of keysFor.get(e.id) || []) {
        const c = cols.find((x) => x.as === as)!;
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
      const components =
        e.keyKind === "composite" ? (e.compositeKey ?? []) : [];
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
      for (let grew = true; grew; ) {
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
      const name = `${plural(e.name)} (${[...new Set(e.members.filter((m) => joined.has(m.datasetId)).map((m) => sourceLabel(m.source)))].join(" + ")})`;
      datasetId = pipelineId(name);
      pipelines.push({
        name,
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
          ...(surrogate && blankGuard
            ? [
                {
                  name: `Composite key components have no blanks for ${lowerFirst(e.name)}`,
                  sql: `SELECT sum(CASE WHEN ${blankGuard} THEN 1 ELSE 0 END) = 0 AS ok FROM ${q(datasetTable(e.anchorDatasetId))}`,
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
