import { expect, it } from "vitest";
import { ontologyBundle } from "../apps/api/src/discovery.js";
import { MemoryStore, resource } from "../apps/api/src/store.js";
import {
  BundleSchema,
  MAX_BUNDLE_PIPELINES,
  type Resource,
  type SuggestedOntology,
} from "../packages/shared/src/index.js";

const scope = "composite-promotion";

function dataset(id: string, columns: string[], rows = 4) {
  return resource(
    scope,
    "dataset",
    id,
    {
      activeVersion: id + "-version",
      profile: {
        rows,
        columns: columns.map((name) => ({
          name,
          type: "VARCHAR",
          nulls: 0,
          distinct: rows,
          examples: [],
          sensitive: false,
          // Fixtures declare "id" as the measured key, like a real profile does.
          primaryKey: name === "id",
        })),
      },
    },
    id,
  );
}

function member(d: Resource, via: null | { column: string; targetDatasetId: string; targetColumn: string }) {
  return {
    datasetId: d.id,
    datasetName: d.name,
    source: "Local",
    key: "id",
    rows: 4,
    matched: 4,
    via,
  };
}

// A composite identity on a single-member anchor: the default shape in a large
// workspace, where the merged members are never joined.
function composite(id: string, anchor: Resource, components: string[], members?: Resource[]) {
  return {
    id,
    name: id.toUpperCase(),
    description: id,
    kind: "record" as const,
    anchorDatasetId: anchor.id,
    key: components.join(" + "),
    keyKind: "composite" as const,
    compositeKey: components,
    rows: 4,
    members: [member(anchor, null), ...(members ?? []).map((m) => member(m, null))],
    properties: (anchor.data.profile.columns as { name: string }[]).map((c) => c.name),
  };
}

function suggestion(
  entities: SuggestedOntology["entities"],
  links: SuggestedOntology["links"] = [],
): SuggestedOntology {
  return {
    signature: "signature",
    hash: "hash",
    summary: "Composite identities",
    described: true,
    entities,
    links,
    notes: [],
    unplaced: [],
  };
}

const link = (
  id: string,
  from: string,
  to: string,
  fromDatasetId: string,
  fromColumn: string,
  toDatasetId: string,
  toColumn: string,
): SuggestedOntology["links"][number] => ({
  id,
  name: id,
  from,
  to,
  fromDatasetId,
  fromColumn,
  toDatasetId,
  toColumn,
  totalRows: 4,
  matchedRows: 3,
  caseInsensitive: false,
  evidence: "declared",
});

const plain = (id: string, anchor: Resource) => ({
  id,
  name: id.toUpperCase(),
  description: id,
  kind: "record" as const,
  anchorDatasetId: anchor.id,
  key: "id",
  rows: 4,
  members: [member(anchor, null)],
  properties: (anchor.data.profile.columns as { name: string }[]).map((c) => c.name),
});

it("drops composite identities in a schema-only plan unless they are promoted", () => {
  const anchor = dataset("orders", ["id", "company", "year", "customer_fk"]);
  const other = dataset("customers", ["id", "name"]);
  const o = suggestion(
    [composite("order", anchor, ["company", "year"]), plain("customer", other)],
    [link("places", "order", "customer", anchor.id, "customer_fk", other.id, "id")],
  );
  const datasets = new Map([anchor, other].map((d) => [d.id, d]));
  const dropped = ontologyBundle(o, datasets, { materializeMerges: false });
  expect(dropped.ontology.map((t) => t.name)).toEqual(["CUSTOMER"]);
  expect(dropped.pipelines).toHaveLength(0);
  expect(dropped.relationships).toHaveLength(0);
  expect(dropped.assumptions.join("\n")).toContain(
    "schema-only publication is refused until a materialized build measures a surrogate identity",
  );
});

