import { expect, it } from "vitest";
import { confirmOntology, resolvedOntologyDigest } from "../apps/api/src/discovery/confirm.js";
import type { SuggestedOntology } from "../packages/shared/src/index.js";

const suggestion = (): SuggestedOntology => ({
  signature: "sig", hash: "fresh", summary: "", described: false,
  entities: ["from", "to"].map((id) => ({
    id, name: id, description: "", kind: "record", anchorDatasetId: id,
    key: "id", rows: 1, members: [{ datasetId: id, datasetName: id, source: "test", key: "id", rows: 1, matched: 1, via: null }], properties: ["id"],
  })),
  links: [{
    id: "edge", name: "references", from: "from", to: "to", fromDatasetId: "from", fromColumn: "id", toDatasetId: "to", toColumn: "id", totalRows: 1, matchedRows: 1, matchBasis: "measured", caseInsensitive: false, evidence: "values",
    predicateCandidates: [{ side: "to", column: "SPRAS", values: [
      { value: "E", candidateRows: 3, matchedSourceRows: 2, eligibleSourceRows: 4, joinPairs: 2 },
      { value: "D", candidateRows: 2, matchedSourceRows: 1, eligibleSourceRows: 4, joinPairs: 1 },
    ] }],
  }], notes: [], unplaced: [],
});

it("accepts only the exact measured candidate and records confirmed provenance", () => {
  const s = suggestion();
  const value = confirmOntology(s, { hash: s.hash, predicates: { edge: { side: "to", column: "SPRAS", value: "E" } } });
  expect(value.links[0]).toMatchObject({ predicate: { side: "to", column: "SPRAS", op: "=", value: "E" }, predicateBasis: "confirmed" });
  expect(() => confirmOntology(s, { hash: s.hash, predicates: { edge: { side: "from", column: "SPRAS", value: "E" } } })).toThrow(/candidate/);
});

it("ignores predicate request-map order in the approval digest", () => {
  const s = suggestion();
  s.links.push({ ...s.links[0], id: "edge2", name: "other" });
  const first = confirmOntology(s, { hash: s.hash, predicates: {
    edge: { side: "to", column: "SPRAS", value: "E" },
    edge2: { side: "to", column: "SPRAS", value: "D" },
  } });
  const second = confirmOntology(s, { hash: s.hash, predicates: {
    edge2: { side: "to", column: "SPRAS", value: "D" },
    edge: { side: "to", column: "SPRAS", value: "E" },
  } });
  expect(resolvedOntologyDigest(first)).toBe(resolvedOntologyDigest(second));
});

it("keeps legacy confirmations free of the new empty field", () => {
  const s = suggestion();
  const value = confirmOntology(s, { hash: s.hash });
  expect(value).not.toHaveProperty("analyticalSources");
});

it("accepts only unique unplaced analytical sources and binds them to approval", () => {
  const s = suggestion();
  s.unplaced = ["facts"];
  const source = {
    datasetId: "facts", name: "Monthly facts", description: "Reviewed totals", role: "fact" as const,
    grain: "one row per account and month", dimensions: ["account", "month"], measures: ["amount"],
  };
  const approved = confirmOntology(s, { hash: s.hash, analyticalSources: [source] });
  expect(approved.analyticalSources).toEqual([source]);
  expect(approved.unplaced).toEqual([]);
  expect(resolvedOntologyDigest(approved)).not.toBe(
    resolvedOntologyDigest({ ...approved, analyticalSources: [{ ...source, grain: "one row per month" }] }),
  );
  expect(() => confirmOntology(s, { hash: s.hash, analyticalSources: [{ ...source, datasetId: "not-unplaced" }] })).toThrow(/unplaced/);
});

it("canonicalizes order but changes the approval digest when scope changes", () => {
  const s = suggestion();
  const a = confirmOntology(s, { hash: s.hash, predicates: { edge: { side: "to", column: "SPRAS", value: "E" } } });
  const b = confirmOntology(s, { hash: s.hash, predicates: { edge: { side: "to", column: "SPRAS", value: "D" } } });
  expect(resolvedOntologyDigest(a)).toBe(resolvedOntologyDigest({ ...a, links: [...a.links].reverse() }));
  expect(resolvedOntologyDigest(a)).not.toBe(resolvedOntologyDigest(b));
});
