import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const executor = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("This metadata-only test must not execute a data query");
  }),
);
vi.mock("../apps/api/src/executor.js", () => ({ execute: executor }));

import { ontologyBundle } from "../apps/api/src/discovery.js";
import { validateBundle } from "../apps/api/src/assistant/validate.js";
import { publishProposal } from "../apps/api/src/assistant/proposals.js";
import { proposalHash } from "../apps/api/src/assistant/provider.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import {
  BundleSchema,
  type Resource,
  type SuggestedOntology,
} from "../packages/shared/src/index.js";

async function fixture(viaKeys = false) {
  executor.mockClear();
  const store = new MemoryStore(),
    scope = "raw-member-" + randomUUID();
  const dataset = (id: string, names: string[]) =>
    resource(
      scope,
      "dataset",
      id,
      {
        activeVersion: id + "-version",
        profile: {
          rows: 2,
          columns: names.map((name, i) => ({
            name,
            type: "VARCHAR",
            nulls: 0,
            distinct: 2,
            examples: [],
            sensitive: false,
            primaryKey: i === 0,
          })),
        },
      },
      id,
    );
  const datasets = [
    dataset("anchor-a", ["anchor_id", "payload_fk"]),
    dataset("member-a", ["member_id", "owner_ref", "payload_fk"]),
    dataset("anchor-b", ["target_id", "code"]),
    dataset("member-b", ["member_id", "owner_ref", "code"]),
  ];
  const entity = (
    id: string,
    name: string,
    anchor: Resource,
    member: Resource,
    key: string,
  ) => ({
    id,
    name,
    description: name,
    kind: "record" as const,
    anchorDatasetId: anchor.id,
    key,
    rows: 2,
    members: [
      {
        datasetId: anchor.id,
        datasetName: anchor.name,
        source: "Local",
        key,
        rows: 2,
        matched: 2,
        via: null,
      },
      {
        datasetId: member.id,
        datasetName: member.name,
        source: "Local",
        key: "member_id",
        rows: 2,
        matched: 2,
        via: {
          column: "owner_ref",
          targetDatasetId: anchor.id,
          targetColumn: key,
        },
      },
    ],
    properties: [
      key,
      ...(anchor.data.profile.columns as { name: string }[])
        .slice(1)
        .map((c) => c.name),
    ],
  });
  const suggestion: SuggestedOntology = {
    signature: "signature",
    hash: "hash",
    summary: "Member links",
    described: true,
    entities: [
      entity("a", "A", datasets[0], datasets[1], "anchor_id"),
      entity("b", "B", datasets[2], datasets[3], "target_id"),
    ],
    links: [
      {
        id: "member-link",
        name: "references",
        from: "a",
        to: "b",
        fromDatasetId: "member-a",
        fromColumn: viaKeys ? "owner_ref" : "payload_fk",
        toDatasetId: "member-b",
        toColumn: viaKeys ? "owner_ref" : "code",
        totalRows: 2,
        matchedRows: 1,
        caseInsensitive: true,
        evidence: "declared",
      },
    ],
    notes: [],
    unplaced: [],
  };
  await transaction(store, scope, async (tx) => {
    tx.put(resource(scope, "workspace", "Members", {}, "workspace"));
    datasets.forEach((d) => tx.put(d));
  });
  await transaction(store, "global", async (tx) => {
    tx.put(
      resource(
        "global",
        "member",
        "Editor",
        { role: "editor" },
        `actor:${scope}`,
      ),
    );
  });
  const plan = ontologyBundle(
    suggestion,
    new Map(datasets.map((d) => [d.id, d])),
    { materializeMerges: false },
  );
  const bundle = BundleSchema.parse({ ...plan, dashboards: [], actions: [] });
  return { store, scope, datasets, suggestion, plan, bundle };
}

