import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { onboardingState } from "../apps/api/src/onboarding-state.js";
import { resolvedOntologyDigest } from "../apps/api/src/discovery/confirm.js";
import { ONTOLOGY_DISCOVERY_REVISION } from "../apps/api/src/discovery/revision.js";
import type { SuggestedOntology } from "../packages/shared/src/index.js";

let store: MemoryStore,
  app: Awaited<ReturnType<typeof createApp>>,
  scope: string;
const request = (path: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${scope}/onboarding${path}`,
    payload,
  });
const mutate = (fn: (m: any) => void) =>
  transaction(store, scope, async (tx) => {
    const w = (await tx.get("workspace"))!;
    fn((w.data.onboarding ||= {}));
    tx.update(w, w.data);
  });
const revise = () =>
  request("/build", { goal: "Revise the approved workspace" });

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw Error("Network prohibited");
    }),
  );
  store = new MemoryStore();
  app = await createApp(store);
  await app.ready();
  scope = (await app.inject({ method: "GET", url: "/api/v1/me" })).json()
    .workspaces[0].id;
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "provider",
        "Fixture",
        { settings: { provider: "local", model: "fixture" } },
        "provider",
      ),
    );
    for (const id of ["a", "b", "c"])
      tx.put(
        resource(
          scope,
          "dataset",
          id,
          {
            activeVersion: "v1",
            profile: {
              rows: 2,
              columns: ["id", "other_id"].map((name, i) => ({
                name,
                type: "VARCHAR",
                nulls: 0,
                distinct: 2,
                primaryKey: i === 0,
                examples: [],
                sensitive: false,
              })),
            },
          },
          id,
        ),
      );
  });
  const { signature } = await onboardingState(store, scope);
  const suggestion: SuggestedOntology = {
    signature,
    discoveryRevision: ONTOLOGY_DISCOVERY_REVISION,
    hash: "original-structure",
    summary: "Approved model",
    described: false,
    entities: ["a", "b", "c"].map((id) => ({
      // Generator order differs from Zod order; integrity checks must not reorder it.
      id,
      name: id.toUpperCase(),
      namedBy: "slug",
      description: "Original description",
      kind: "record",
      anchorDatasetId: id,
      key: "id",
      rows: 2,
      members: [
        {
          datasetId: id,
          datasetName: id,
          source: "Local",
          key: "id",
          rows: 2,
          matched: 2,
          via: null,
        },
      ],
      properties: ["id", "other_id"],
    })),
    links: [
      {
        id: "edge",
        name: "belongs to",
        from: "a",
        to: "b",
        fromDatasetId: "a",
        fromColumn: "id",
        toDatasetId: "b",
        toColumn: "id",
        totalRows: 2,
        matchedRows: 2,
        caseInsensitive: false,
        evidence: "values",
        matchBasis: "measured",
      },
    ],
    notes: [],
    unplaced: [],
  };
  await mutate((m) => {
    m.ontologySuggestion = suggestion;
  });
  const approved = await request("/ontology/confirm", {
    hash: suggestion.hash,
    excluded: ["c"],
    names: { a: " Customer " },
  });
  expect(approved.statusCode, approved.body).toBe(200);
});
afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await app.close();
  vi.unstubAllGlobals();
});

it("reconstructs unchanged compact approvals with exact edits and digest", async () => {
  const state = await onboardingState(store, scope);
  expect(state.ontologyConfirmed).toBe(true);
  const result = await revise();
  expect(result.statusCode, result.body).toBe(200);
  const run = result.json();
  expect(run.data.ontology.entities.map((e: any) => e.name)).toEqual([
    "Customer",
    "B",
  ]);
  expect(resolvedOntologyDigest(run.data.ontology)).toBe(run.data.ontologyHash);
  expect(
    (await store.get(scope, "workspace"))!.data.onboarding.ontology.value,
  ).toBeUndefined();
});

it.each(["text", "structure", "edits", "missing", "malformed", "signature"])(
  "requires reapproval after %s drift without queuing a revision",
  async (kind) => {
    const before = await store.list(scope, "run");
    await mutate((m) => {
      if (kind === "text") {
        m.ontologySuggestion.links[0].name = "pays";
        m.ontologySuggestion.described = true;
      }
      if (kind === "structure") {
        m.ontologySuggestion.hash = "replacement";
        m.ontologySuggestion.links[0].fromColumn = "other_id";
      }
      if (kind === "edits") m.ontology.edits.names.a = "Unapproved";
      if (kind === "missing") delete m.ontologySuggestion;
      if (kind === "malformed") m.ontologySuggestion.entities = null;
      if (kind === "signature") m.ontology.signature = "obsolete";
    });
    expect((await onboardingState(store, scope)).ontologyConfirmed).toBe(false);
    const result = await revise();
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().error).toMatch(/review.*confirm/i);
    expect(await store.list(scope, "run")).toEqual(before);
  },
);

it("accepts drift only after renewed explicit confirmation", async () => {
  const oldHash = (await store.get(scope, "workspace"))!.data.onboarding
    .ontology.hash;
  await mutate((m) => {
    m.ontologySuggestion.links[0].name = "pays";
  });
  expect((await revise()).statusCode).toBe(409);
  const approved = await request("/ontology/confirm", {
    hash: "original-structure",
    excluded: ["c"],
    names: { a: "Customer" },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  const result = await revise();
  expect(result.statusCode, result.body).toBe(200);
  const run = result.json();
  expect(run.data.ontology.links[0].name).toBe("pays");
  expect(run.data.ontologyHash).not.toBe(oldHash);
  expect(resolvedOntologyDigest(run.data.ontology)).toBe(run.data.ontologyHash);
});

it.each([false, true])(
  "verifies legacy frozen snapshots (tampered: %s)",
  async (tampered) => {
    const initial = (await store.list(scope, "run"))[0];
    await mutate((m) => {
      m.ontology.value = initial.data.ontology;
      delete m.ontologySuggestion;
      if (tampered) m.ontology.value.links[0].name = "Unapproved";
    });
    expect((await onboardingState(store, scope)).ontologyConfirmed).toBe(
      !tampered,
    );
    const result = await revise();
    expect(result.statusCode, result.body).toBe(tampered ? 409 : 200);
    if (!tampered)
      expect(resolvedOntologyDigest(result.json().data.ontology)).toBe(
        result.json().data.ontologyHash,
      );
  },
);
