import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execute as localExecute } from "../services/executor/src/engine.js";
let calls = 0;
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => {
    calls++;
    return localExecute(job);
  },
}));
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows } from "../apps/api/src/datasets.js";
import {
  saveProposal,
  publishProposal,
} from "../apps/api/src/assistant.js";
import { BundleSchema, datasetTable } from "../packages/shared/src/index.js";

const scope = "scale-" + randomUUID();

it("publishes dashboard-only without staging rows or queries", async () => {
  const store = new MemoryStore();
  await transaction(store, scope, async (tx) =>
    tx.put(resource(scope, "workspace", "Scale", {}, "workspace")),
  );
  await transaction(store, "global", async (tx) =>
    tx.put(
      resource("global", "member", "Editor", { role: "editor" }, `actor:${scope}`),
    ),
  );
  const customers = await ingestRows(
    store,
    scope,
    "Customers",
    [
      { id: "A", region: "EU" },
      { id: "B", region: "NA" },
    ],
    undefined,
    "customers",
  );
  const facts = await ingestRows(store, scope, "Daily totals", [
    { day: "2025-01-01", amount: 10 },
    { day: "2025-01-01", amount: 12 },
  ], undefined, "daily-totals");
  // Pretend planetary scale: validation still runs against the real rows,
  // but publishing must not page through the claimed ones.
  await transaction(store, scope, async (tx) => {
    const ds = (await tx.get(customers.id))!;
    tx.update(ds, {
      ...ds.data,
      profile: { ...ds.data.profile, rows: 50_000_000 },
    });
  });
  const bundle = BundleSchema.parse({
    summary: "Customer count at planetary scale",
    assumptions: ["A customer is one row."],
    catalog: [],
    pipelines: [],
    ontology: [
      { name: "Customer", datasetId: customers.id, primaryKey: "id", properties: ["id", "region"] },
    ],
    analyticalSources: [{
      datasetId: facts.id, name: "Daily totals", description: "Daily aggregate rows",
      role: "fact", grain: "one row per day and measure", dimensions: ["day"], measures: ["amount"],
    }],
    relationships: [],
    dashboards: [
      {
        name: "Overview",
        widgets: [
          {
            title: "Customers",
            type: "metric",
            inputs: [customers.id],
            sql: `SELECT count(*) customers FROM ${datasetTable(customers.id)}`,
          },
        ],
      },
    ],
    actions: [],
  });
  const p = await saveProposal(store, scope, bundle);
  expect(p.data.validation.valid).toBe(true);
  calls = 0;
  await publishProposal(store, scope, p.id, p.data.hash, "actor", "ok", {
    stageRecords: false,
  });
  expect(calls).toBe(0);
  expect((await store.list(scope, "object")).length).toBe(0);
  expect(await store.list(scope, "analyticalSource")).toMatchObject([
    { name: "Daily totals", data: { datasetId: facts.id, role: "fact", generation: expect.any(String) } },
  ]);
  expect((await store.list(scope, "dashboard")).length).toBe(1);
  expect((await store.list(scope, "publication")).length).toBe(1);
  const types = await store.list(scope, "objectType");
  expect(types.length).toBe(1);
  expect(types[0].data.objectCount).toBe(50_000_000);
  expect(
    (await store.get(scope, "workspace"))?.data.activeGeneration,
  ).toBeTruthy();
  vi.restoreAllMocks();
});

it("publishes hundreds of ontology types and links in bounded chunks without staging rows", async () => {
  const store = new MemoryStore(),
    largeScope = "scale-full-" + randomUUID();
  await transaction(store, largeScope, async (tx) =>
    tx.put(resource(largeScope, "workspace", "Large", {}, "workspace")),
  );
  await transaction(store, "global", async (tx) =>
    tx.put(
      resource(
        "global",
        "member",
        "Editor",
        { role: "editor" },
        `actor:${largeScope}`,
      ),
    ),
  );
  const datasets = Array.from({ length: 714 }, (_, i) =>
    resource(
      largeScope,
      "dataset",
      `Local table ${i}`,
      {
        activeVersion: `version_${i}`,
        profile: { rows: 2500, columns: [] },
        table: datasetTable(`local_${i}`),
      },
      `local_${i}`,
    ),
  );
  await transaction(store, largeScope, async (tx) =>
    datasets.forEach((d) => tx.put(d)),
  );
  const ontology = Array.from({ length: 431 }, (_, i) => ({
    name: `Entity ${i}`,
    datasetId: datasets[i].id,
    primaryKey: "id",
    properties: ["id"],
  }));
  const relationships = Array.from({ length: 254 }, (_, i) => ({
    name: `Link ${i}`,
    fromType: `Entity ${i}`,
    toType: `Entity ${i + 1}`,
    fromColumn: "parent_id",
    toColumn: "id",
    fromDatasetId: datasets[i].id,
    toDatasetId: datasets[i + 1].id,
  }));
  const bundle = BundleSchema.parse({
    summary: "Full Local ontology",
    assumptions: [],
    catalog: datasets.map((d) => ({
      datasetId: d.id,
      description: d.name,
      tags: ["local"],
    })),
    pipelines: [],
    ontology,
    relationships,
    dashboards: [
      {
        name: "Overview",
        widgets: [
          {
            title: "Records",
            type: "metric",
            inputs: [datasets[0].id],
            sql: "SELECT 2500 AS records",
          },
        ],
      },
    ],
    actions: [],
  });
  const report = {
    valid: true,
    checks: [],
    previews: {},
    inputVersions: Object.fromEntries(
      datasets.map((d) => [d.id, d.data.activeVersion]),
    ),
    validatedAt: new Date().toISOString(),
    baseGeneration: null,
  };
  const proposal = resource(
    largeScope,
    "proposal",
    "Full Local ontology",
    { bundle, validation: report, status: "ready", hash: "large-hash" },
    "large-proposal",
  );
  await transaction(store, largeScope, async (tx) => tx.put(proposal));
  const run = resource(
    largeScope,
    "run",
    "Large ontology build",
    {
      task: "onboarding_build",
      status: "running",
      stage: "publishing",
      proposalId: proposal.id,
      events: [],
      ontology: { entities: Array.from({ length: 431 }, (_, i) => ({ id: i })) },
      context: { catalog: bundle.catalog },
      checkpoints: { ontology: bundle.ontology },
      partialBundle: bundle,
      validation: report,
    },
    "large-build-run",
  );
  await transaction(store, largeScope, async (tx) => tx.put(run));
  calls = 0;
  const published = await publishProposal(
    store,
    largeScope,
    proposal.id,
    "large-hash",
    "actor",
    "published",
    { stageRecords: false },
  );
  expect(calls).toBe(0);
  expect((await store.list(largeScope, "objectType"))).toHaveLength(431);
  expect((await store.list(largeScope, "object"))).toHaveLength(0);
  expect((await store.list(largeScope, "dashboard"))).toHaveLength(1);
  expect(published.data.bundle.ontology).toHaveLength(431);
  expect(published.data.bundle.relationships).toHaveLength(254);
  expect(published.data.publishedGeneration).toBeTruthy();
  const completedRun = (await store.get(largeScope, run.id))!;
  expect(completedRun.data).toMatchObject({
    status: "succeeded",
    stage: "published",
  });
  expect(completedRun.data.ontology).toBeUndefined();
  expect(completedRun.data.partialBundle).toBeUndefined();
  expect(completedRun.data.checkpoints).toBeUndefined();
  expect(completedRun.data.context).toBeUndefined();
  expect(completedRun.data.validation).toBeUndefined();
  vi.restoreAllMocks();
});
