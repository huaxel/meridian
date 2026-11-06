import { beforeEach, afterEach, expect, it, vi } from "vitest";
const executor = vi.hoisted(() =>
  vi.fn(async () => {
    throw Error("No data queries allowed");
  }),
);
vi.mock("../apps/api/src/executor.js", () => ({ execute: executor }));
import { createApp } from "../apps/api/src/app.js";
import { onboardingState } from "../apps/api/src/onboarding-state.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { validateBundle } from "../apps/api/src/assistant/validate.js";
import { publishProposal } from "../apps/api/src/assistant/proposals.js";
import { proposalHash } from "../apps/api/src/assistant/provider.js";
import {
  BundleSchema,
  type SuggestedLink,
  type Bundle,
} from "../packages/shared/src/index.js";
let store: MemoryStore,
  app: Awaited<ReturnType<typeof createApp>>,
  scope: string,
  actor: string;
const request = (
  method: "GET" | "POST" | "PUT",
  path: string,
  payload?: Record<string, unknown>,
) => app.inject({ method, url: `/api/v1/workspaces/${scope}${path}`, payload });
const bundle = () =>
  BundleSchema.parse({
    summary: "Schema-only model",
    assumptions: [],
    catalog: [],
    pipelines: [],
    ontology: ["a", "b"].map((id) => ({
      name: id.toUpperCase(),
      datasetId: id,
      primaryKey: "id",
      properties: ["id", "alt_id"],
    })),
    relationships: [
      {
        name: "references",
        fromType: "A",
        toType: "B",
        fromDatasetId: "member",
        fromColumn: "fk",
        toDatasetId: "b",
        toColumn: "id",
      },
    ],
    dashboards: [],
    actions: [],
  });
const evidence: SuggestedLink = {
  id: "edge",
  name: "references",
  from: "a",
  to: "b",
  fromDatasetId: "member",
  fromColumn: "fk",
  toDatasetId: "b",
  toColumn: "id",
  totalRows: 2,
  matchedRows: 2,
  caseInsensitive: false,
  evidence: "declared",
  matchBasis: "asserted",
};
async function proposal(
  mode: "records" | "schema-only" | undefined = "schema-only",
  trusted = true,
  analyticalDataset?: string,
) {
  const b = bundle();
  if (analyticalDataset) {
    b.analyticalSources = [{
      datasetId: analyticalDataset,
      name: "Monthly totals",
      description: "Reviewed analytical source",
      role: "other",
      dimensions: [],
      measures: [],
    }];
  }
  const validation = await validateBundle(
    store,
    scope,
    b,
    trusted
      ? { relationshipEvidence: new Map([["references", evidence]]) }
      : {},
  );
  const p = resource(scope, "proposal", "Schema-only", {
    bundle: b,
    validation,
    status: validation.valid ? "ready" : "draft",
    hash: proposalHash(b, validation),
    ...(mode ? { publicationMode: mode } : {}),
  });
  await transaction(store, scope, async (tx) => {
    tx.put(p);
  });
  return p;
}
const publish = (p: any) =>
  request("POST", `/proposals/${p.id}/publish`, { hash: p.data.hash });
