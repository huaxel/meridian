import { expect, it } from "vitest";
import {
  resolveColumn,
  resolveSingleCatalogKey,
} from "../apps/api/src/catalog-match.js";

it.each([
  { key: "ID", columns: ["CUSTOMER_ID", "ORDER_ID"] },
  { key: "AB", columns: ["A-B", "A_B"] },
  {
    key: "TAXPAYER",
    columns: ["Taxpayer.return_z019", "Taxpayer.return_z018"],
  },
])(
  "rejects ambiguous physical matches for $key regardless of header order",
  ({ key, columns }) => {
    for (const names of [columns, [...columns].reverse()]) {
      expect(
        resolveColumn(
          names.map((name) => ({ name })),
          key,
        ),
      ).toBeUndefined();
    }
  },
);

it("prefers a literal case-insensitive column over normalized or suffix aliases", () => {
  const columns = ["A-B", "A_B", "Other_A_B"].map((name) => ({ name }));
  expect(resolveColumn(columns, "a_b")).toBe("A_B");
  expect(resolveColumn(columns, "A-B")).toBe("A-B");
});

it("continues resolving a unique localized or label-qualified source column", () => {
  expect(resolveColumn([{ name: "Partenaire_GPART" }], "GPART")).toBe(
    "Partenaire_GPART",
  );
  expect(resolveColumn([{ name: "Taxpayer.return_z019" }], "TAXPAYER")).toBe(
    "Taxpayer.return_z019",
  );
  expect(resolveColumn([{ name: "ID" }, { name: "ID" }], "ID")).toBe("ID");
});

it("uses the first resolvable single-column declaration, not a composite expression", () => {
  const columns = [{ name: "Label_ID" }, { name: "CODE" }];
  expect(
    resolveSingleCatalogKey(columns, [
      ["ID", "CODE"],
      ["missing"],
      ["ID"],
      ["CODE"],
    ]),
  ).toBe("Label_ID");
});

it("does not synthesize a physical identifier for composite or ambiguous declarations", () => {
  const columns = [{ name: "ORDER_ID" }, { name: "CUSTOMER_ID" }];
  expect(
    resolveSingleCatalogKey(columns, [["ORDER_ID", "CUSTOMER_ID"]]),
  ).toBeUndefined();
  expect(resolveSingleCatalogKey(columns, [["ID"]])).toBeUndefined();
  expect(resolveSingleCatalogKey(columns, undefined)).toBeUndefined();
});
