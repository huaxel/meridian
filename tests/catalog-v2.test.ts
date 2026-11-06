import { afterAll, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { BundleSchema, CatalogImportSchema } from "../packages/shared/src/index.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows } from "../apps/api/src/datasets.js";
import { onboardingState } from "../apps/api/src/onboarding-state.js";
import { suggestOntology } from "../apps/api/src/discovery.js";
import { validateBundle } from "../apps/api/src/assistant/validate.js";
import { config } from "../apps/api/src/config.js";
import { execute as localExecute } from "../services/executor/src/engine.js";
import { vi } from "vitest";
vi.mock("../apps/api/src/executor.js", () => ({ execute: (job: any) => localExecute(job) }));

const store = new MemoryStore();
const scope = `predicate_metrics_${Date.now()}`;
const workspace = () => transaction(store, scope, async (tx) => tx.put(resource(scope, "workspace", "Test", {}, "workspace")));

afterAll(async () => {
  for (const dir of ["incoming", "datasets"])
    await rm(resolve(config.dataDir, dir, scope), { recursive: true, force: true });
});

it("accepts strict v2 semantics and rejects downgrade and misspellings", () => {
  const catalog = {
    version: 2,
    tables: [],
    joins: [{ leftTable: "BSEG", leftKey: "BELNR", rightTable: "BKPF", rightKey: "BELNR", additionalJoinPairs: [{ leftKey: "BUKRS", rightKey: "BUKRS" }], predicate: { side: "right", column: "OBJECTTYPE", op: "=", value: "0000" } }],
    domains: [],
  };
  expect(CatalogImportSchema.safeParse(catalog).success).toBe(true);
  expect(CatalogImportSchema.safeParse({ ...catalog, version: 1 }).success).toBe(false);
  expect(CatalogImportSchema.safeParse({ ...catalog, joins: [{ ...catalog.joins[0], predciate: catalog.joins[0].predicate }] }).success).toBe(false);
  expect(CatalogImportSchema.safeParse({ ...catalog, unexpected: true }).success).toBe(false);
});

it("measures candidate counts against the full composite join", async () => {
  await workspace();
  const source = await ingestRows(store, scope, "BSEG", [
    { BELNR: "X", MANDT: "100", BUKRS: "A", GJAHR: "2024", BUZEI: "001", SPRAS: "E" },
    { BELNR: "X", MANDT: "100", BUKRS: "A", GJAHR: "2024", BUZEI: "002", SPRAS: "D" },
    { BELNR: "Y", MANDT: "100", BUKRS: "B", GJAHR: "2024", BUZEI: "001", SPRAS: "E" },
  ]);
  const target = await ingestRows(store, scope, "BKPF", [
    { BELNR: "X", MANDT: "100", BUKRS: "A", GJAHR: "2024", OBJECTTYPE: "0000" },
    { BELNR: "X", MANDT: "100", BUKRS: "A", GJAHR: "2023", OBJECTTYPE: "0001" },
    { BELNR: "Y", MANDT: "100", BUKRS: "B", GJAHR: "2024", OBJECTTYPE: "0000" },
  ]);
  await transaction(store, scope, async (tx) => tx.put(resource(scope, "catalog", "SAP tuple", {
    version: 2,
    tables: [
      { table: "BSEG", keys: [["MANDT", "BUKRS", "BELNR", "GJAHR", "BUZEI"]] },
      { table: "BKPF", keys: [["MANDT", "BUKRS", "BELNR", "GJAHR"]] },
    ],
    domains: [], joins: [{
      leftTable: "BSEG", leftKey: "BELNR", rightTable: "BKPF", rightKey: "BELNR",
      additionalJoinPairs: [
        { leftKey: "MANDT", rightKey: "MANDT" },
        { leftKey: "BUKRS", rightKey: "BUKRS" },
        { leftKey: "GJAHR", rightKey: "GJAHR" },
      ],
    }],
  }, "catalog")));
  const state = await onboardingState(store, scope);
  const suggestion = await suggestOntology(store, scope, {
    datasets: state.datasets, sources: state.sources, signature: state.signature,
  });
  const link = suggestion.links.find((item) => item.fromDatasetId === source.id && item.toDatasetId === target.id);
  expect(link?.additionalJoinPairs).toHaveLength(3);
  const values = link?.predicateCandidates?.find((item) => item.side === "to" && item.column === "OBJECTTYPE")?.values;
  expect(values?.find((item) => item.value === "0000")).toMatchObject({
    candidateRows: 2, matchedSourceRows: 3, eligibleSourceRows: 3, joinPairs: 3,
  });
  const sourceValues = link?.predicateCandidates?.find((item) => item.side === "from" && item.column === "SPRAS")?.values;
  expect(sourceValues?.find((item) => item.value === "E")).toMatchObject({
    candidateRows: 2, matchedSourceRows: 2, eligibleSourceRows: 2, joinPairs: 2,
  });
});

it("validates keyless analytical sources without requiring row identity", async () => {
  await workspace();
  const source = await ingestRows(store, scope, "Monthly totals", [
    { period: "2025-01", region: "EU", amount: 10 },
    { period: "2025-01", region: "EU", amount: 12 },
  ]);
  const bundle = BundleSchema.parse({
    summary: "Analytical source", assumptions: [], catalog: [], pipelines: [], ontology: [],
    analyticalSources: [{
      datasetId: source.id, name: "Monthly totals", description: "Aggregated measures",
      role: "fact", grain: "one row per region and month", dimensions: ["period", "region"], measures: ["amount"],
    }],
    relationships: [], dashboards: [], actions: [],
  });
  const report = await validateBundle(store, scope, bundle);
  expect(report.valid).toBe(true);
  expect(report.inputVersions[source.id]).toBe(source.data.activeVersion);
  expect(report.checks.find((check) => check.name === "Analytical source: Monthly totals")?.detail)
    .toContain("no row identity or graph records asserted");

  const invalid = await validateBundle(store, scope, BundleSchema.parse({
    ...bundle,
    analyticalSources: [{ ...bundle.analyticalSources[0], measures: ["region"] }],
  }));
  expect(invalid.valid).toBe(false);
  expect(invalid.checks.find((check) => check.name === "Analytical source: Monthly totals")?.detail)
    .toContain("must have a numeric type");

  const dual = await validateBundle(store, scope, BundleSchema.parse({
    ...bundle,
    ontology: [{ name: "Monthly row", datasetId: source.id, primaryKey: "period", properties: ["period"] }],
  }));
  expect(dual.valid).toBe(false);
  expect(dual.checks.find((check) => check.name === "Dataset classification")?.passed).toBe(false);

  const edge = await validateBundle(store, scope, BundleSchema.parse({
    ...bundle,
    relationships: [{ name: "forbidden edge", fromType: "Monthly totals", toType: "Monthly totals", fromColumn: "region", toColumn: "region" }],
  }));
  expect(edge.valid).toBe(false);
  expect(edge.checks.find((check) => check.name === "Relationship: forbidden edge")?.detail)
    .toMatch(/Unknown object type/);
});

it("reports complete-condition row and source-tuple fanout separately", async () => {
  await workspace();
  const source = await ingestRows(store, scope, "Source tuples", [
    { source_id: "s1", doc: "x", client: "c1" },
    { source_id: "s2", doc: "x", client: "c1" },
    { source_id: "s3", doc: "y", client: "c1" },
    { source_id: "s4", doc: "z", client: "c2" },
    { source_id: "s5", doc: null, client: "c3" },
    { source_id: "s6", doc: "", client: "c3" },
  ]);
  const target = await ingestRows(store, scope, "Target tuples", [
    { target_id: "t1", doc: "x", client: "c1", kind: "live" },
    { target_id: "t2", doc: "x", client: "c1", kind: "retired" },
    { target_id: "t3", doc: "x", client: "c2", kind: "live" },
    { target_id: "t4", doc: "y", client: "c1", kind: "live" },
    { target_id: "t5", doc: "z", client: "c2", kind: "live" },
  ]);
  const bundle = BundleSchema.parse({
    summary: "tuple fanout fixture", assumptions: [], catalog: [], pipelines: [],
    ontology: [
      { name: "Source", datasetId: source.id, primaryKey: "source_id", properties: ["doc", "client"], description: "" },
      { name: "Target", datasetId: target.id, primaryKey: "target_id", properties: ["doc", "client", "kind"], description: "" },
    ],
    relationships: [{
      name: "references", fromType: "Source", toType: "Target", fromColumn: "doc", toColumn: "doc",
      additionalJoinPairs: [{ fromColumn: "client", toColumn: "client" }],
      predicate: { side: "to", column: "kind", op: "=", value: "live" }, predicateBasis: "confirmed",
    }, {
      name: "sourceScoped", fromType: "Source", toType: "Target", fromColumn: "doc", toColumn: "doc",
      additionalJoinPairs: [{ fromColumn: "client", toColumn: "client" }],
      predicate: { side: "from", column: "client", op: "=", value: "c1" }, predicateBasis: "confirmed",
    }, {
      name: "scalar", fromType: "Source", toType: "Target", fromColumn: "doc", toColumn: "doc",
    }],
    dashboards: [], actions: [],
  });
  const report = await validateBundle(store, scope, bundle);
  expect(report.checks.filter((check) => !check.passed)).toEqual([]);
  const metrics = (report.previews["relation:references"] as any).rows[0];
  expect(metrics).toMatchObject({
    total: "6", matched: "4", pairs: "4", sourceRowsWithFanout: "0", maxTargetsPerSourceRow: "1",
    sourceTupleCount: "5", sourceMatchedTupleCount: "3", sourceTuplesWithFanout: "0", sourceMaxTargetsPerTuple: "1",
    targetTupleCount: "4", targetDuplicateTupleGroups: "0", maxTargetsPerTargetTuple: "1",
    rawPrimaryJoinPairs: "8", fullTupleJoinPairs: "6", fullTupleTuplesWithFanout: "1",
    predicatedJoinPairs: "4", predicatedTuplesWithFanout: "0",
  });
  expect(report.previews["relation:references"]).toMatchObject({
    componentProfileCounts: expect.arrayContaining([
      { side: "from", column: "doc", nulls: 1, blanks: 1 },
      { side: "to", column: "kind", nulls: 0, blanks: 0 },
    ]),
  });
  expect(report.checks.find((check) => check.name === "Relationship: references")?.detail)
    .toContain("target tuple duplicates 0/4, max rows/target tuple 1");
  expect((report.previews["relation:scalar"] as any).rows[0]).toMatchObject({
    total: "6", matched: "4", pairs: "8", sourceRowsWithFanout: "2", maxTargetsPerSourceRow: "3",
    sourceTupleCount: "5", sourceMatchedTupleCount: "3", sourceTuplesWithFanout: "1", sourceMaxTargetsPerTuple: "3",
    targetTupleCount: "3", targetDuplicateTupleGroups: "1", maxTargetsPerTargetTuple: "3",
  });
  expect((report.previews["relation:scalar"] as any).cardinality).toBe("join-column row and tuple fanout measured");
  expect((report.previews["relation:sourceScoped"] as any).rows[0]).toMatchObject({
    total: "6", eligibleSourceRows: "3", matched: "3", pairs: "5",
    sourceTupleCount: "2", sourceMatchedTupleCount: "2", sourceTuplesWithFanout: "1", sourceMaxTargetsPerTuple: "2",
    sourceRowsWithFanout: "2", maxTargetsPerSourceRow: "2",
    targetDuplicateTupleGroups: "1", maxTargetsPerTargetTuple: "2",
  });
});