beforeEach(async () => {
  executor.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw Error("Network prohibited");
    }),
  );
  store = new MemoryStore();
  app = await createApp(store);
  await app.ready();
  const me = (await app.inject({ method: "GET", url: "/api/v1/me" })).json();
  scope = me.workspaces[0].id;
  actor = me.user.id;
  await transaction(store, scope, async (tx) => {
    for (const id of ["a", "b", "c", "member"])
      tx.put(
        resource(
          scope,
          "dataset",
          id,
          {
            activeVersion: "v1",
            profile: {
              rows: 2,
              columns: ["id", "alt_id", "fk"].map((name) => ({
                name,
                type: "VARCHAR",
                nulls: 0,
                distinct: 2,
                primaryKey: name !== "fk",
                examples: [],
                sensitive: false,
              })),
            },
          },
          id,
        ),
      );
  });
});
afterEach(async () => {
  expect(executor).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("round-trips through ordinary revalidation and publication", async () => {
  const p = await proposal();
  const r = await request("POST", `/proposals/${p.id}/validate`);
  expect(r.statusCode, r.body).toBe(200);
  const child = r.json();
  expect(child.data).toMatchObject({
    status: "ready",
    publicationMode: "schema-only",
  });
  expect(child.data.validation.previews["relation:references"]).toMatchObject({
    matchBasis: "asserted",
    evidence: "declared",
    rows: [{ total: 2, matched: 2 }],
  });
  const published = await publish(child);
  expect(published.statusCode, published.body).toBe(200);
  expect(published.json().data.publicationMode).toBe("schema-only");
  expect(await store.list(scope, "objectType")).toHaveLength(2);
  expect(await store.list(scope, "object")).toHaveLength(0);
  expect(await store.list(scope, "relation")).toHaveLength(0);
  expect((await store.list(scope, "publication"))[0].data.publicationMode).toBe(
    "schema-only",
  );
});
it("publishes a ready schema-only proposal through the normal route", async () => {
  const p = await proposal();
  const r = await publish(p);
  expect(r.statusCode, r.body).toBe(200);
});
it("rolls back definitions by revalidating and publishing a schema-only child", async () => {
  const first = await proposal();
  expect((await publish(first)).statusCode).toBe(200);
  const second = await proposal();
  expect((await publish(second)).statusCode).toBe(200);
  const r = await request("POST", "/rollback");
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data).toMatchObject({
    parentId: first.id,
    status: "published",
    publicationMode: "schema-only",
  });
  expect(await store.list(scope, "publication")).toHaveLength(3);
  expect(await store.list(scope, "object")).toHaveLength(0);
  expect(await store.list(scope, "relation")).toHaveLength(0);
});
it("rolls back analytical sources with the active schema-only generation", async () => {
  const first = await proposal("schema-only", true, "c");
  expect((await publish(first)).statusCode).toBe(200);
  let listed = await request("GET", "/resources/analyticalSource");
  expect(listed.statusCode, listed.body).toBe(200);
  expect(listed.json().items.map((source: any) => source.name)).toEqual(["Monthly totals"]);

  const second = await proposal();
  expect((await publish(second)).statusCode).toBe(200);
  listed = await request("GET", "/resources/analyticalSource");
  expect(listed.statusCode).toBe(200);
  expect(listed.json().items).toEqual([]);

  const rolledBack = await request("POST", "/rollback");
  expect(rolledBack.statusCode, rolledBack.body).toBe(200);
  expect(rolledBack.json().data).toMatchObject({
    parentId: first.id,
    status: "published",
    publicationMode: "schema-only",
  });
  listed = await request("GET", "/resources/analyticalSource");
  expect(listed.statusCode).toBe(200);
  expect(listed.json().items.map((source: any) => source.name)).toEqual(["Monthly totals"]);
  expect(await store.list(scope, "object")).toHaveLength(0);
  expect(await store.list(scope, "relation")).toHaveLength(0);
});

it("preserves safe text edits and ignores client mode/evidence/counter injection", async () => {
  const p = await proposal();
  const b = bundle();
  b.summary = "Edited description";
  const r = await request("PUT", `/proposals/${p.id}`, {
    ...b,
    publicationMode: "records",
    validation: {
      valid: true,
      previews: {
        "relation:references": { rows: [{ total: 999, matched: 999 }] },
      },
    },
    relationshipEvidence: [{ ...evidence, totalRows: 999 }],
  });
  expect(r.statusCode, r.body).toBe(200);
  const child = r.json();
  expect(child.data).toMatchObject({
    publicationMode: "schema-only",
    status: "ready",
  });
  expect(child.data.validation.previews["relation:references"].rows[0]).toEqual(
    { total: 2, matched: 2 },
  );
  expect((await publish(child)).statusCode).toBe(200);
});
it.each(["column", "source", "type-source", "key", "name"])(
  "does not reuse evidence after changing %s",
  async (change) => {
    const p = await proposal();
    const b: Bundle = bundle();
    if (change === "column") b.relationships[0].fromColumn = "alt_id";
    if (change === "source") {
      b.relationships[0].fromDatasetId = "a";
      b.relationships[0].fromColumn = "fk";
    }
    if (change === "type-source") b.ontology[0].datasetId = "c";
    if (change === "key") b.ontology[0].primaryKey = "alt_id";
    if (change === "name") b.relationships[0].name = "Changed meaning";
    const r = await request("PUT", `/proposals/${p.id}`, { ...b });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data.status).toBe("draft");
    expect(r.json().data.validation.checks).toContainEqual(
      expect.objectContaining({
        passed: false,
        detail: expect.stringContaining("Saved relationship evidence"),
      }),
    );
    expect((await publish(r.json())).statusCode).toBe(400);
  },
);
it("invalidates evidence on input-version changes without scanning or activating", async () => {
  const p = await proposal();
  await transaction(store, scope, async (tx) => {
    const d = (await tx.get("member"))!;
    tx.update(d, { ...d.data, activeVersion: "v2" });
  });
  const r = await request("POST", `/proposals/${p.id}/validate`);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data.status).toBe("draft");
  expect((await publish(p)).statusCode).toBe(409);
  expect(
    (await store.get(scope, "workspace"))!.data.activeGeneration,
  ).toBeNull();
});
it("cannot forge a schema-only grant or saved evidence on an ordinary proposal", async () => {
  const p = await proposal("records", false);
  const r = await request("PUT", `/proposals/${p.id}`, {
    ...bundle(),
    publicationMode: "schema-only",
    relationshipEvidence: [evidence],
    validation: { valid: true },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data).toMatchObject({
    status: "draft",
    publicationMode: "records",
  });
  expect((await publish(r.json())).statusCode).toBe(400);
});
it("recovers compatible evidence for legacy raw-member proposals with no mode marker", async () => {
  const p = await proposal(undefined);
  delete p.data.publicationMode;
  await transaction(store, scope, async (tx) => {
    tx.put(p);
  });
  const r = await request("POST", `/proposals/${p.id}/validate`);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data).toMatchObject({
    status: "ready",
    publicationMode: "schema-only",
  });
  expect((await publish(r.json())).statusCode).toBe(200);
});
it("refuses explicit record staging for a schema-only proposal", async () => {
  const p = await proposal();
  await expect(
    publishProposal(store, scope, p.id, p.data.hash, actor, "Test", {
      stageRecords: true,
    }),
  ).rejects.toThrow(/schema-only.*stage records/i);
  expect(await store.list(scope, "publication")).toHaveLength(0);
});

