import { expect, it } from "vitest";
import { runValidateJob } from "../apps/api/src/validate-job.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";

async function validateVariants(variants: string[][], applied: boolean) {
  const store = new MemoryStore(),
    scope = "catalog-variants";
  const job = resource(
    scope,
    "job",
    "Validate",
    { onboardingSignature: "sig", status: "queued" },
    "job",
  );
  await transaction(store, scope, async (tx) => {
    tx.put(job);
    tx.put(
      resource(
        scope,
        "workspace",
        "Catalog",
        {
          onboarding: {
            ontologySuggestion: {
              signature: "sig",
              hash: "hash",
              summary: "Two tables",
              links: applied ? [{ id: "catalog-a-b" }] : [],
            },
          },
        },
        "workspace",
      ),
    );
    tx.put(
      resource(
        scope,
        "catalog",
        "Catalog",
        {
          version: 1,
          tables: [],
          domains: [],
          joins: [
            { leftTable: "A", leftKey: "ID", rightTable: "B", rightKey: "ID" },
          ],
        },
        "catalog",
      ),
    );
    for (const [i, columns] of variants.entries()) {
      tx.put(
        resource(
          scope,
          "dataset",
          `variant${i}/A.parquet`,
          { profile: { columns: columns.map((name) => ({ name })) } },
          `a${i}`,
        ),
      );
    }
    tx.put(
      resource(
        scope,
        "dataset",
        "B.parquet",
        { profile: { columns: [{ name: "ID" }] } },
        "b",
      ),
    );
  });
  return runValidateJob(store, scope, job);
}

it("does not call individually resolvable extract aliases ambiguous because their union has two names", async () => {
  expect(
    await validateVariants([["French_ID"], ["English_ID"]], true),
  ).toMatchObject({
    applied: 1,
    missingColumn: 0,
    outOfScope: 0,
    skipped: 0,
  });
});

it("counts a key as unresolved when every variant is internally ambiguous", async () => {
  expect(
    await validateVariants([["CUSTOMER_ID", "ORDER_ID"]], false),
  ).toMatchObject({
    applied: 0,
    missingColumn: 1,
    outOfScope: 0,
    skipped: 1,
  });
});
