import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { resource } from "../apps/api/src/store.js";

vi.mock("../apps/web/src/ui.js", () => ({
  useWorkspace: () => ({ id: "scope", role: "editor", ask: () => {} }),
  useResources: () => ({ data: { items: [] } }),
  useAction: () => () => {},
  DataTable: () => null,
  Modal: () => null,
  Loading: () => null,
  Menu: () => null,
  fieldName: (s: string) => s,
}));
vi.mock("../apps/web/src/kit.js", () => ({
  PageHeader: () => null,
}));
vi.mock("../apps/web/src/api.js", () => ({ api: {} }));
vi.mock("../apps/web/src/paths.js", () => ({
  paths: { home: () => "/", proposals: () => "/" },
}));
import { ProposalReview } from "../apps/web/src/review.js";

const proposal = () =>
  resource("scope", "proposal", "Review", {
    status: "ready",
    bundle: {
      summary: "Customer model",
      assumptions: [
        'Omitted "Note" from the plan: it declares composite key (body + tag); schema-only publication is refused until a materialized build measures a surrogate identity.',
        'Omitted duplicate relationship suggestion "dup": same source mapping as "references".',
      ],
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
      relationships: [
        {
          name: "references",
          fromType: "Order",
          toType: "Customer",
          fromColumn: "CUST_ID",
          toColumn: "CUST_ID",
        },
      ],
      dashboards: [],
      actions: [],
    },
    validation: {
      valid: true,
      checks: [
        {
          name: "Ontology: Address",
          passed: true,
          detail:
            "2 objects; unique non-null key; 1 blank key value(s) present — record identity needs review",
        },
      ],
      previews: {},
      inputVersions: {},
      validatedAt: "now",
    },
  });

it("shows plan notes, blank warnings and links on the review page", () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ProposalReview, { proposal: proposal() }),
    ),
  );
  // Composite refusal + duplicate collapse reach the reviewer as assumptions.
  expect(html).toContain("Omitted &quot;Note&quot; from the plan");
  expect(html).toContain("composite key (body + tag)");
  expect(html).toContain("Omitted duplicate relationship suggestion");
  // The blank-key warning is a passing check detail, still visible.
  expect(html).toContain("blank key value(s) present");
  // Relationships under review are listed with endpoints.
  expect(html).toContain("Order → Customer");
});
