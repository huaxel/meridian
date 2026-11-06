import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  stat,
  rm,
  unlink,
  utimes,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const executor = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("Freshness checks must not query or reprofile source data");
  }),
);
vi.mock("../apps/api/src/executor.js", () => ({ execute: executor }));
import { config } from "../apps/api/src/config.js";
import * as connectors from "../apps/api/src/connectors.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { validateBundle } from "../apps/api/src/assistant/validate.js";
import { publishProposal } from "../apps/api/src/assistant/proposals.js";
import {
  BundleSchema,
  type SuggestedLink,
} from "../packages/shared/src/index.js";

const previousMount = config.localDataPath;
let root: string, mount: string, path: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meridian-publish-freshness-"));
  mount = join(root, "mount");
  await mkdir(mount);
  config.localDataPath = mount;
  path = join(mount, "source.parquet");
  // Only stat/realpath is needed: no Parquet parser ever opens this fixture.
  await writeFile(path, "PAR1metadata-only-fixturePAR1");
  executor.mockClear();
});
afterEach(async () => {
  config.localDataPath = previousMount;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const store = new MemoryStore(),
    scope = "freshness-" + randomUUID(),
    st = await stat(path);
  const fingerprint = { size: st.size, mtimeMs: st.mtimeMs };
  const ds = resource(
    scope,
    "dataset",
    "Mounted source",
    {
      activeVersion: "v1",
      sourcePath: "source.parquet",
      sourceFingerprint: fingerprint,
      profile: {
        rows: 2,
        columns: [
          {
            name: "id",
            type: "VARCHAR",
            nulls: 0,
            distinct: 2,
            examples: [],
            sensitive: false,
            primaryKey: true,
          },
        ],
      },
    },
    "local-source",
  );
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "workspace",
        "Freshness",
        { activeGeneration: "old-generation" },
        "workspace",
      ),
    );
    tx.put(ds);
    tx.put(
      resource(
        scope,
        "version",
        "Source version",
        {
          datasetId: ds.id,
          sourcePath: "source.parquet",
          sourceFingerprint: fingerprint,
        },
        "v1",
      ),
    );
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
  const bundle = BundleSchema.parse({
    summary: "Schema-only mounted source",
    assumptions: [],
    pipelines: [],
    catalog: [{ datasetId: ds.id, description: "Mounted table", tags: [] }],
    ontology: [
      { name: "Item", datasetId: ds.id, primaryKey: "id", properties: ["id"] },
    ],
    relationships: [
      {
        name: "references",
        fromType: "Item",
        toType: "Item",
        fromColumn: "id",
        toColumn: "id",
        fromDatasetId: ds.id,
        toDatasetId: ds.id,
      },
    ],
    dashboards: [],
    actions: [],
  });
  const evidence: SuggestedLink = {
    id: "link",
    name: "references",
    from: "item",
    to: "item",
    fromDatasetId: ds.id,
    fromColumn: "id",
    toDatasetId: ds.id,
    toColumn: "id",
    totalRows: 2,
    matchedRows: 2,
    caseInsensitive: false,
    evidence: "declared",
    matchBasis: "asserted",
  };
  const validate = () =>
    validateBundle(store, scope, bundle, {
      relationshipEvidence: new Map([["references", evidence]]),
    });
  const proposal = async () => {
    const validation = await validate();
    expect(validation.valid).toBe(true);
    const p = resource(
      scope,
      "proposal",
      "Freshness",
      { bundle, validation, status: "ready", hash: "hash" },
      "proposal",
    );
    await transaction(store, scope, async (tx) => tx.put(p));
    return p;
  };
  const publish = () =>
    publishProposal(store, scope, "proposal", "hash", "actor", "Published", {
      stageRecords: false,
    });
  return { store, scope, ds, bundle, fingerprint, validate, proposal, publish };
}

it("checks unchanged mounted evidence without data queries and caches within a validation pass", async () => {
  const f = await setup(),
    resolver = vi.spyOn(connectors, "resolveLocalParquet");
  const report = await f.validate();
  expect(report.valid).toBe(true);
  expect(resolver).toHaveBeenCalledTimes(1);
  expect(executor).not.toHaveBeenCalled();
});

