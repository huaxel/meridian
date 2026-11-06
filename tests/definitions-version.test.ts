import { expect, it } from "vitest";
import { BundleV2Schema, BundleV3Schema, DefinitionsImportSchema } from "../packages/shared/src/index.js";
import { proposalHash } from "../apps/api/src/assistant/provider.js";

const scalar = {
  summary: "", assumptions: [], catalog: [], pipelines: [], ontology: [], dashboards: [],
  relationships: [{ name: "r", fromType: "A", toType: "B", fromColumn: "id", toColumn: "id" }],
};
const scoped = {
  ...scalar,
  relationships: [{ ...scalar.relationships[0], additionalJoinPairs: [{ fromColumn: "client", toColumn: "client" }], predicate: { side: "to", column: "OBJECTTYPE", op: "=", value: "0000" }, predicateBasis: "asserted" }],
};

it("keeps scalar definitions in v1 and requires v2 for semantic relationships", () => {
  expect(DefinitionsImportSchema.safeParse({ version: 1, proposals: [scalar] }).success).toBe(true);
  expect(DefinitionsImportSchema.safeParse({ version: 1, proposals: [scoped] }).success).toBe(false);
  expect(DefinitionsImportSchema.safeParse({ version: 2, proposals: [scoped] }).success).toBe(true);
  expect(DefinitionsImportSchema.safeParse({ version: 2, proposals: [{ ...scoped, relationships: [{ ...scoped.relationships[0], predciate: scoped.relationships[0].predicate }] }] }).success).toBe(false);
  expect(BundleV2Schema.safeParse(scoped).success).toBe(true);
});

it("requires definitions v3 for analytical sources and rejects v2 downgrade", () => {
  const analytical = {
    ...scalar,
    analyticalSources: [{ datasetId: "facts", name: "Facts", description: "", role: "other", dimensions: [], measures: [] }],
  };
  expect(DefinitionsImportSchema.safeParse({ version: 2, proposals: [analytical] }).success).toBe(false);
  expect(DefinitionsImportSchema.safeParse({ version: 3, proposals: [analytical] }).success).toBe(true);
  expect(BundleV3Schema.safeParse({ ...analytical, unknown: true }).success).toBe(false);
  expect(BundleV3Schema.safeParse({ ...analytical, analyticalSources: [{ ...analytical.analyticalSources[0], measurez: [] }] }).success).toBe(false);
});

it("canonicalizes AND-pair order in proposal hashes but binds predicate values", () => {
  const bundle: any = { ...scoped, analyticalSources: [], relationships: [{ ...scoped.relationships[0], additionalJoinPairs: [
    { fromColumn: "client", toColumn: "client" },
    { fromColumn: "year", toColumn: "year" },
  ] }] };
  const report: any = { inputVersions: { d: "v1" }, baseGeneration: null };
  const reversed = { ...bundle, relationships: [{ ...bundle.relationships[0], additionalJoinPairs: [...bundle.relationships[0].additionalJoinPairs].reverse() }] };
  const otherScope = { ...bundle, relationships: [{ ...bundle.relationships[0], predicate: { ...bundle.relationships[0].predicate, value: "0001" } }] };
  expect(proposalHash(bundle, report)).toBe(proposalHash(reversed, report));
  expect(proposalHash(bundle, report)).not.toBe(proposalHash(otherScope, report));
  expect(proposalHash(bundle, report)).not.toBe(proposalHash({ ...bundle, analyticalSources: [{ datasetId: "facts", name: "Facts", description: "", role: "other", dimensions: [], measures: [], grain: "one per day" }] }, report));
});