it.each([false, true])(
  "keeps literal raw member columns and evidence (via keys: %s)",
  async (viaKeys) => {
    const { store, scope, suggestion, plan, bundle } = await fixture(viaKeys);
    expect(plan.pipelines).toEqual([]);
    expect(plan.relationships).toEqual([
      {
        name: "references",
        fromType: "A",
        toType: "B",
        fromDatasetId: "member-a",
        toDatasetId: "member-b",
        fromColumn: viaKeys ? "owner_ref" : "payload_fk",
        toColumn: viaKeys ? "owner_ref" : "code",
      },
    ]);
    expect(plan.relationshipEvidence.get("references")).toEqual(
      suggestion.links[0],
    );
    // Types stay backed by their anchors, not silently rebound to member IDs.
    expect(bundle.ontology.map((t) => [t.datasetId, t.primaryKey])).toEqual([
      ["anchor-a", "anchor_id"],
      ["anchor-b", "target_id"],
    ]);
    const report = await validateBundle(store, scope, bundle, {
      relationshipEvidence: plan.relationshipEvidence,
    });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.inputVersions["member-a"]).toBe("member-a-version");
    expect(report.inputVersions["member-b"]).toBe("member-b-version");
    expect(executor).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "collapses duplicate saved source mappings (materialize: %s)",
  async (materializeMerges) => {
    const { suggestion, datasets } = await fixture();
    suggestion.links[0].caseInsensitive = false;
    suggestion.links.push({
      ...suggestion.links[0],
      id: "duplicate-member-link",
      name: "same mapping with a different label",
    });
    const plan = ontologyBundle(
      suggestion,
      new Map(datasets.map((d) => [d.id, d])),
      { materializeMerges },
    );
    expect(plan.relationships).toHaveLength(1);
    expect(plan.assumptions).toContain(
      'Omitted duplicate relationship suggestion "duplicate-member-link": same source mapping as "member-link".',
    );
    expect(plan.relationships[0].name).toBe("references");
    if (!materializeMerges)
      expect(plan.relationshipEvidence.get("references")).toEqual(
        suggestion.links[0],
      );
  },
);

it("preserves direction, columns, source dataset and comparison semantics during deduplication", async () => {
  const { store, scope, suggestion, datasets } = await fixture();
  const first = suggestion.links[0];
  suggestion.links.push(
    { ...first, id: "duplicate", name: "duplicate" },
    {
      ...first,
      id: "reverse",
      from: "b",
      to: "a",
      fromDatasetId: "member-b",
      fromColumn: "code",
      toDatasetId: "member-a",
      toColumn: "payload_fk",
    },
    { ...first, id: "other-column", fromColumn: "owner_ref" },
    { ...first, id: "other-dataset", fromDatasetId: "anchor-a" },
    { ...first, id: "case-sensitive", caseInsensitive: false },
  );
  const plan = ontologyBundle(
    suggestion,
    new Map(datasets.map((d) => [d.id, d])),
    { materializeMerges: false },
  );
  expect(plan.relationships).toHaveLength(5);
  expect(plan.relationshipEvidence.size).toBe(5);
  expect(
    new Set([...plan.relationshipEvidence.values()].map((l) => l.id)),
  ).toEqual(
    new Set([
      "member-link",
      "reverse",
      "other-column",
      "other-dataset",
      "case-sensitive",
    ]),
  );
  for (const rel of plan.relationships) {
    const evidence = plan.relationshipEvidence.get(rel.name)!;
    expect([
      rel.fromDatasetId,
      rel.fromColumn,
      rel.toDatasetId,
      rel.toColumn,
    ]).toEqual([
      evidence.fromDatasetId,
      evidence.fromColumn,
      evidence.toDatasetId,
      evidence.toColumn,
    ]);
  }
  const bundle = BundleSchema.parse({ ...plan, dashboards: [], actions: [] });
  const validation = await validateBundle(store, scope, bundle, {
    relationshipEvidence: plan.relationshipEvidence,
  });
  expect(validation.checks.filter((c) => !c.passed)).toEqual([]);
  expect(executor).not.toHaveBeenCalled();
});

it.each(["measured", "asserted", undefined] as const)(
  "labels saved count provenance without remeasuring (%s)",
  async (matchBasis) => {
    const { store, scope, suggestion, plan, bundle } = await fixture();
    Object.assign(suggestion.links[0], { matchBasis });
    const report = await validateBundle(store, scope, bundle, {
      relationshipEvidence: plan.relationshipEvidence,
    });
    expect(report.valid).toBe(true);
    const preview = report.previews["relation:references"] as {
      matchBasis?: string;
    };
    expect(preview.matchBasis).toBe(matchBasis || "unverified");
    const detail = report.checks.find(
      (c) => c.name === "Relationship: references",
    )!.detail;
    if (matchBasis === "measured")
      expect(detail).toContain("Saved measured counts");
    else {
      expect(detail).toContain("coverage not measured");
      expect(detail).not.toContain("source rows matched");
      expect(detail).not.toContain("1/2");
    }
    expect(executor).not.toHaveBeenCalled();
  },
);