it.each(["size", "mtime"] as const)(
  "rejects stale schema/evidence despite an unchanged activeVersion (%s)",
  async (change) => {
    const f = await setup();
    if (change === "size") await appendFile(path, "changed");
    else
      await utimes(path, new Date(), new Date(f.fingerprint.mtimeMs + 10000));
    const report = await f.validate();
    expect(report.valid).toBe(false);
    expect(report.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      "Catalog: local-source",
      "Ontology: Item",
      "Relationship: references",
    ]);
    expect(
      report.checks
        .filter((c) => !c.passed)
        .every((c) => /source changed/i.test(c.detail)),
    ).toBe(true);
    expect((await f.store.get(f.scope, f.ds.id))?.data.activeVersion).toBe(
      "v1",
    );
    expect((await f.store.get(f.scope, "v1"))?.data.sourceFingerprint).toEqual(
      f.fingerprint,
    );
    expect(executor).not.toHaveBeenCalled();
  },
);

it("rejects changed sources before any schema-only publication writes", async () => {
  const f = await setup();
  await f.proposal();
  await appendFile(path, "changed after validation");
  const commit = vi.spyOn(f.store, "commit");
  await expect(f.publish()).rejects.toThrow(/source changed/i);
  expect(commit).not.toHaveBeenCalled();
  expect((await f.store.get(f.scope, "workspace"))?.data.activeGeneration).toBe(
    "old-generation",
  );
  expect((await f.store.get(f.scope, "proposal"))?.data.status).toBe("ready");
  expect(await f.store.list(f.scope, "publication")).toHaveLength(0);
  expect(executor).not.toHaveBeenCalled();
});

it("rechecks mounted sources before activation after staging metadata chunks", async () => {
  const f = await setup();
  await f.proposal();
  const commit = f.store.commit.bind(f.store);
  let changed = false;
  vi.spyOn(f.store, "commit").mockImplementation(
    async (scope, version, changes) => {
      const result = await commit(scope, version, changes);
      if (
        result &&
        !changed &&
        changes.some((c) => "put" in c && c.put.kind === "objectType")
      ) {
        changed = true;
        await appendFile(path, "changed while metadata was staged");
      }
      return result;
    },
  );
  await expect(f.publish()).rejects.toThrow(/source changed/i);
  expect(changed).toBe(true);
  expect((await f.store.get(f.scope, "workspace"))?.data.activeGeneration).toBe(
    "old-generation",
  );
  expect(await f.store.list(f.scope, "publication")).toHaveLength(0);
  expect((await f.store.get(f.scope, "proposal"))?.data.status).toBe("ready");
  expect(executor).not.toHaveBeenCalled();
});

it("restats mounted inputs when generation activation retries after a conflict", async () => {
  const f = await setup();
  await f.proposal();
  const resolver = vi.spyOn(connectors, "resolveLocalParquet");
  const commit = f.store.commit.bind(f.store);
  let conflicted = false;
  vi.spyOn(f.store, "commit").mockImplementation(
    async (scope, version, changes) => {
      const activation = changes.some(
        (c) =>
          "put" in c &&
          c.put.kind === "workspace" &&
          c.put.data.activeGeneration !== "old-generation",
      );
      if (activation && !conflicted) {
        conflicted = true;
        await appendFile(path, "changed after first activation check");
        return false;
      }
      return commit(scope, version, changes);
    },
  );
  await expect(f.publish()).rejects.toThrow(/source changed/i);
  expect(conflicted).toBe(true);
  expect(resolver).toHaveBeenCalledTimes(3);
  expect((await f.store.get(f.scope, "workspace"))?.data.activeGeneration).toBe(
    "old-generation",
  );
  expect(await f.store.list(f.scope, "publication")).toHaveLength(0);
  expect(executor).not.toHaveBeenCalled();
});

