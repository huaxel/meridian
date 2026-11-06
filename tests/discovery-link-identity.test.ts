import { expect, it } from "vitest";
import { sourceLinkIdentity } from "../apps/api/src/discovery/link-identity.js";

const link = {
  from: "source-role",
  to: "target-role",
  fromDatasetId: "source",
  fromColumn: "foreign_key",
  toDatasetId: "target",
  toColumn: "key",
  caseInsensitive: false,
};

it("does not use suggestion IDs, labels or asserted match counts as mapping identity", () => {
  const a = { ...link, id: "first", name: "references", matchedRows: 100 };
  const b = { ...link, id: "second", name: "another label", matchedRows: 50 };
  expect(sourceLinkIdentity(a)).toBe(sourceLinkIdentity(b));
});

it("distinguishes entity roles, physical endpoints, direction and comparison mode", () => {
  const variants = [
    link,
    { ...link, from: "another-source-role" },
    { ...link, to: "another-target-role" },
    { ...link, fromDatasetId: "another-source" },
    { ...link, toDatasetId: "another-target" },
    { ...link, fromColumn: "another-foreign-key" },
    { ...link, toColumn: "another-key" },
    { ...link, caseInsensitive: true },
    {
      from: link.to,
      to: link.from,
      fromDatasetId: link.toDatasetId,
      fromColumn: link.toColumn,
      toDatasetId: link.fromDatasetId,
      toColumn: link.fromColumn,
      caseInsensitive: false,
    },
  ];
  expect(new Set(variants.map(sourceLinkIdentity)).size).toBe(variants.length);
});

it("canonicalizes pair order but distinguishes composite mappings and scoped values", () => {
  const a = { ...link, additionalJoinPairs: [{ fromColumn: "client", toColumn: "client_id" }, { fromColumn: "year", toColumn: "fiscal_year" }] };
  const reordered = { ...link, additionalJoinPairs: [...a.additionalJoinPairs].reverse() };
  expect(sourceLinkIdentity(a)).toBe(sourceLinkIdentity(reordered));
  expect(sourceLinkIdentity(a)).not.toBe(sourceLinkIdentity({ ...a, additionalJoinPairs: [{ fromColumn: "client", toColumn: "client_id" }] }));
  const scoped = { ...a, predicate: { side: "to" as const, column: "OBJECTTYPE", op: "=" as const, value: "0000" }, predicateBasis: "asserted" as const };
  expect(sourceLinkIdentity(scoped)).not.toBe(sourceLinkIdentity(a));
  expect(sourceLinkIdentity(scoped)).not.toBe(sourceLinkIdentity({ ...scoped, predicate: { ...scoped.predicate, value: "0001" } }));
});

it("does not collide when physical identifiers contain tuple separator characters", () => {
  const a = { ...link, fromColumn: "x|y", toDatasetId: "z" };
  const b = { ...link, fromColumn: "x", toDatasetId: "y|z" };
  expect([a.fromColumn, a.toDatasetId].join("|")).toBe(
    [b.fromColumn, b.toDatasetId].join("|"),
  );
  expect(sourceLinkIdentity(a)).not.toBe(sourceLinkIdentity(b));
});
