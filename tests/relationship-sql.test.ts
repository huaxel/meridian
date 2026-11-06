import { expect, it } from "vitest";
import { relationshipJoinCondition } from "../apps/api/src/relationship-sql.js";

const columns = [
  { name: "BELNR", type: "VARCHAR" },
  { name: "MANDT", type: "CHAR(3)" },
  { name: "OBJECTTYPE", type: "TEXT" },
  { name: "AMOUNT", type: "DECIMAL" },
];
const rel = (extra: Record<string, unknown> = {}) => ({
  name: "scoped link", fromType: "Item", toType: "Document",
  fromColumn: "BELNR", toColumn: "BELNR", ...extra,
}) as any;

it("uses every equality pair and an owning-side string predicate", () => {
  expect(relationshipJoinCondition(rel({
    additionalJoinPairs: [{ fromColumn: "MANDT", toColumn: "CLIENT" }],
    predicate: { side: "to", column: "OBJECTTYPE", op: "=", value: "O'Neil" },
    predicateBasis: "asserted",
  }), [...columns], [...columns, { name: "CLIENT", type: "VARCHAR" }])).toBe(
    'a."BELNR"=b."BELNR" AND a."MANDT"=b."CLIENT" AND b."OBJECTTYPE"=\'O\'\'Neil\'',
  );
});

it("rejects duplicate tuple components and non-text predicates", () => {
  expect(() => relationshipJoinCondition(rel({
    additionalJoinPairs: [{ fromColumn: "BELNR", toColumn: "YEAR" }],
  }), columns, [...columns, { name: "YEAR", type: "VARCHAR" }])).toThrow(/repeated/);
  expect(() => relationshipJoinCondition(rel({
    predicate: { side: "from", column: "AMOUNT", op: "=", value: "1" },
    predicateBasis: "confirmed",
  }), columns, columns)).toThrow(/scalar text/);
});