it("does not admit a nonexistent raw column or a dataset outside its entity", async () => {
  const { suggestion, datasets } = await fixture();
  const map = new Map(datasets.map((d) => [d.id, d]));
  for (const change of [
    { fromColumn: "local_payload_fk" },
    { fromDatasetId: "member-b" },
  ]) {
    const invalid = structuredClone(suggestion);
    Object.assign(invalid.links[0], change);
    const plan = ontologyBundle(invalid, map, { materializeMerges: false });
    expect(plan.relationships).toEqual([]);
    expect(plan.relationshipEvidence.size).toBe(0);
  }
});

it("still resolves member via keys to merged output columns when materializing", async () => {
  const { suggestion, datasets } = await fixture(true);
  suggestion.links[0].caseInsensitive = false;
  const plan = ontologyBundle(
    suggestion,
    new Map(datasets.map((d) => [d.id, d])),
  );
  expect(plan.pipelines).toHaveLength(2);
  expect(plan.relationships).toEqual([
    {
      name: "references",
      fromType: "A",
      toType: "B",
      fromColumn: "anchor_id",
      toColumn: "target_id",
    },
  ]);
  expect(plan.relationshipEvidence.size).toBe(0);
});

it("keeps merged-output aliases for materialized member fields", async () => {
  const { suggestion, datasets } = await fixture();
  suggestion.links[0].caseInsensitive = false;
  const plan = ontologyBundle(
    suggestion,
    new Map(datasets.map((d) => [d.id, d])),
  );
  expect(plan.pipelines).toHaveLength(2);
  expect(plan.relationships).toEqual([
    {
      name: "references",
      fromType: "A",
      toType: "B",
      fromColumn: "local_payload_fk",
      toColumn: "local_code",
    },
  ]);
});

it.each(["from", "to", "both"] as const)(
  "rejects source-member previews without saved evidence (%s)",
  async (side) => {
    const { store, scope, bundle } = await fixture();
    const rel = bundle.relationships[0];
    if (side === "from") {
      rel.toDatasetId = "anchor-b";
      rel.toColumn = "code";
    } else if (side === "to") {
      rel.fromDatasetId = "anchor-a";
      rel.fromColumn = "payload_fk";
    }
    const report = await validateBundle(store, scope, bundle);
    expect(report.valid).toBe(false);
    expect(report.checks.filter((c) => !c.passed)).toEqual([
      expect.objectContaining({
        name: "Relationship: references",
        detail: expect.stringContaining("member-to-anchor identity mapping"),
      }),
    ]);
    expect(executor).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not stage anchor identities using raw member links (schema-only: %s)",
  async (schemaOnly) => {
    const { store, scope, plan, bundle } = await fixture();
    const validation = await validateBundle(store, scope, bundle, {
      relationshipEvidence: plan.relationshipEvidence,
    });
    expect(validation.valid).toBe(true);
    const proposal = resource(
      scope,
      "proposal",
      "Members",
      {
        bundle,
        validation,
        hash: proposalHash(bundle, validation),
        publicationMode: schemaOnly ? "schema-only" : "records",
        status: "ready",
      },
      "member-proposal",
    );
    await transaction(store, scope, async (tx) => tx.put(proposal));
    const publish = () =>
      publishProposal(
        store,
        scope,
        proposal.id,
        proposal.data.hash,
        "actor",
        "Reviewed",
        schemaOnly ? { stageRecords: false } : {},
      );
    if (schemaOnly) {
      const published = await publish();
      expect(published.data.bundle.relationships).toEqual(bundle.relationships);
      expect(
        (await store.list(scope, "objectType")).map((t) => t.data.datasetId),
      ).toEqual(["anchor-a", "anchor-b"]);
      expect(await store.list(scope, "publication")).toHaveLength(1);
    } else {
      await expect(publish()).rejects.toThrow(
        /member.*identity|identity.*member/i,
      );
      expect(await store.list(scope, "objectType")).toHaveLength(0);
      expect(await store.list(scope, "publication")).toHaveLength(0);
      expect(
        (await store.get(scope, "workspace"))?.data.activeGeneration,
      ).toBeUndefined();
      expect((await store.get(scope, proposal.id))?.data.status).toBe("ready");
    }
    expect(await store.list(scope, "object")).toHaveLength(0);
    expect(await store.list(scope, "relation")).toHaveLength(0);
    expect(executor).not.toHaveBeenCalled();
  },
);
