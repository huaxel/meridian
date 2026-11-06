import {
  type Bundle,
  type Resource,
  type SuggestedLink,
  type ValidationReport,
  datasetTable,
} from "../../../../packages/shared/src/index.js";
import { now, resource, type Store } from "../store.js";
import { assert } from "../security.js";
import { execute } from "../executor.js";
import { pipelineId } from "../datasets.js";
import { randomUUID } from "node:crypto";
import { datasetsMap, inputsFor } from "./provider.js";
import { mountedSourceGuard } from "./source-freshness.js";
import { relationshipJoinCondition } from "../relationship-sql.js";

export type BundleValidationOptions = {
  // Trusted link evidence from a server-generated confirmed ontology. When
  // present, validate schemas and use the saved match stats instead of rescanning
  // large source tables for every relationship.
  relationshipEvidence?: Map<string, SuggestedLink>;
  // Onboarding definitions must never be rebound to another workspace dataset
  // merely because its columns look similar.
  allowedDatasetIds?: string[];
  // Schema-based source correction is only permitted for unconfirmed AI drafts.
  allowDatasetRebinding?: boolean;
  // Schema-only review must not turn stale/missing evidence into a full scan.
  requireRelationshipEvidence?: boolean;
};

export async function validateBundle(
  store: Store,
  scope: string,
  bundle: Bundle,
  options: BundleValidationOptions = {},
): Promise<ValidationReport> {
  const datasets = await datasetsMap(store, scope),
    checks: ValidationReport["checks"] = [],
    previews: Record<string, any> = {},
    inputVersions: Record<string, string> = {};
  const sourceCurrent = mountedSourceGuard(store, scope);
  if (options.allowedDatasetIds) {
    const allowed = new Set(options.allowedDatasetIds);
    for (const id of datasets.keys()) if (!allowed.has(id)) datasets.delete(id);
  }
  // Resolve unambiguous names against the authorized catalog; never invent a dataset.
  const resolveDataset = (ref: string) => {
    if (datasets.has(ref)) return ref;
    const matches = [...datasets.values()].filter(
      (d) =>
        d.name.toLowerCase() === ref.toLowerCase() ||
        datasetTable(d.id) === ref,
    );
    return matches.length === 1 ? matches[0].id : ref;
  };
  for (const c of bundle.catalog) c.datasetId = resolveDataset(c.datasetId);
  for (const p of bundle.pipelines) p.inputs = p.inputs.map(resolveDataset);
  for (const t of bundle.ontology) t.datasetId = resolveDataset(t.datasetId);
  for (const source of bundle.analyticalSources) source.datasetId = resolveDataset(source.datasetId);
  for (const r of bundle.relationships) {
    if (r.fromDatasetId) r.fromDatasetId = resolveDataset(r.fromDatasetId);
    if (r.toDatasetId) r.toDatasetId = resolveDataset(r.toDatasetId);
  }
  // Small models sometimes pair a type with the wrong dataset ID. When the type's key
  // and properties exist, key unique, in exactly one dataset, use that dataset.
  const fits = (d: Resource | undefined, t: Bundle["ontology"][number]) => {
    const columns = d?.data.profile?.columns || [];
    return (
      columns.some((c: any) => c.name === t.primaryKey && c.primaryKey) &&
      t.properties.every((p) => columns.some((c: any) => c.name === p))
    );
  };
  // Types on a pipeline output are never moved: the output does not exist yet.
  const derived = new Set(bundle.pipelines.map((p) => pipelineId(p.name)));
  for (const t of options.allowDatasetRebinding ? bundle.ontology : []) {
    if (
      derived.has(t.datasetId) ||
      t.datasetId.startsWith("pipeline_") ||
      fits(datasets.get(t.datasetId), t)
    )
      continue;
    const owners = [...datasets.values()].filter((d) => fits(d, t));
    if (owners.length === 1) t.datasetId = owners[0].id;
  }
  for (const d of bundle.dashboards)
    for (const w of d.widgets) w.inputs = w.inputs.map(resolveDataset);
  const derivedIds = new Set<string>();
  const unique = (items: { name: string }[]) =>
    new Set(items.map((x) => x.name)).size === items.length;
  checks.push({
    name: "Definition identities",
    passed: [
      bundle.pipelines,
      bundle.ontology,
      bundle.analyticalSources,
      bundle.dashboards,
      bundle.relationships,
    ].every(unique) &&
      new Set([...bundle.ontology, ...bundle.analyticalSources].map((x) => x.name.toLowerCase())).size === bundle.ontology.length + bundle.analyticalSources.length,
    detail: "Names must be unique within and across record and analytical asset types",
  });
  const recordDatasets = new Set(bundle.ontology.map((type) => type.datasetId));
  const analyticalDatasets = bundle.analyticalSources.map((source) => source.datasetId);
  checks.push({
    name: "Dataset classification",
    passed: new Set(analyticalDatasets).size === analyticalDatasets.length &&
      analyticalDatasets.every((id) => !recordDatasets.has(id)),
    detail: "A dataset can be classified once, as either records or an analytical source",
  });
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, passed: true, detail: await fn() });
    } catch (e) {
      checks.push({
        name,
        passed: false,
        detail: e instanceof Error ? e.message : "Validation failed",
      });
    }
  };
  const query = async (ids: string[], sql: string, persist = false) => {
    for (const id of ids) {
      const d = datasets.get(id);
      if (d) await sourceCurrent(d);
      if (d && !derivedIds.has(id)) inputVersions[id] = d.data.activeVersion;
    }
    return execute({
      mode: "query",
      scope,
      inputs: await inputsFor(store, scope, ids, datasets),
      sql,
      version: randomUUID(),
      persist,
      limit: 20,
    });
  };
  for (const c of bundle.catalog)
    await check("Catalog: " + c.datasetId, async () => {
      const d = datasets.get(c.datasetId);
      assert(d, "Unknown dataset");
      await sourceCurrent(d);
      inputVersions[d.id] = d.data.activeVersion;
      return "Description grounded in dataset profile";
    });
  for (const p of bundle.pipelines)
    await check("Pipeline: " + p.name, async () => {
      const r = await query(p.inputs, p.sql, true),
        id = pipelineId(p.name);
      derivedIds.add(id);
      datasets.set(
        id,
        resource(
          scope,
          "dataset",
          p.name,
          {
            profile: r.profile,
            activeVersion: r.version,
            table: datasetTable(id),
          },
          id,
        ),
      );
      previews[id] = r;
      previews["before:" + p.name] = p.inputs.flatMap(
        (input) => datasets.get(input)?.data.profile.sample.slice(0, 5) || [],
      );
      const first = datasets.get(p.inputs[0]);
      const key = first?.data.profile.columns.find(
        (c: any) =>
          c.primaryKey && r.profile.columns.some((x) => x.name === c.name),
      );
      if (p.inputs.length === 1 && key) {
        const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
        previews["rejected:" + p.name] = (
          await query(
            [p.inputs[0], id],
            `SELECT a.* FROM ${quote(datasetTable(p.inputs[0]))} a WHERE NOT EXISTS (SELECT 1 FROM ${quote(datasetTable(id))} b WHERE a.${quote(key.name)}=b.${quote(key.name)})`,
          )
        ).rows;
      }
      for (const c of p.checks) {
        const result = await query([...p.inputs, id], c.sql);
        assert(
          result.rows.length > 0 &&
            Object.values(result.rows[0]).every(
              (v) => v === true || v === 1 || v === "1",
            ),
          `Quality check failed: ${c.name}`,
        );
      }
      return `${r.profile.rows} output rows; ${p.checks.length} checks passed`;
    });
  for (const type of bundle.ontology)
    await check("Ontology: " + type.name, async () => {
      const d = datasets.get(type.datasetId);
      assert(d, "Unknown dataset");
      await sourceCurrent(d);
      for (const prop of [type.primaryKey, ...type.properties])
        assert(
          d.data.profile.columns.some((x: any) => x.name === prop),
          `Unknown property ${prop}`,
        );
      const col = d.data.profile.columns.find(
        (x: any) => x.name === type.primaryKey,
      );
      assert(col.primaryKey, "Primary key must be unique and non-null");
      if (!derivedIds.has(type.datasetId))
        inputVersions[type.datasetId] = d.data.activeVersion;
      // Warnings only, by policy: empty strings pass uniqueness/non-null
      // checks but carry no record identity. The count comes from the stored
      // profile, so this adds no validation-time queries and stays safe for
      // schema-only bundles. Unmeasured (legacy profiles) stays silent.
      const blanks =
        typeof col.blanks === "number" || typeof col.blanks === "bigint"
          ? Number(col.blanks)
          : 0;
      return (
        `${d.data.profile.rows} objects; unique non-null key` +
        (blanks > 0
          ? `; ${blanks} blank key value(s) present — record identity needs review`
          : "")
      );
    });
  const nestedColumn = (type: string) => /STRUCT|MAP\(|\[\d*\]|UNION\(|^LIST|^JSON/i.test(type);
  const numericColumn = (type: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i.test(type);
  for (const source of bundle.analyticalSources)
    await check("Analytical source: " + source.name, async () => {
      const d = datasets.get(source.datasetId);
      assert(d, "Unknown or unauthorized dataset");
      await sourceCurrent(d);
      const columns = d.data.profile?.columns || [];
      const checkColumns = (names: string[], label: string) => {
        assert(new Set(names).size === names.length, `${label} columns must be unique`);
        for (const name of names) {
          const column = columns.find((c: any) => c.name === name);
          assert(column, `Unknown ${label.toLowerCase()} column ${name}`);
          assert(!nestedColumn(column.type), `Unsupported nested ${label.toLowerCase()} column ${name}`);
          if (label === "Measure") assert(numericColumn(column.type), `Measure ${name} must have a numeric type`);
        }
      };
      checkColumns(source.dimensions, "Dimension");
      checkColumns(source.measures, "Measure");
      assert(!source.dimensions.some((name) => source.measures.includes(name)), "A column cannot be both a dimension and measure");
      if (!derivedIds.has(source.datasetId)) inputVersions[source.datasetId] = d.data.activeVersion;
      return `${d.data.profile.rows} analytical rows from the active snapshot; no row identity or graph records asserted`;
    });
  const q = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  for (const rel of bundle.relationships)
    await check("Relationship: " + rel.name, async () => {
      const from = bundle.ontology.find((o) => o.name === rel.fromType),
        to = bundle.ontology.find((o) => o.name === rel.toType);
      assert(
        from && to,
        `Unknown object type in ${rel.fromType} → ${rel.toType}. Defined types: ${bundle.ontology.map((t) => t.name).join(", ")}. Include each referenced type with its source dataset and key.`,
      );
      const fromDatasetId = rel.fromDatasetId || from.datasetId,
        toDatasetId = rel.toDatasetId || to.datasetId,
        source = datasets.get(fromDatasetId),
        target = datasets.get(toDatasetId);
      assert(source && target, "Unknown relationship dataset");
      await sourceCurrent(source);
      await sourceCurrent(target);
      const fromColumn = source.data.profile.columns.find(
          (c: any) => c.name === rel.fromColumn,
        ),
        toColumn = target.data.profile.columns.find(
          (c: any) => c.name === rel.toColumn,
        );
      assert(fromColumn && toColumn, "Unknown relationship column");
      const hasScopedJoin = Boolean(rel.additionalJoinPairs?.length || rel.predicate);
      const cardinality = hasScopedJoin
        ? "complete-condition row and tuple fanout measured"
        : "join-column row and tuple fanout measured";
      const on = relationshipJoinCondition(rel, source.data.profile.columns, target.data.profile.columns);
      const canonicalPairs = (pairs: { fromColumn: string; toColumn: string }[] = []) => JSON.stringify([...pairs].sort((a, b) => a.fromColumn.localeCompare(b.fromColumn) || a.toColumn.localeCompare(b.toColumn)));
      const evidence = options.relationshipEvidence?.get(rel.name);
      if (evidence) {
        assert(
          evidence.fromDatasetId === fromDatasetId &&
            evidence.toDatasetId === toDatasetId &&
            evidence.fromColumn === rel.fromColumn &&
            evidence.toColumn === rel.toColumn &&
            canonicalPairs(evidence.additionalJoinPairs) === canonicalPairs(rel.additionalJoinPairs) &&
            JSON.stringify(evidence.predicate ? [evidence.predicate.side, evidence.predicate.column, evidence.predicate.op, evidence.predicate.value] : null) === JSON.stringify(rel.predicate ? [rel.predicate.side, rel.predicate.column, rel.predicate.op, rel.predicate.value] : null) &&
            (rel.predicate ? evidence.predicateBasis === rel.predicateBasis : true),
          "Saved relationship evidence does not match its definition",
        );
        assert(
          evidence.totalRows >= 0 &&
            evidence.matchedRows >= 0 &&
            evidence.matchedRows <= evidence.totalRows,
          "Invalid saved relationship match counts",
        );
        inputVersions[fromDatasetId] = source.data.activeVersion;
        inputVersions[toDatasetId] = target.data.activeVersion;
        const matchBasis = evidence.matchBasis || "unverified";
        const savedCardinality = `${hasScopedJoin ? "complete-condition" : "join-column"} tuple fanout not included in saved evidence; not remeasured`;
        previews["relation:" + rel.name] = {
          rows: [{ total: evidence.totalRows, matched: evidence.matchedRows }],
          matchBasis,
          cardinality: savedCardinality,
          evidence: evidence.evidence,
          caseInsensitive: evidence.caseInsensitive,
        };
        const coverage =
          matchBasis === "measured"
            ? `Saved measured counts: ${evidence.matchedRows}/${evidence.totalRows} source rows matched; not remeasured`
            : matchBasis === "asserted"
              ? "Catalog assertion; coverage not measured"
              : "Saved counts unverified; coverage not measured";
        return `${coverage}; ${savedCardinality}; ${evidence.evidence} evidence${evidence.caseInsensitive ? ", case-insensitive" : ""}`;
      }
      assert(
        !options.requireRelationshipEvidence,
        "Saved relationship evidence is unavailable or no longer matches current inputs and definitions. Rebuild the schema-only proposal.",
      );
      // A member's rows/keys are not the anchor object's identities. Until an
      // explicit member-to-anchor mapping exists, only schema/evidence review
      // is supported for these links; do not generate misleading object counts.
      assert(
        fromDatasetId === from.datasetId && toDatasetId === to.datasetId,
        "Source-member relationship previews require saved evidence; member-to-anchor identity mapping is not materialized",
      );
      let r: { rows: any[] };
      if (rel.additionalJoinPairs?.length || rel.predicate) {
        const primary = { ...rel, additionalJoinPairs: undefined, predicate: undefined, predicateBasis: undefined };
        const tuple = { ...rel, predicate: undefined, predicateBasis: undefined };
        const primaryOn = relationshipJoinCondition(primary, source.data.profile.columns, target.data.profile.columns);
        const tupleOn = relationshipJoinCondition(tuple, source.data.profile.columns, target.data.profile.columns);
        const basePairs = [{ fromColumn: rel.fromColumn, toColumn: rel.toColumn }];
        const fullPairs = [...basePairs, ...(rel.additionalJoinPairs || [])];
        const metric = (rowOn: string, tupleOn: string, pairs: typeof fullPairs, predicateFrom?: { column: string; value: string }, predicateTo?: { column: string; value: string }) => {
          const tupleColumns = [...new Set([
            ...pairs.map((pair) => pair.fromColumn),
            ...(predicateFrom ? [predicateFrom.column] : []),
          ])];
          const tupleProjection = tupleColumns.map((column) => `a.${q(column)}`).join(", ");
          const tupleGroup = tupleColumns.map((column) => `s.${q(column)}`).join(", ");
          const fromPredicate = predicateFrom ? `a.${q(predicateFrom.column)}='${predicateFrom.value.replaceAll("'", "''")}'` : undefined;
          const tupleFilter = fromPredicate ? ` WHERE ${fromPredicate}` : "";
          const eligibleExpr = fromPredicate ? `CASE WHEN ${fromPredicate} THEN 1 ELSE 0 END` : "1";
          const rowStats = `(SELECT count(*) AS total, coalesce(sum(eligible), 0) AS eligibleSourceRows, coalesce(sum(CASE WHEN target_count > 0 THEN 1 ELSE 0 END), 0) AS matched, coalesce(sum(target_count), 0) AS pairs, coalesce(sum(CASE WHEN target_count > 1 THEN 1 ELSE 0 END), 0) AS sourceRowsWithFanout, coalesce(max(target_count), 0) AS maxTargetsPerSourceRow FROM (SELECT a."__meridian_source_row", ${eligibleExpr} AS eligible, count(b."__meridian_target_row") AS target_count FROM a LEFT JOIN b ON ${rowOn} GROUP BY a."__meridian_source_row", eligible) row_matches)`;
          const tupleStats = `(SELECT count(*) AS sourceTupleCount, coalesce(sum(CASE WHEN target_count > 0 THEN 1 ELSE 0 END), 0) AS sourceMatchedTupleCount, coalesce(sum(CASE WHEN target_count > 1 THEN 1 ELSE 0 END), 0) AS sourceTuplesWithFanout, coalesce(max(target_count), 0) AS sourceMaxTargetsPerTuple FROM (SELECT ${tupleGroup}, count(b."__meridian_target_row") AS target_count FROM (SELECT DISTINCT ${tupleProjection} FROM a${tupleFilter}) s LEFT JOIN b ON ${tupleOn} GROUP BY ${tupleGroup}) tuple_matches)`;
          const targetColumns = pairs.map((pair) => `b.${q(pair.toColumn)}`);
          const targetGroup = targetColumns.join(", ");
          const targetFilter = predicateTo ? ` WHERE b.${q(predicateTo.column)}='${predicateTo.value.replaceAll("'", "''")}'` : "";
          const targetStats = `(SELECT count(*) AS targetTupleCount, coalesce(sum(CASE WHEN target_count > 1 THEN 1 ELSE 0 END), 0) AS targetDuplicateTupleGroups, coalesce(max(target_count), 0) AS maxTargetsPerTargetTuple FROM (SELECT ${targetGroup}, count(*) AS target_count FROM b${targetFilter} GROUP BY ${targetGroup}) target_matches)`;
          return `(SELECT row_stats.*, tuple_stats.*, target_stats.* FROM ${rowStats} row_stats CROSS JOIN ${tupleStats} tuple_stats CROSS JOIN ${targetStats} target_stats)`;
        };
        const primaryTupleOn = relationshipJoinCondition(primary, source.data.profile.columns, target.data.profile.columns, "s", "b");
        const fullTupleOn = relationshipJoinCondition(tuple, source.data.profile.columns, target.data.profile.columns, "s", "b");
        const scopedTupleOn = relationshipJoinCondition(rel, source.data.profile.columns, target.data.profile.columns, "s", "b");
        const sql = `WITH a AS (SELECT row_number() OVER () AS "__meridian_source_row", * FROM ${q(datasetTable(fromDatasetId))}), b AS (SELECT row_number() OVER () AS "__meridian_target_row", * FROM ${q(datasetTable(toDatasetId))}), primary_stats AS ${metric(primaryOn, primaryTupleOn, basePairs)}, tuple_stats AS ${metric(tupleOn, fullTupleOn, fullPairs)}, scoped_stats AS ${metric(on, scopedTupleOn, fullPairs, rel.predicate?.side === "from" ? { column: rel.predicate.column, value: rel.predicate.value } : undefined, rel.predicate?.side === "to" ? { column: rel.predicate.column, value: rel.predicate.value } : undefined)} SELECT scoped_stats.total, scoped_stats.eligibleSourceRows, scoped_stats.matched, scoped_stats.pairs, scoped_stats.sourceRowsWithFanout, scoped_stats.maxTargetsPerSourceRow, scoped_stats.sourceTupleCount, scoped_stats.sourceMatchedTupleCount, scoped_stats.sourceTuplesWithFanout, scoped_stats.sourceMaxTargetsPerTuple, scoped_stats.targetTupleCount, scoped_stats.targetDuplicateTupleGroups, scoped_stats.maxTargetsPerTargetTuple, primary_stats.matched AS rawPrimaryMatchedSourceRows, primary_stats.pairs AS rawPrimaryJoinPairs, primary_stats.sourceTuplesWithFanout AS rawPrimaryTuplesWithFanout, primary_stats.sourceMaxTargetsPerTuple AS rawPrimaryMaxTargetsPerTuple, tuple_stats.matched AS fullTupleMatchedSourceRows, tuple_stats.pairs AS fullTupleJoinPairs, tuple_stats.sourceTuplesWithFanout AS fullTupleTuplesWithFanout, tuple_stats.sourceMaxTargetsPerTuple AS fullTupleMaxTargetsPerTuple, scoped_stats.matched AS predicatedMatchedSourceRows, scoped_stats.pairs AS predicatedJoinPairs, scoped_stats.sourceTuplesWithFanout AS predicatedTuplesWithFanout, scoped_stats.sourceMaxTargetsPerTuple AS predicatedMaxTargetsPerTuple FROM primary_stats CROSS JOIN tuple_stats CROSS JOIN scoped_stats`;
        r = await query([fromDatasetId, toDatasetId], sql);
      } else {
        const sourceKey = `a.${q(rel.fromColumn)}`;
        const targetKey = `b.${q(rel.toColumn)}`;
        const sql = `WITH a AS (SELECT row_number() OVER () AS "__meridian_source_row", * FROM ${q(datasetTable(fromDatasetId))}), b AS (SELECT row_number() OVER () AS "__meridian_target_row", * FROM ${q(datasetTable(toDatasetId))}), row_matches AS (SELECT a."__meridian_source_row", count(b."__meridian_target_row") AS target_count FROM a LEFT JOIN b ON ${on} GROUP BY a."__meridian_source_row"), source_tuple_matches AS (SELECT s.${q(rel.fromColumn)}, count(b."__meridian_target_row") AS target_count FROM (SELECT DISTINCT ${sourceKey} FROM a) s LEFT JOIN b ON s.${q(rel.fromColumn)}=${targetKey} GROUP BY s.${q(rel.fromColumn)}), target_tuple_matches AS (SELECT ${targetKey}, count(*) AS target_count FROM b GROUP BY ${targetKey}), row_stats AS (SELECT count(*) AS total, coalesce(sum(CASE WHEN target_count > 0 THEN 1 ELSE 0 END), 0) AS matched, coalesce(sum(target_count), 0) AS pairs, coalesce(sum(CASE WHEN target_count > 1 THEN 1 ELSE 0 END), 0) AS sourceRowsWithFanout, coalesce(max(target_count), 0) AS maxTargetsPerSourceRow FROM row_matches), source_tuple_stats AS (SELECT count(*) AS sourceTupleCount, coalesce(sum(CASE WHEN target_count > 0 THEN 1 ELSE 0 END), 0) AS sourceMatchedTupleCount, coalesce(sum(CASE WHEN target_count > 1 THEN 1 ELSE 0 END), 0) AS sourceTuplesWithFanout, coalesce(max(target_count), 0) AS sourceMaxTargetsPerTuple FROM source_tuple_matches), target_tuple_stats AS (SELECT count(*) AS targetTupleCount, coalesce(sum(CASE WHEN target_count > 1 THEN 1 ELSE 0 END), 0) AS targetDuplicateTupleGroups, coalesce(max(target_count), 0) AS maxTargetsPerTargetTuple FROM target_tuple_matches) SELECT row_stats.*, source_tuple_stats.*, target_tuple_stats.* FROM row_stats CROSS JOIN source_tuple_stats CROSS JOIN target_tuple_stats`;
        r = await query([fromDatasetId, toDatasetId], sql);
      }
      const componentProfileCounts = (hasScopedJoin ? [
        ...[{ fromColumn: rel.fromColumn, toColumn: rel.toColumn }, ...(rel.additionalJoinPairs || [])].flatMap((pair) => [
          { side: "from", column: pair.fromColumn, profile: source.data.profile.columns.find((c: any) => c.name === pair.fromColumn) },
          { side: "to", column: pair.toColumn, profile: target.data.profile.columns.find((c: any) => c.name === pair.toColumn) },
        ]),
        ...(rel.predicate ? [{ side: rel.predicate.side, column: rel.predicate.column, profile: (rel.predicate.side === "from" ? source : target).data.profile.columns.find((c: any) => c.name === rel.predicate!.column) }] : []),
      ].map(({ side, column, profile }) => ({ side, column, nulls: profile?.nulls, blanks: profile?.blanks })) : []);
      previews["relation:" + rel.name] = {
        rows: r.rows,
        cardinality,
        matchBasis: "measured",
        ...(hasScopedJoin ? { componentProfileCounts } : {}),
      };
      const componentSummary = componentProfileCounts.map(({ side, column, nulls, blanks }) =>
        `${side}.${column}: ${nulls ?? "unknown"} null, ${blanks ?? "unknown"} blank`,
      ).join("; ");
      return `${r.rows[0].matched}/${r.rows[0].total} source rows matched; ${cardinality}; ${r.rows[0].pairs} relationship pairs` +
        (hasScopedJoin
          ? `; eligible source rows ${r.rows[0].eligibleSourceRows}/${r.rows[0].total}; complete tuple coverage ${r.rows[0].sourceMatchedTupleCount}/${r.rows[0].sourceTupleCount}; source tuples with fanout ${r.rows[0].sourceTuplesWithFanout}, max targets/tuple ${r.rows[0].sourceMaxTargetsPerTuple}; source rows with fanout ${r.rows[0].sourceRowsWithFanout}, max targets/row ${r.rows[0].maxTargetsPerSourceRow}; target tuple duplicates ${r.rows[0].targetDuplicateTupleGroups}/${r.rows[0].targetTupleCount}, max rows/target tuple ${r.rows[0].maxTargetsPerTargetTuple}; component profile counts: ${componentSummary}; primary-pair ${r.rows[0].rawPrimaryMatchedSourceRows} rows/${r.rows[0].rawPrimaryJoinPairs} pairs (tuple fanout ${r.rows[0].rawPrimaryTuplesWithFanout}, max ${r.rows[0].rawPrimaryMaxTargetsPerTuple}); full tuple ${r.rows[0].fullTupleMatchedSourceRows} rows/${r.rows[0].fullTupleJoinPairs} pairs (tuple fanout ${r.rows[0].fullTupleTuplesWithFanout}, max ${r.rows[0].fullTupleMaxTargetsPerTuple}); predicated ${r.rows[0].predicatedMatchedSourceRows} rows/${r.rows[0].predicatedJoinPairs} pairs (tuple fanout ${r.rows[0].predicatedTuplesWithFanout}, max ${r.rows[0].predicatedMaxTargetsPerTuple})`
          : `; source tuples ${r.rows[0].sourceMatchedTupleCount}/${r.rows[0].sourceTupleCount} matched, ${r.rows[0].sourceTuplesWithFanout} with fanout, max ${r.rows[0].sourceMaxTargetsPerTuple}; target tuple duplicates ${r.rows[0].targetDuplicateTupleGroups}/${r.rows[0].targetTupleCount}, max rows/target tuple ${r.rows[0].maxTargetsPerTargetTuple}`);
    });
  for (const d of bundle.dashboards)
    for (const [i, w] of d.widgets.entries())
      await check(`Dashboard: ${d.name} / ${w.title}`, async () => {
        const r = await query(w.inputs, w.sql);
        // Derive presentation only from the executed result shape.
        const cols = r.profile.columns;
        if (
          w.type === "metric" &&
          (r.profile.rows !== 1 || cols.length !== 1)
        ) {
          w.type =
            cols.length === 2 &&
            r.profile.rows > 1 &&
            /INT|DECIMAL|DOUBLE|FLOAT/i.test(cols[1].type)
              ? "bar"
              : "table";
          if (w.type === "bar") {
            w.x = cols[0].name;
            w.y = cols[1].name;
          }
        }
        for (const axis of ["x", "y"] as const)
          if (w[axis] && !cols.some((c) => c.name === w[axis])) {
            const last = w[axis]!.split(".").at(-1);
            if (cols.some((c) => c.name === last)) w[axis] = last;
          }
        if (w.x && ["bar", "line"].includes(w.type))
          assert(
            r.profile.columns.some((c) => c.name === w.x),
            "Unknown chart x field",
          );
        if (w.y && ["bar", "line"].includes(w.type))
          assert(
            r.profile.columns.some((c) => c.name === w.y),
            "Unknown chart y field",
          );
        previews["chart:" + d.name + ":" + i] = r.rows;
        return `${r.profile.rows} result rows; query executed`;
      });
  for (const a of bundle.actions)
    await check("Action: " + a.name, async () => {
      const t = bundle.ontology.find((o) => o.name === a.objectType);
      assert(t, "Unknown action type");
      assert(
        a.fields.every((f) => t.properties.includes(f) && f !== t.primaryKey),
        "Action fields must exist and cannot change identity",
      );
      return "Editable fields verified";
    });
  return {
    valid: checks.length > 0 && checks.every((c) => c.passed),
    checks,
    previews,
    inputVersions,
    validatedAt: now(),
    baseGeneration:
      (await store.get(scope, "workspace"))?.data.activeGeneration || null,
  };
}