it("promotes a composite identity from a key-only anchor projection", () => {
  const anchor = dataset("orders", ["id", "company", "year", "customer_fk", "amount"]);
  const other = dataset("customers", ["id", "name"]);
  const o = suggestion(
    [composite("order", anchor, ["company", "year"]), plain("customer", other)],
    [link("places", "order", "customer", anchor.id, "customer_fk", other.id, "id")],
  );
  const plan = ontologyBundle(o, new Map([anchor, other].map((d) => [d.id, d])), {
    materializeMerges: false,
    promoteCompositeIdentities: true,
  });
  expect(plan.pipelines).toHaveLength(1);
  const pipeline = plan.pipelines[0];
  // One input, no join, and only the key components plus the surrogate.
  expect(pipeline.inputs).toEqual([anchor.id]);
  expect(pipeline.sql).not.toMatch(/JOIN/i);
  expect(pipeline.sql).not.toContain("amount");
  expect(pipeline.sql).toMatch(/"company".*"year"/);
  expect(pipeline.sql).toContain('AS "composite_key"');
  expect(pipeline.checks[0].sql).toContain('"composite_key"');
  // The type is published on the measured surrogate, not the label.
  const type = plan.ontology.find((t) => t.name === "ORDER")!;
  expect(type.primaryKey).toBe("composite_key");
  expect(type.properties).toEqual(
    expect.arrayContaining(["composite_key", "company", "year"]),
  );
  expect(type.properties).not.toContain("amount");
  // Links keep their raw datasets and columns: promotion changes identity only.
  expect(plan.relationships).toEqual([
    expect.objectContaining({
      fromColumn: "customer_fk",
      toColumn: "id",
      fromDatasetId: anchor.id,
      toDatasetId: other.id,
    }),
  ]);
  expect(plan.relationshipEvidence.size).toBe(1);
  // The projection policy is visible to whoever reviews the plan.
  expect(plan.assumptions.join("\n")).toContain(
    "Promoted 1 composite identity from key-only projections",
  );
  expect(BundleSchema.parse({ ...plan, dashboards: [], actions: [] })).toBeTruthy();
});

it("keeps a non-anchor member out of the promoted output", () => {
  const anchor = dataset("orders", ["id", "company", "year"]);
  const memberTable = dataset("lines", ["id", "order_ref", "quantity"]);
  const o = suggestion([
    composite("order", anchor, ["company", "year"], [memberTable]),
  ]);
  const plan = ontologyBundle(o, new Map([anchor, memberTable].map((d) => [d.id, d])), {
    materializeMerges: false,
    promoteCompositeIdentities: true,
  });
  expect(plan.pipelines).toHaveLength(1);
  expect(plan.pipelines[0].inputs).toEqual([anchor.id]);
  expect(plan.pipelines[0].sql).not.toMatch(/JOIN/i);
  expect(plan.pipelines[0].sql).not.toContain("quantity");
});

it("refuses a composite whose components do not resolve on the anchor", () => {
  const anchor = dataset("orders", ["id", "company"]);
  const other = dataset("customers", ["id"]);
  const o = suggestion(
    [composite("order", anchor, ["company", "missing_component"]), plain("customer", other)],
    [link("places", "order", "customer", anchor.id, "company", other.id, "id")],
  );
  const plan = ontologyBundle(o, new Map([anchor, other].map((d) => [d.id, d])), {
    materializeMerges: false,
    promoteCompositeIdentities: true,
  });
  expect(plan.pipelines).toHaveLength(0);
  expect(plan.ontology.map((t) => t.name)).toEqual(["CUSTOMER"]);
  expect(plan.relationships).toHaveLength(0);
  expect(plan.assumptions.join("\n")).toContain(
    "its key components do not all resolve to anchor columns",
  );
});

it("spends the promoted-identity budget on the widest link coverage first", () => {
  const entities: SuggestedOntology["entities"] = [];
  const links: SuggestedOntology["links"] = [];
  const linkCount = MAX_BUNDLE_PIPELINES + 4;
  for (let i = 0; i <= linkCount; i++) {
    const table = dataset(`t${i}`, ["id", "a", "b", "other_fk"]);
    entities.push(composite(`e${i}`, table, ["a", "b"]));
  }
  // e0 carries every link, e1 one fewer, and so on: the tail is what the
  // budget cannot afford, not an arbitrary slice of the list.
  for (let i = 0; i < linkCount; i++)
    for (let j = 0; j <= linkCount - i - 1; j++)
      links.push(
        link(
          `l${i}-${j}`,
          `e${i}`,
          `e${j + 1}`,
          `t${i}`,
          "other_fk",
          `t${j + 1}`,
          "id",
        ),
      );
  const datasets = new Map(
    entities.map((e) => {
      const d = dataset(e.anchorDatasetId, ["id", "a", "b", "other_fk"]);
      return [d.id, d];
    }),
  );
  const plan = ontologyBundle(suggestion(entities, links), datasets, {
    materializeMerges: false,
    promoteCompositeIdentities: true,
  });
  expect(plan.pipelines).toHaveLength(MAX_BUNDLE_PIPELINES);
  const promoted = new Set(plan.ontology.map((t) => t.name));
  expect(promoted.has("E0")).toBe(true);
  expect(promoted.has(`E${linkCount}`)).toBe(false);
  expect(plan.assumptions.join("\n")).toContain(
    `the promoted-identity budget (${MAX_BUNDLE_PIPELINES}) is exhausted`,
  );
});

