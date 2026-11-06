import { expect, it } from "vitest";
import { omittedDefinitions } from "../apps/api/src/assistant/omission-reasons.js";
import {
  BundleSchema,
  type ValidationReport,
} from "../packages/shared/src/index.js";

const bundle = () =>
  BundleSchema.parse({
    summary: "Pruning diagnostics",
    assumptions: [],
    catalog: [],
    dashboards: [],
    pipelines: [{ name: "Transform", inputs: ["source"], sql: "SELECT 1" }],
    ontology: [
      {
        name: "Account",
        datasetId: "accounts",
        primaryKey: "id",
        properties: ["id"],
      },
      {
        name: "User",
        datasetId: "users",
        primaryKey: "id",
        properties: ["id"],
      },
    ],
    relationships: [
      {
        name: "belongs to",
        fromType: "User",
        toType: "Account",
        fromColumn: "account_id",
        toColumn: "id",
      },
    ],
    actions: [
      { name: "Edit account", objectType: "Account", fields: ["name"] },
    ],
  });
const report = (checks: ValidationReport["checks"]): ValidationReport => ({
  valid: false,
  checks,
  previews: {},
  inputVersions: {},
  validatedAt: "2026-10-17T00:00:00Z",
});

it("retains exact direct failures and names dependent relationship/action omissions", () => {
  const before = bundle(),
    after = bundle();
  after.pipelines = [];
  after.ontology = after.ontology.filter((t) => t.name !== "Account");
  after.relationships = [];
  after.actions = [];
  const validation = report([
    { name: "Pipeline: Transform", passed: false, detail: "Missing input" },
    {
      name: "Ontology: Account",
      passed: false,
      detail: "Primary key must be unique and non-null",
    },
    {
      name: "Relationship: belongs to",
      passed: false,
      detail: "Unknown relationship column",
    },
    {
      name: "Action: Edit account",
      passed: false,
      detail: "Invalid editable field",
    },
  ]);
  const original = structuredClone({ before, after, validation });
  expect(omittedDefinitions(before, after, validation)).toEqual([
    { kind: "pipeline", name: "Transform", reasons: ["Missing input"] },
    {
      kind: "objectType",
      name: "Account",
      reasons: ["Primary key must be unique and non-null"],
    },
    {
      kind: "relationship",
      name: "belongs to",
      reasons: [
        "Unknown relationship column",
        'Object type "Account" was omitted during validation pruning',
      ],
    },
    {
      kind: "action",
      name: "Edit account",
      reasons: [
        "Invalid editable field",
        'Object type "Account" was omitted during validation pruning',
      ],
    },
  ]);
  expect({ before, after, validation }).toEqual(original);
});

it("does not invent omissions for retained definitions or unrelated failed checks", () => {
  const before = bundle();
  expect(
    omittedDefinitions(
      before,
      structuredClone(before),
      report([
        {
          name: "Ontology: Account",
          passed: false,
          detail: "Still requires attention",
        },
        { name: "Dashboard: Revenue", passed: false, detail: "Widget failed" },
      ]),
    ),
  ).toEqual([]);
});

it("keeps a passing dependency check distinct from removal caused by its type", () => {
  const before = bundle(),
    after = bundle();
  after.ontology = after.ontology.filter((t) => t.name !== "Account");
  after.relationships = [];
  const omissions = omittedDefinitions(
    before,
    after,
    report([
      {
        name: "Ontology: Account",
        passed: false,
        detail: "Unknown property id",
      },
      {
        name: "Relationship: belongs to",
        passed: true,
        detail: "100/100 rows",
      },
    ]),
  );
  expect(omissions.find((o) => o.kind === "relationship")?.reasons).toEqual([
    'Object type "Account" was omitted during validation pruning',
  ]);
});

it("redacts credentials and bounds each retained failure message", () => {
  const before = bundle(),
    after = bundle();
  after.pipelines = [];
  const omissions = omittedDefinitions(
    before,
    after,
    report([
      {
        name: "Pipeline: Transform",
        passed: false,
        detail:
          "Connection postgres://user:secret@host/db password=secret " +
          "x".repeat(2000),
      },
    ]),
  );
  expect(omissions[0].reasons[0]).not.toContain("secret");
  expect(omissions[0].reasons[0]).toContain("[redacted]");
  expect(omissions[0].reasons[0].length).toBeLessThanOrEqual(1000);
});

it("explicitly marks absent failure detail rather than guessing a data problem", () => {
  const before = bundle(),
    after = bundle();
  after.pipelines = [];
  expect(omittedDefinitions(before, after, report([]))).toEqual([
    {
      kind: "pipeline",
      name: "Transform",
      reasons: [
        "Removed during confirmed-build validation pruning; no individual failure detail was retained",
      ],
    },
  ]);
});

it("keeps equal names in different asset kinds separate and deduplicates repeated reasons", () => {
  const before = bundle(),
    after = bundle();
  before.pipelines[0].name = "Account";
  after.pipelines = [];
  after.ontology = after.ontology.filter((t) => t.name !== "Account");
  const omissions = omittedDefinitions(
    before,
    after,
    report([
      { name: "Pipeline: Account", passed: false, detail: "Bad SQL" },
      { name: "Pipeline: Account", passed: false, detail: "Bad SQL" },
      { name: "Ontology: Account", passed: false, detail: "Bad key" },
    ]),
  );
  expect(omissions).toEqual([
    { kind: "pipeline", name: "Account", reasons: ["Bad SQL"] },
    { kind: "objectType", name: "Account", reasons: ["Bad key"] },
  ]);
});

it("records each pruning pass from its own pre-prune report, never a stale one", () => {
  const before = bundle();
  before.actions.push({
    name: "Delete account",
    objectType: "Account",
    fields: ["name"],
  });
  const firstReport = report([
    { name: "Action: Edit account", passed: false, detail: "Bad fields A" },
  ]);
  const afterFirst = structuredClone(before);
  afterFirst.actions = afterFirst.actions.filter(
    (a) => a.name !== "Edit account",
  );
  const first = omittedDefinitions(before, afterFirst, firstReport);
  expect(first).toEqual([
    { kind: "action", name: "Edit account", reasons: ["Bad fields A"] },
  ]);
  // The second pass revalidates after pruning: its report — not the first
  // pass's — decides the next omission's reason.
  const secondReport = report([
    { name: "Action: Delete account", passed: false, detail: "Bad fields B" },
  ]);
  const afterSecond = structuredClone(afterFirst);
  afterSecond.actions = [];
  const second = omittedDefinitions(afterFirst, afterSecond, secondReport);
  expect(second).toEqual([
    { kind: "action", name: "Delete account", reasons: ["Bad fields B"] },
  ]);
  for (const omission of [...first, ...second])
    for (const reason of omission.reasons)
      expect(reason).not.toContain("no individual failure detail was retained");
});
