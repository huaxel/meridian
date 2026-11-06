import { afterEach, beforeEach, expect, it, vi } from "vitest";
const executor = vi.hoisted(() => vi.fn(async () => { throw Error("No data queries allowed"); }));
vi.mock("../apps/api/src/executor.js", () => ({ execute: executor }));
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { BundleSchema } from "../packages/shared/src/index.js";

let app: Awaited<ReturnType<typeof createApp>>;
let store: MemoryStore;
let scope: string;
const request = (method: "GET" | "POST" | "PUT", path: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1/workspaces/${scope}${path}`, payload: payload as any });

const scalarBundle = () => ({
  ...v2Bundle(),
  relationships: [{ name: "legacy edge", fromType: "A", toType: "B", fromColumn: "id", toColumn: "id" }],
});

const v2Bundle = () => ({
  summary: "Scoped relationship",
  assumptions: [], catalog: [], pipelines: [], ontology: [], dashboards: [], actions: [],
  relationships: [{
    name: "scoped edge", fromType: "A", toType: "B", fromColumn: "id", toColumn: "id",
    additionalJoinPairs: [{ fromColumn: "client", toColumn: "client" }],
    predicate: { side: "to", column: "OBJECTTYPE", op: "=", value: "0000" },
    predicateBasis: "confirmed",
  }],
});

beforeEach(async () => {
  executor.mockClear();
  store = new MemoryStore();
  app = await createApp(store);
  await app.ready();
  scope = (await app.inject({ method: "GET", url: "/api/v1/me" })).json().workspaces[0].id;
});
afterEach(async () => {
  expect(executor).not.toHaveBeenCalled();
  await app.close();
});

it("round-trips scoped semantics through the actual v2 definitions import route", async () => {
  const imported = await request("POST", "/definitions/import", { version: 2, proposals: [v2Bundle()] });
  expect(imported.statusCode, imported.body).toBe(200);
  expect(imported.json().items[0].data.bundle.relationships[0]).toMatchObject({
    additionalJoinPairs: [{ fromColumn: "client", toColumn: "client" }],
    predicate: { side: "to", column: "OBJECTTYPE", op: "=", value: "0000" },
    predicateBasis: "confirmed",
  });
  const legacyImport = await request("POST", "/definitions/import", {
    version: 1, proposals: [scalarBundle()],
  });
  expect(legacyImport.statusCode, legacyImport.body).toBe(200);
  expect(legacyImport.json().items[0].data.bundle.relationships[0]).not.toHaveProperty("predicate");
  expect(legacyImport.json().items[0].data.bundle.relationships[0]).not.toHaveProperty("additionalJoinPairs");

  const downgraded = await request("POST", "/definitions/import", {
    version: 1, proposals: [v2Bundle()],
  });
  expect(downgraded.statusCode).toBe(400);
  const misspelled = v2Bundle();
  (misspelled.relationships[0] as any).predciate = misspelled.relationships[0].predicate;
  const malformed = await request("POST", "/definitions/import", { version: 2, proposals: [misspelled] });
  expect(malformed.statusCode).toBe(400);
});

it("round-trips strict v3 analytical sources and rejects legacy erasure", async () => {
  const datasetId = "keyless-source";
  await transaction(store, scope, async (tx) => tx.put(resource(scope, "dataset", "Monthly facts", {
    activeVersion: "keyless-version",
    profile: { rows: 2, columns: [
      { name: "month", type: "VARCHAR", nulls: 0, distinct: 1, sensitive: false },
      { name: "amount", type: "INTEGER", nulls: 0, distinct: 2, sensitive: false },
    ], sample: [], fingerprint: "fixture" },
  }, datasetId)));
  const bundle = {
    summary: "Keyless facts", assumptions: [], catalog: [], pipelines: [], ontology: [],
    analyticalSources: [{ datasetId, name: "Monthly facts", description: "Reviewed", role: "fact", grain: "one row per month", dimensions: ["month"], measures: ["amount"] }],
    relationships: [], dashboards: [], actions: [],
  };
  const imported = await request("POST", "/definitions/import", { version: 3, proposals: [bundle] });
  expect(imported.statusCode, imported.body).toBe(200);
  const stored = imported.json().items[0];
  expect(stored.data.bundle.analyticalSources).toMatchObject([{ datasetId, role: "fact", grain: "one row per month" }]);
  const legacy = await request("PUT", `/proposals/${stored.id}`, { ...stored.data.bundle, analyticalSources: [] });
  expect(legacy.statusCode).toBe(409);
  expect(legacy.json().error).toMatch(/cannot remove or alter analytical-source semantics/i);
  const versioned = await request("PUT", `/proposals/${stored.id}`, { version: 3, bundle: stored.data.bundle });
  expect(versioned.statusCode, versioned.body).toBe(200);
});

it("keeps scalar-only definitions exports at v1", async () => {
  const bundle = BundleSchema.parse(scalarBundle());
  await transaction(store, scope, async (tx) => {
    const workspace = (await tx.get("workspace"))!;
    tx.update(workspace, { ...workspace.data, activeGeneration: "generation-scalar" });
    tx.put(resource(scope, "proposal", "Published scalar", {
      status: "published", publishedGeneration: "generation-scalar", bundle,
    }));
  });
  const exported = await request("GET", "/definitions/export");
  expect(exported.statusCode).toBe(200);
  expect(exported.json()).toMatchObject({ version: 1, proposals: [{ relationships: [{ name: "legacy edge" }] }] });
});

it("exports scoped published relationships in a v2 envelope", async () => {
  const bundle = BundleSchema.parse(v2Bundle());
  await transaction(store, scope, async (tx) => {
    const workspace = (await tx.get("workspace"))!;
    tx.update(workspace, { ...workspace.data, activeGeneration: "generation-scoped" });
    tx.put(resource(scope, "proposal", "Published scoped", {
      status: "published", publishedGeneration: "generation-scoped", bundle,
    }));
  });

  const exported = await request("GET", "/definitions/export");
  expect(exported.statusCode).toBe(200);
  expect(exported.json()).toMatchObject({
    version: 2,
    proposals: [{ relationships: [{
      additionalJoinPairs: [{ fromColumn: "client", toColumn: "client" }],
      predicate: { side: "to", column: "OBJECTTYPE", op: "=", value: "0000" },
      predicateBasis: "confirmed",
    }] }],
  });
});

it("exports analytical-source definitions in a v3 envelope", async () => {
  const bundle = BundleSchema.parse({
    ...scalarBundle(),
    analyticalSources: [{ datasetId: "facts", name: "Facts", description: "", role: "other", dimensions: [], measures: [] }],
  });
  await transaction(store, scope, async (tx) => {
    const workspace = (await tx.get("workspace"))!;
    tx.update(workspace, { ...workspace.data, activeGeneration: "generation-facts" });
    tx.put(resource(scope, "proposal", "Published facts", {
      status: "published", publishedGeneration: "generation-facts", bundle,
    }));
  });
  const exported = await request("GET", "/definitions/export");
  expect(exported.statusCode).toBe(200);
  expect(exported.json()).toMatchObject({ version: 3, proposals: [{ analyticalSources: [{ datasetId: "facts" }] }] });
});

it("exposes only active-generation analytical sources through resource and overview routes", async () => {
  await transaction(store, scope, async (tx) => {
    const workspace = (await tx.get("workspace"))!;
    tx.update(workspace, { ...workspace.data, activeGeneration: "generation-current" });
    tx.put(resource(scope, "analyticalSource", "Old facts", {
      generation: "generation-old", datasetId: "old-dataset", role: "fact",
    }));
    tx.put(resource(scope, "analyticalSource", "Current facts", {
      generation: "generation-current", datasetId: "current-dataset", role: "fact",
    }));
  });
  const listed = await request("GET", "/resources/analyticalSource");
  expect(listed.statusCode, listed.body).toBe(200);
  expect(listed.json().items.map((item: any) => item.name)).toEqual(["Current facts"]);
  const overview = await request("GET", "/overview");
  expect(overview.statusCode, overview.body).toBe(200);
  expect(overview.json().analyticalSource.map((item: any) => item.name)).toEqual(["Current facts"]);
  const home = await request("GET", "/home");
  expect(home.statusCode, home.body).toBe(200);
  expect(home.json().counts.analyticalSources).toBe(1);
});

it("rejects a legacy proposal update that drops scoped semantics", async () => {
  const scoped = BundleSchema.parse(v2Bundle());
  const id = "proposal-with-scoped-link";
  await transaction(store, scope, async (tx) => tx.put(resource(scope, "proposal", "Scoped", {
    bundle: scoped, status: "draft", hash: "old-hash",
  }, id)));
  const legacy = { ...scoped, relationships: [{
    name: "scoped edge", fromType: "A", toType: "B", fromColumn: "id", toColumn: "id",
  }] };
  const updated = await request("PUT", `/proposals/${id}`, legacy);
  expect(updated.statusCode).toBe(409);
  expect(updated.json().error).toMatch(/cannot remove or alter scoped\/composite/i);
});