it("screens blank key components with a coalesce so an empty result cannot fail", () => {
  // sum() over an empty table is NULL, and "NULL = 0" is not true. A source that
  // is empty at validation time (it was profiled with rows, then replaced) must
  // not fail a check it vacuously passes. Anchors already empty at plan time are
  // omitted earlier; this guards the SQL itself.
  const anchor = dataset("orders", ["id", "company", "year"], 4);
  const plan = ontologyBundle(
    suggestion([composite("order", anchor, ["company", "year"])]),
    new Map([[anchor.id, anchor]]),
    { materializeMerges: false, promoteCompositeIdentities: true },
  );
  expect(plan.pipelines).toHaveLength(1);
  const blankCheck = plan.pipelines[0].checks.find((c) => /no blanks/.test(c.name))!;
  expect(blankCheck.sql).toMatch(/coalesce\(sum\(/i);
  expect(blankCheck.sql).toMatch(/,\s*0\)\s*=\s*0/i);
  expect(blankCheck.sql).not.toMatch(/SELECT sum\(/i);
});

it("omits a source that exported no rows without waiting for validation", () => {
  // Validation refuses any type anchored on a zero-row table, so a plan that
  // keeps one costs a full second pass over every pipeline before pruning it.
  // The omission is decided in the plan, with the same reason.
  const empty = dataset("eabp", ["id", "opbel", "vertrag"], 0);
  const live = dataset("op", ["id", "opbel"]);
  const o = suggestion(
    [composite("eabp", empty, ["opbel", "vertrag"]), plain("op", live)],
    [link("covers", "eabp", "op", empty.id, "opbel", live.id, "opbel")],
  );
  const plan = ontologyBundle(o, new Map([empty, live].map((d) => [d.id, d])), {
    materializeMerges: false,
    promoteCompositeIdentities: true,
  });
  expect(plan.ontology.map((t) => t.name)).toEqual(["OP"]);
  expect(plan.pipelines).toHaveLength(0);
  expect(plan.relationships).toHaveLength(0);
  const notes = plan.assumptions.join("\n");
  expect(notes).toContain('Omitted "EABP" from the plan: its source exported no rows');
  expect(notes).toContain('Omitted relationship suggestion "covers"');
});

it("keeps a source whose row count is unknown rather than zero", () => {
  // Unprofiled is not empty: treating a missing row count as zero would drop a
  // type whose data simply has not been measured yet.
  const unprofiled = dataset("pending", ["id", "a", "b"]);
  delete (unprofiled.data as any).profile.rows;
  const plan = ontologyBundle(
    suggestion([composite("pending", unprofiled, ["a", "b"])]),
    new Map([[unprofiled.id, unprofiled]]),
    { materializeMerges: false, promoteCompositeIdentities: true },
  );
  expect(plan.ontology.map((t) => t.name)).toEqual(["PENDING"]);
  expect(plan.pipelines).toHaveLength(1);
});

it("omits a type whose key is a business label, not a column", () => {
  // The suggestion calls this identity "CODE + LANG" but the source has no such
  // column: validation reported "Unknown property" and the build paid a second
  // pass over every pipeline to discover it.
  const anchor = dataset("streets", ["id", "SPRAS", "STREETCAD"], 100);
  const labelled = {
    ...plain("street", anchor),
    key: "CODE + LANG",
  };
  const plan = ontologyBundle(suggestion([labelled]), new Map([[anchor.id, anchor]]), {
    materializeMerges: false,
    promoteCompositeIdentities: true,
  });
  expect(plan.ontology).toHaveLength(0);
  expect(plan.assumptions.join("\n")).toContain('Omitted "STREET" from the plan');
});

it("omits a type whose key column is not unique on the source", () => {
  // The profile already measured this; publishing it only to have validation
  // prune it costs a full re-validation.
  const anchor = dataset("open_items", ["id", "OPBEL"], 50);
  const entity = { ...plain("item", anchor), key: "OPBEL", keyKind: "single" as const };
  const plan = ontologyBundle(suggestion([entity]), new Map([[anchor.id, anchor]]), {
    materializeMerges: false,
    promoteCompositeIdentities: true,
  });
  expect(plan.ontology).toHaveLength(0);
  expect(plan.assumptions.join("\n")).toContain('its key "OPBEL" is not unique and non-null');
});
