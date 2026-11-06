import { expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { resource } from "../apps/api/src/store.js";
import type {
  Resource,
  ValidationReport,
} from "../packages/shared/src/index.js";
import { PublicationValidation } from "../apps/web/src/areas/ontology/publication-validation.js";

const data = vi.hoisted(() => ({ items: {} as Record<string, Resource[]> }));
vi.mock("../apps/web/src/ui.js", () => ({
  useWorkspace: () => ({ role: "viewer" }),
  useResources: (kind: string) => ({ data: { items: data.items[kind] || [] } }),
  PageHeader: ({ children }: { children?: ReactNode }) =>
    createElement("header", null, children),
  Empty: () => null,
  Modal: () => null,
}));
vi.mock("../apps/web/src/object-action-form.js", () => ({
  default: () => null,
}));
vi.mock("../apps/web/src/areas/ontology/schema.js", () => ({
  PublishedSchema: ({ validation }: { validation?: ValidationReport }) =>
    createElement(PublicationValidation, { report: validation }),
}));
import { OntologyPage } from "../apps/web/src/graphs.js";

it.each([false, true])(
  "uses the matching published generation's history (retained: %s)",
  (retained) => {
    const scope = "omission-ui-wiring";
    const report = {
      valid: true,
      checks: [],
      previews: {},
      inputVersions: {},
      validatedAt: "now",
    };
    data.items = {
      objectType: [
        resource(
          scope,
          "objectType",
          "Active type",
          { generation: "current" },
          "type",
        ),
      ],
      dataset: [],
      proposal: [
        resource(
          scope,
          "proposal",
          "Old",
          {
            publishedGeneration: "old",
            bundle: { relationships: [] },
            validation: {
              ...report,
              omissions: [
                {
                  kind: "objectType",
                  name: "Stale omitted type",
                  reasons: ["Stale failure"],
                },
              ],
            },
          },
          "old-proposal",
        ),
        resource(
          scope,
          "proposal",
          "Current",
          {
            publishedGeneration: "current",
            bundle: { relationships: [] },
            validation: {
              ...report,
              ...(retained
                ? {
                    omissions: [
                      {
                        kind: "objectType",
                        name: "Current omitted type",
                        reasons: ["Current failure"],
                      },
                    ],
                  }
                : {}),
            },
          },
          "current-proposal",
        ),
      ],
    };
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(OntologyPage)),
    );
    expect(html).not.toContain("Stale omitted type");
    expect(html).not.toContain("Stale failure");
    if (retained) {
      expect(html).toContain("Current omitted type");
      expect(html).toContain("Current failure");
    } else {
      expect(html).toContain("Omission history is unavailable");
      expect(html).not.toContain("No definitions were removed");
    }
  },
);
