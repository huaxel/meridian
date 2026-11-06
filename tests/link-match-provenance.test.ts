import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SuggestedOntologyView } from "../apps/web/src/suggested-ontology.js";
import { matchText } from "../apps/web/src/link-match.js";
import { publishedOntology } from "../apps/web/src/areas/ontology/schema.js";
import { resource } from "../apps/api/src/store.js";
import {
  SuggestedLinkSchema,
  type SuggestedLink,
  type SuggestedOntology,
} from "../packages/shared/src/index.js";

const counts = { totalRows: 1000, matchedRows: 1000, caseInsensitive: true };

it("only displays numerical match coverage for explicitly measured counts", () => {
  expect(matchText({ ...counts, matchBasis: "measured" })).toBe(
    "Measured: 1,000 of 1,000 matched · matched ignoring case",
  );
  expect(matchText({ ...counts, matchBasis: "asserted" })).toBe(
    "Catalog assertion · coverage not measured",
  );
  expect(matchText(counts)).toBe("Coverage unverified");
  expect(matchText({ ...counts, matchBasis: "unverified" })).toBe(
    "Coverage unverified",
  );
});

function fixture() {
  const scope = "match-provenance",
    ids = ["a", "b"];
  const datasets = ids.map((id) => resource(scope, "dataset", id, {}, id));
  const types = ids.map((id) =>
    resource(
      scope,
      "objectType",
      id.toUpperCase(),
      {
        typeId: id,
        datasetId: id,
        primaryKey: "id",
        properties: ["id"],
      },
      id + "-type",
    ),
  );
  const link: SuggestedLink = {
    id: "suggested-link",
    name: "references",
    from: "a",
    to: "b",
    fromDatasetId: "a",
    fromColumn: "b_id",
    toDatasetId: "b",
    toColumn: "id",
    ...counts,
    evidence: "declared",
  };
  const confirmed: SuggestedOntology = {
    signature: "signature",
    hash: "hash",
    summary: "Two types",
    described: true,
    entities: ids.map((id) => ({
      id,
      name: id.toUpperCase(),
      description: "",
      kind: "record",
      anchorDatasetId: id,
      key: "id",
      rows: 1000,
      members: [
        {
          datasetId: id,
          datasetName: id,
          source: "Local",
          key: "id",
          rows: 1000,
          matched: 1000,
          via: null,
        },
      ],
      properties: ["id"],
    })),
    links: [link],
    notes: [],
    unplaced: [],
  };
  const relationships = [
    {
      name: "Published link",
      fromType: "A",
      toType: "B",
      fromDatasetId: "a",
      fromColumn: "b_id",
      toDatasetId: "b",
      toColumn: "id",
    },
  ];
  return { datasets, types, link, confirmed, relationships };
}

it.each(["measured", "asserted", "unverified", undefined] as const)(
  "preserves confirmed provenance only for an exact raw mapping (%s)",
  (matchBasis) => {
    const f = fixture();
    f.link.matchBasis = matchBasis;
    const view = publishedOntology(
      f.types,
      f.relationships,
      {},
      f.datasets,
      f.confirmed,
    );
    expect(view.links[0].matchBasis).toBe(matchBasis || "unverified");
    expect(view.links[0].matchedRows).toBe(1000);
  },
);

it.each(["measured", "asserted", undefined] as const)(
  "uses preview provenance without upgrading legacy counts (%s)",
  (matchBasis) => {
    const f = fixture();
    f.link.matchBasis = "measured";
    const view = publishedOntology(
      f.types,
      f.relationships,
      {
        "relation:Published link": {
          rows: [{ total: 100, matched: 20 }],
          matchBasis,
        },
      },
      f.datasets,
      f.confirmed,
    );
    expect(view.links[0].matchBasis).toBe(matchBasis || "unverified");
    expect(view.links[0].matchedRows).toBe(20);
    if (!matchBasis)
      expect(matchText(view.links[0])).toBe("Coverage unverified");
  },
);

it("does not borrow measured coverage or case mode from a different column mapping", () => {
  const f = fixture();
  f.link.matchBasis = "measured";
  f.relationships[0].fromColumn = "another_id";
  const view = publishedOntology(
    f.types,
    f.relationships,
    {},
    f.datasets,
    f.confirmed,
  );
  expect(view.links[0]).toMatchObject({
    matchBasis: "unverified",
    totalRows: 0,
    matchedRows: 0,
    caseInsensitive: false,
  });
  expect(matchText(view.links[0])).toBe("Coverage unverified");
});

it("does not borrow measured coverage from a different member dataset", () => {
  const f = fixture();
  f.link.matchBasis = "measured";
  f.relationships[0].fromDatasetId = "other-member";
  const view = publishedOntology(
    f.types,
    f.relationships,
    {},
    f.datasets,
    f.confirmed,
  );
  expect(view.links[0].matchBasis).toBe("unverified");
  expect(view.links[0].matchedRows).toBe(0);
});

it.each(["measured", "asserted", undefined] as const)(
  "renders provenance-aware tooltip text (%s)",
  (matchBasis) => {
    const f = fixture();
    f.link.matchBasis = matchBasis;
    vi.stubGlobal("window", { innerWidth: 1400, innerHeight: 1000 });
    try {
      const html = renderToStaticMarkup(
        createElement(SuggestedOntologyView, {
          ontology: f.confirmed,
          datasets: f.datasets,
          readOnly: true,
        }),
      );
      if (matchBasis === "measured")
        expect(html).toContain("Measured: 1,000 of 1,000 matched");
      else {
        expect(html).not.toContain("1,000 of 1,000");
        expect(html).toContain(
          matchBasis === "asserted"
            ? "Catalog assertion"
            : "Coverage unverified",
        );
      }
      expect(html).not.toContain("Declared as a foreign key");
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("does not present every unplaced dataset as proven keyless", () => {
  const f = fixture();
  f.confirmed.unplaced = ["unplaced"];
  f.datasets.push(resource("match-provenance", "dataset", "Unplaced table", {}, "unplaced"));
  vi.stubGlobal("window", { innerWidth: 1400, innerHeight: 1000 });
  try {
    const html = renderToStaticMarkup(
      createElement(SuggestedOntologyView, {
        ontology: f.confirmed,
        datasets: f.datasets,
      }),
    );
    expect(html).toContain("Unplaced datasets for analysis");
    expect(html).toContain("does not prove a dataset has no key");
    expect(html).not.toContain("Use keyless datasets for analysis");
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["declared", "name", "values"] as const)(
  "does not infer legacy measurement from evidence category (%s)",

  (evidence) => {
    const f = fixture();
    f.link.evidence = evidence;
    const parsed = SuggestedLinkSchema.parse(f.link);
    expect(parsed.matchBasis).toBeUndefined();
    expect(matchText(parsed)).toBe("Coverage unverified");
    expect(
      SuggestedLinkSchema.safeParse({ ...f.link, matchBasis: "fresh-proof" })
        .success,
    ).toBe(false);
  },
);
