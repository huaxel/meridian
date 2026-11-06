import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicationValidation } from "../apps/web/src/areas/ontology/publication-validation.js";
import type {
  ValidationOmission,
  ValidationReport,
} from "../packages/shared/src/index.js";

const report = (omissions?: ValidationOmission[]): ValidationReport => ({
  valid: true,
  checks: [],
  previews: {},
  inputVersions: {},
  validatedAt: "2026-10-17T00:00:00Z",
  ...(omissions === undefined ? {} : { omissions }),
});
const render = (value?: ValidationReport) =>
  renderToStaticMarkup(createElement(PublicationValidation, { report: value }));

it("explains legacy missing history without claiming zero omissions", () => {
  const html = render(report());
  expect(html).toContain("Passed for published definitions");
  expect(html).toContain("Omission history is unavailable");
  expect(html).toContain("does not establish completeness or business meaning");
  expect(html).not.toContain("No definitions were removed");
});

it("distinguishes an explicitly empty validation-pruning history", () => {
  const html = render(report([]));
  expect(html).toContain("No definitions were removed by validation pruning");
  expect(html).not.toContain("Omission history is unavailable");
  expect(html).not.toContain("<details");
});

it("shows all recorded omission kinds and exact retained reasons in a collapsed native disclosure", () => {
  const html = render(
    report([
      {
        kind: "objectType",
        name: "Subscription",
        reasons: ["Unknown property subscription_key"],
      },
      {
        kind: "relationship",
        name: "for subscription",
        reasons: [
          'Object type "Subscription" was omitted during validation pruning',
        ],
      },
      {
        kind: "pipeline",
        name: "Load subscriptions",
        reasons: ["Unknown input dataset"],
      },
      {
        kind: "action",
        name: "Edit subscription",
        reasons: ["Invalid editable field"],
      },
    ]),
  );
  expect(html).toContain("4 definitions omitted");
  expect(html).toContain("Object type: Subscription");
  expect(html).toContain("Relationship: for subscription");
  expect(html).toContain("Pipeline: Load subscriptions");
  expect(html).toContain("Action: Edit subscription");
  expect(html).toContain("Unknown property subscription_key");
  expect(html).toContain("was omitted during validation pruning");
  expect(html).toContain("<details>");
  expect(html).not.toContain("<details open");
  expect(html).toContain('aria-label="Omitted definition details"');
  expect(html).toContain('tabindex="0"');
});

it("escapes names and reasons as text rather than rendering stored markup", () => {
  const html = render(
    report([
      {
        kind: "objectType",
        name: "<script>bad</script>",
        reasons: ['<img src=x onerror="bad()">'],
      },
    ]),
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img");
  expect(html).toContain("1 definition omitted");
});

it("does not guess a reason for an archived omission with an empty reason list", () => {
  const html = render(
    report([{ kind: "objectType", name: "Legacy type", reasons: [] }]),
  );
  expect(html).toContain("No individual reason was retained");
  expect(html).not.toContain("Primary key");
});

it("does not label an absent validation report as passing", () => {
  const html = render();
  expect(html).toContain("Validation report unavailable");
  expect(html).not.toContain("Passed for published definitions");
});

it("keeps unresolved checks distinct from successful publication validation", () => {
  const html = render({ ...report([]), valid: false });
  expect(html).toContain("Validation has unresolved checks");
  expect(html).not.toContain("Passed for published definitions");
});