it("does not activate a rollback after its saved inputs change", async () => {
  const first = await proposal();
  expect((await publish(first)).statusCode).toBe(200);
  const second = await proposal();
  expect((await publish(second)).statusCode).toBe(200);
  const active = (await store.get(scope, "workspace"))!.data.activeGeneration;
  await transaction(store, scope, async (tx) => {
    const d = (await tx.get("member"))!;
    tx.update(d, { ...d.data, activeVersion: "v2" });
  });
  const r = await request("POST", "/rollback");
  expect(r.statusCode, r.body).toBe(409);
  expect((await store.get(scope, "workspace"))!.data.activeGeneration).toBe(
    active,
  );
  expect(await store.list(scope, "publication")).toHaveLength(2);
});
it.each(["missing", "negative", "excess"])(
  "fails closed on %s saved counters without a scan",
  async (fault) => {
    const p = await proposal();
    await transaction(store, scope, async (tx) => {
      const old = (await tx.get(p.id))!;
      const preview = old.data.validation.previews["relation:references"];
      if (fault === "missing")
        delete old.data.validation.previews["relation:references"];
      if (fault === "negative") preview.rows[0].matched = -1;
      if (fault === "excess") preview.rows[0].matched = 3;
      tx.update(old, old.data);
    });
    const r = await request("POST", `/proposals/${p.id}/validate`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data.status).toBe("draft");
    expect((await publish(p)).statusCode).toBe(409);
    expect(await store.list(scope, "publication")).toHaveLength(0);
  },
);
it("does not promote legacy unverified coverage to measured", async () => {
  const p = await proposal();
  await transaction(store, scope, async (tx) => {
    const old = (await tx.get(p.id))!;
    delete old.data.validation.previews["relation:references"].matchBasis;
    tx.update(old, old.data);
  });
  const r = await request("POST", `/proposals/${p.id}/validate`);
  expect(r.statusCode, r.body).toBe(200);
  expect(
    r.json().data.validation.previews["relation:references"].matchBasis,
  ).toBe("unverified");
});
it("rechecks publication mode at generation activation", async () => {
  const p = await proposal();
  const commit = store.commit.bind(store);
  let changed = false;
  vi.spyOn(store, "commit").mockImplementation(async (s, version, changes) => {
    const result = await commit(s, version, changes);
    if (
      result &&
      !changed &&
      changes.some((c) => "put" in c && c.put.kind === "objectType")
    ) {
      changed = true;
      await transaction(store, scope, async (tx) => {
        const old = (await tx.get(p.id))!;
        tx.update(old, { ...old.data, publicationMode: "records" });
      });
    }
    return result;
  });
  const r = await publish(p);
  expect(r.statusCode, r.body).toBe(409);
  expect(changed).toBe(true);
  expect(await store.list(scope, "publication")).toHaveLength(0);
  expect(
    (await store.get(scope, "workspace"))!.data.activeGeneration,
  ).toBeNull();
});