it("publishes unchanged schema-only sources with fresh checks at both publication boundaries", async () => {
  const f = await setup();
  await f.proposal();
  const resolver = vi.spyOn(connectors, "resolveLocalParquet");
  const published = await f.publish();
  expect(published.data.status).toBe("published");
  expect(resolver).toHaveBeenCalledTimes(2);
  expect(await f.store.list(f.scope, "publication")).toHaveLength(1);
  expect(executor).not.toHaveBeenCalled();
});

it("uses authoritative version metadata even when dataset cache fields are absent", async () => {
  const f = await setup();
  await transaction(f.store, f.scope, async (tx) => {
    const d = (await tx.get(f.ds.id))!;
    tx.update(d, {
      ...d.data,
      sourcePath: undefined,
      sourceFingerprint: undefined,
    });
  });
  await appendFile(path, "changed");
  expect((await f.validate()).valid).toBe(false);
  expect(executor).not.toHaveBeenCalled();
});

it("does not treat pending mounted-source cache fields as the active snapshot", async () => {
  const f = await setup();
  await transaction(f.store, f.scope, async (tx) => {
    const v = (await tx.get("v1"))!;
    tx.update(v, { datasetId: f.ds.id, file: "v1.parquet" });
  });
  await unlink(path);
  expect((await f.validate()).valid).toBe(true);
  expect(executor).not.toHaveBeenCalled();
});

it.each([
  "missing-file",
  "missing-fingerprint",
  "missing-path",
  "invalid-fingerprint",
  "missing-version",
  "wrong-owner",
] as const)(
  "fails closed on unverifiable mounted metadata (%s)",
  async (fault) => {
    const f = await setup();
    if (fault === "missing-file") await unlink(path);
    else
      await transaction(f.store, f.scope, async (tx) => {
        if (fault === "missing-version") tx.delete("v1");
        else {
          const v = (await tx.get("v1"))!;
          const data = { ...v.data };
          if (fault === "wrong-owner") data.datasetId = "other-dataset";
          else if (fault === "missing-path") data.sourcePath = undefined;
          else if (fault === "invalid-fingerprint")
            data.sourceFingerprint = {
              size: f.fingerprint.size,
              mtimeMs: "invalid",
            };
          else data.sourceFingerprint = undefined;
          tx.update(v, data);
        }
      });
    const report = await f.validate();
    expect(report.valid).toBe(false);
    expect(
      report.checks.some(
        (c) => !c.passed && /source|version|fingerprint/i.test(c.detail),
      ),
    ).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  },
);

it("does not stat sources excluded from the authorized validation catalog", async () => {
  const f = await setup(),
    resolver = vi.spyOn(connectors, "resolveLocalParquet");
  const report = await validateBundle(f.store, f.scope, f.bundle, {
    allowedDatasetIds: [],
  });
  expect(report.valid).toBe(false);
  expect(resolver).not.toHaveBeenCalled();
  expect(executor).not.toHaveBeenCalled();
});

it("does not reuse fingerprint successes across separate validation passes", async () => {
  const f = await setup(),
    resolver = vi.spyOn(connectors, "resolveLocalParquet");
  expect((await f.validate()).valid).toBe(true);
  await appendFile(path, "changed between validations");
  expect((await f.validate()).valid).toBe(false);
  expect(resolver).toHaveBeenCalledTimes(2);
  expect(executor).not.toHaveBeenCalled();
});

it("reuses the canonical mount boundary and refuses symlink escapes", async () => {
  const f = await setup(),
    outside = join(root, "outside.parquet");
  await writeFile(outside, "PAR1outsidePAR1");
  await symlink(outside, join(mount, "escaped.parquet"));
  const st = await stat(outside);
  await transaction(f.store, f.scope, async (tx) => {
    const v = (await tx.get("v1"))!;
    tx.update(v, {
      ...v.data,
      sourcePath: "escaped.parquet",
      sourceFingerprint: { size: st.size, mtimeMs: st.mtimeMs },
    });
  });
  const report = await f.validate();
  expect(report.valid).toBe(false);
  expect(
    report.checks.some(
      (c) => !c.passed && c.detail.includes("within the local data path"),
    ),
  ).toBe(true);
  expect(executor).not.toHaveBeenCalled();
});
