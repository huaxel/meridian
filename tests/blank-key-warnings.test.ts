import { expect, it } from "vitest";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { validateBundle } from "../apps/api/src/assistant/validate.js";
import { BundleSchema } from "../packages/shared/src/index.js";

async function validateWithBlanks(blanks: number | undefined) {
  const store = new MemoryStore();
  const scope = "blanks-" + String(blanks);
  await transaction(store, scope, async (tx) => {
    tx.put(resource(scope, "workspace", "Blanks", {}, "workspace"));
    tx.put(
      resource(
        scope,
        "dataset",
        "addrs.parquet",
        {
          activeVersion: "v1",
          profile: {
            rows: 2,
            columns: [
              {
                name: "id",
                type: "VARCHAR",
                nulls: 0,
                distinct: 2,
                primaryKey: true,
                examples: [],
                sensitive: false,
                ...(blanks === undefined ? {} : { blanks }),
              },
            ],
            sample: [],
            fingerprint: "f",
          },
        },
        "addrs",
      ),
    );
  });
  const bundle = BundleSchema.parse({
    summary: "Blank keys",
    assumptions: [],
    catalog: [],
    pipelines: [],
    ontology: [
      {
        name: "Address",
        datasetId: "addrs",
        primaryKey: "id",
        properties: ["id"],
      },
    ],
    relationships: [],
    dashboards: [],
    actions: [],
  });
  return validateBundle(store, scope, bundle);
}

it("warns about recorded blank keys without failing validation", async () => {
  const report = await validateWithBlanks(1);
  expect(report.valid).toBe(true);
  expect(
    report.checks.find((c) => c.name === "Ontology: Address"),
  ).toMatchObject({
    passed: true,
    detail:
      "2 objects; unique non-null key; 1 blank key value(s) present — record identity needs review",
  });
});

it("stays silent when blank counts were never measured", async () => {
  const report = await validateWithBlanks(undefined);
  expect(report.valid).toBe(true);
  expect(
    report.checks.find((c) => c.name === "Ontology: Address"),
  ).toMatchObject({
    passed: true,
    detail: "2 objects; unique non-null key",
  });
});