it("does not guess record staging for an ambiguous legacy anchor-only publication", async () => {
  const b = bundle();
  b.relationships = [];
  const validation = await validateBundle(store, scope, b);
  const old = resource(scope, "proposal", "Legacy", {
    bundle: b,
    validation,
    hash: proposalHash(b, validation),
    status: "published",
    publishedGeneration: "legacy",
  });
  await transaction(store, scope, async (tx) => {
    tx.put(old);
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      activeGeneration: "current",
      previousGeneration: "legacy",
    });
  });
  const r = await request("POST", "/rollback");
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json().error).toMatch(/legacy publication mode.*rebuild/i);
  expect((await store.get(scope, "workspace"))!.data.activeGeneration).toBe(
    "current",
  );
});

async function setupOrigin(
  p: Awaited<ReturnType<typeof proposal>>,
  runId: string,
) {
  await transaction(store, scope, async (tx) => {
    if (!(await tx.get("provider")))
      tx.put(
        resource(
          scope,
          "provider",
          "Fixture",
          { settings: { provider: "local", model: "fixture" } },
          "provider",
        ),
      );
  });
  const state = await onboardingState(store, scope);
  expect(state.inputsReady).toBe(true);
  p.data.onboardingSignature = state.signature;
  p.data.onboardingRunId = runId;
  await transaction(store, scope, async (tx) => {
    tx.put(p);
    tx.put(
      resource(
        scope,
        "run",
        runId,
        {
          task: "onboarding_build",
          status: "running",
          events: [],
          proposalId: p.id,
        },
        runId,
      ),
    );
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      onboarding: { ...w.data.onboarding, buildRunId: runId, goal: runId },
    });
  });
}
async function supersedeSetup() {
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "run",
        "New setup",
        { task: "onboarding_build", status: "queued", events: [] },
        "new-setup",
      ),
    );
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      onboarding: {
        ...w.data.onboarding,
        buildRunId: "new-setup",
        goal: "A different outcome",
      },
    });
  });
}
it("rolls back between onboarding-origin generations without retargeting either completed run", async () => {
  const first = await proposal();
  await setupOrigin(first, "setup-first");
  expect((await publish(first)).statusCode).toBe(200);
  const second = await proposal();
  await setupOrigin(second, "setup-second");
  expect((await publish(second)).statusCode).toBe(200);
  const oldRun = await store.get(scope, "setup-first"),
    latestRun = await store.get(scope, "setup-second");
  const r = await request("POST", "/rollback");
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data.onboardingSignature).toBeUndefined();
  expect(r.json().data.parentId).toBe(first.id);
  expect(await store.get(scope, "setup-first")).toEqual(oldRun);
  expect(await store.get(scope, "setup-second")).toEqual(latestRun);
});
it("reviews a published setup model independently of a new pending setup outcome", async () => {
  const p = await proposal();
  await setupOrigin(p, "setup-done");
  expect((await publish(p)).statusCode).toBe(200);
  const completed = await store.get(scope, "setup-done");
  await supersedeSetup();
  const pending = await store.get(scope, "new-setup");
  const r = await request("POST", `/proposals/${p.id}/validate`);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data.onboardingRunId).toBeUndefined();
  const published = await publish(r.json());
  expect(published.statusCode, published.body).toBe(200);
  expect(await store.get(scope, "setup-done")).toEqual(completed);
  expect(await store.get(scope, "new-setup")).toEqual(pending);
});
it.each([false, true])(
  "keeps unpublished setup candidate guards (superseded: %s)",
  async (superseded) => {
    const p = await proposal();
    await setupOrigin(p, "setup-pending");
    if (superseded) await supersedeSetup();
    const r = await request("POST", `/proposals/${p.id}/validate`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data.onboardingRunId).toBe("setup-pending");
    const published = await publish(r.json());
    expect(published.statusCode, published.body).toBe(superseded ? 409 : 200);
    if (superseded)
      expect(await store.list(scope, "publication")).toHaveLength(0);
    else
      expect((await store.get(scope, "setup-pending"))!.data).toMatchObject({
        status: "succeeded",
        proposalId: r.json().id,
      });
  },
);
it("does not retarget a completed general assistant run when its published model is edited", async () => {
  const p = await proposal();
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "run",
        "General assistant",
        { status: "awaiting_review", events: [], proposalId: p.id },
        "assistant-run",
      ),
    );
  });
  expect((await publish(p)).statusCode).toBe(200);
  const completed = await store.get(scope, "assistant-run");
  const b = bundle();
  b.summary = "Edited after publication";
  const r = await request("PUT", `/proposals/${p.id}`, { ...b });
  expect(r.statusCode, r.body).toBe(200);
  expect((await publish(r.json())).statusCode).toBe(200);
  expect(await store.get(scope, "assistant-run")).toEqual(completed);
});
