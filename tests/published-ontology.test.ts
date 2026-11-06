import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { publishedOntology } from "../apps/web/src/areas/ontology/schema.js";
import { SuggestedOntologyView } from "../apps/web/src/suggested-ontology.js";
import { resource } from "../apps/api/src/store.js";
import type { SuggestedOntology } from "../packages/shared/src/index.js";

it("keeps unplaced tables and exact source columns in the published ontology", () => {
  const scope = "published-ontology-test";
  const datasets = [
    resource(scope, "dataset", "Accounts", {}, "accounts"),
    resource(scope, "dataset", "Users", {}, "users"),
    resource(scope, "dataset", "Account aliases", {}, "aliases"),
    resource(scope, "dataset", "Unkeyed table", {}, "unplaced"),
    resource(scope, "dataset", "Monthly totals", {}, "facts"),
  ];
  const types = [
    resource(
      scope,
      "objectType",
      "Account",
      {
        typeId: "account-type",
        datasetId: "accounts",
        primaryKey: "id",
        properties: ["id"],
        objectCount: 60,
      },
      "account-type",
    ),
    resource(
      scope,
      "objectType",
      "User",
      {
        typeId: "user-type",
        datasetId: "users",
        primaryKey: "id",
        properties: ["id"],
        objectCount: 120,
      },
      "user-type",
    ),
  ];
  const confirmed: SuggestedOntology = {
    signature: "signature",
    hash: "hash",
    summary: "Accounts and users",
    described: true,
    entities: [
      {
        id: "account-type",
        name: "Account",
        description: "An account",
        kind: "record",
        anchorDatasetId: "accounts",
        key: "id",
        rows: 60,
        members: [
          {
            datasetId: "accounts",
            datasetName: "Accounts",
            source: "Local",
            key: "id",
            rows: 60,
            matched: 60,
            via: null,
          },
          {
            datasetId: "aliases",
            datasetName: "Account aliases",
            source: "Local",
            key: "account_id",
            rows: 60,
            matched: 60,
            via: null,
          },
        ],
        properties: ["id"],
      },
      {
        id: "user-type",
        name: "User",
        description: "A user",
        kind: "record",
        anchorDatasetId: "users",
        key: "id",
        rows: 120,
        members: [
          {
            datasetId: "users",
            datasetName: "Users",
            source: "Local",
            key: "id",
            rows: 120,
            matched: 120,
            via: null,
          },
        ],
        properties: ["id"],
      },
    ],
    links: [
      {
        id: "user-account",
        name: "belongs to",
        from: "user-type",
        to: "account-type",
        fromDatasetId: "users",
        fromColumn: "account_id",
        toDatasetId: "aliases",
        toColumn: "account_id",
        totalRows: 120,
        matchedRows: 114,
        caseInsensitive: false,
        evidence: "declared",
      },
    ],
    notes: [],
    analyticalSources: [{
      datasetId: "facts",
      name: "Monthly totals",
      description: "Reviewed summary rows",
      role: "fact",
      grain: "one row per month",
      dimensions: ["month"],
      measures: ["amount"],
    }],
    unplaced: ["unplaced"],
  };
  const view = publishedOntology(
    types,
    [
      {
        name: "belongs to",
        fromType: "User",
        toType: "Account",
        fromColumn: "account_id",
        toColumn: "account_id",
        fromDatasetId: "users",
        toDatasetId: "aliases",
      },
    ],
    {},
    datasets,
    confirmed,
  );
  expect(view.entities.map((e) => e.name)).toEqual(["Account", "User"]);
  expect(view.unplaced).toEqual(["unplaced"]);
  expect(view.entities.some((entity) => entity.name === "Monthly totals")).toBe(false);
  expect(view.analyticalSources).toMatchObject([
    { name: "Monthly totals", role: "fact", grain: "one row per month" },
  ]);
  vi.stubGlobal("window", { innerWidth: 1400, innerHeight: 1000 });
  try {
    const html = renderToStaticMarkup(
      createElement(SuggestedOntologyView, {
        readOnly: true,
        ontology: view,
        datasets,
      }),
    );
    expect(html).toContain("Analytical sources · not record types");
    expect(html).toContain("Monthly totals");
    expect(html).toContain("no row-level identity, record pages, actions, or graph relationships");
  } finally {
    vi.unstubAllGlobals();
  }
  expect(view.links).toMatchObject([
    {
      name: "belongs to",
      fromDatasetId: "users",
      fromColumn: "account_id",
      toDatasetId: "aliases",
      toColumn: "account_id",
      totalRows: 120,
      matchedRows: 114,
      evidence: "declared",
    },
  ]);
});
