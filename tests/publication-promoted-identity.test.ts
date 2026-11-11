import { expect, it } from "vitest";
import { publicationReview } from "../apps/api/src/assistant/publication-mode.js";
import { proposalHash } from "../apps/api/src/assistant/provider.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { pipelineId } from "../apps/api/src/datasets.js";
import { BundleSchema } from "../packages/shared/src/index.js";

// A schema-only proposal whose relationship endpoints are promoted composite
// identities: the types live on pipeline outputs, the links read raw datasets.
// Validation records no input version for a derived output, so publication has
// to treat it as fresh instead of unverifiable — otherwise every promoted
// relationship rejects the proposal with 409.
const bundle = BundleSchema.parse({
  summary: "Promoted identities",
  assumptions: [],
  catalog: [],
  pipelines: [
    {
      name: "Orders (Local key)",
      description: "orders",
      inputs: ["orders"],
      sql: 'SELECT a."company", lower(trim(CAST(a."company" AS VARCHAR))) AS "composite_key" FROM "d_orders" a',
      nodes: [],
      checks: [
        {
          name: "One row per order",
          sql: 'SELECT count(*) = count(DISTINCT "composite_key") AS ok FROM "d_piped"',
        },
      ],
    },
  ],
  ontology: [
    {
      name: "Order",
      datasetId: pipelineId("Orders (Local key)"),
      primaryKey: "composite_key",
      properties: ["composite_key", "company"],
    },
    { name: "Customer", datasetId: "customers", primaryKey: "id", properties: ["id"] },
  ],
  relationships: [
    {
      name: "places",
      fromType: "Order",
      toType: "Customer",
      fromColumn: "company",
      toColumn: "id",
      fromDatasetId: "orders",
      toDatasetId: "customers",
    },
  ],
  dashboards: [],
  actions: [],
});

const report = {
  valid: true,
  checks: [
    { name: "Ontology: Order", passed: true, detail: "measured" },
    { name: "Ontology: Customer", passed: true, detail: "measured" },
    { name: "Relationship: places", passed: true, detail: "measured" },
  ],
  previews: {
    "relation:places": {
      rows: [{ total: 100, matched: 90 }],
      matchBasis: "measured",
      evidence: "values",
      caseInsensitive: false,
    },
  },
  inputVersions: { orders: "v1", customers: "v2" },
};

async function review(publicationMode: string, tweak: (r: any) => void = () => {}) {
  const store = new MemoryStore(),
    scope = "promoted";
  const validation = structuredClone(report);
  tweak(validation);
  const proposal = resource(scope, "proposal", "Review", {
    status: "ready",
    publicationMode,
    bundle,
    validation,
    hash: proposalHash(bundle, validation as never),
  });
  // Publication re-reads the recorded inputs: the raw datasets must still carry
  // the versions validation saw.
  await transaction(store, scope, async (tx) => {
    tx.put(proposal);
    tx.put(resource(scope, "dataset", "orders", { activeVersion: "v1" }, "orders"));
    tx.put(resource(scope, "dataset", "customers", { activeVersion: "v2" }, "customers"));
  });
  return publicationReview(store, scope, proposal, bundle);
}

it("restores evidence for a promoted type on a derived output", async () => {
  const r = await review("schema-only");
  expect(r.mode).toBe("schema-only");
  expect(r.relationshipEvidence.has("places")).toBe(true);
});

it("still refuses evidence whose raw datasets are not versioned", async () => {
  const r = await review("schema-only", (v) => {
    delete v.inputVersions.customers;
    v.inputVersions = { orders: "v1" };
  });
  expect(r.relationshipEvidence.has("places")).toBe(false);
});
