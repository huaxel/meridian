import { it, expect, vi } from "vitest";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { startWorker } from "../apps/api/src/jobs.js";
import { seal } from "../apps/api/src/security.js";
const imports = vi.hoisted(() => ({
  count: 0,
  error: undefined as Error | undefined,
}));
vi.mock("../apps/api/src/connectors.js", () => ({
  importSource: async () => {
    imports.count++;
    if (imports.error) throw imports.error;
    return { file: "test.jsonl" };
  },
}));
vi.mock("../apps/api/src/datasets.js", () => ({
  ingestFile: async (
    _s: any,
    scope: string,
    name: string,
    _f: string,
    source: string,
    id: string,
    version: string,
  ) => resource(scope, "dataset", name, { activeVersion: version }, id),
  removeStagedInput: vi.fn(),
  queryDatasets: vi.fn(),
}));
it("coalesces scheduled imports with queued work and completes a durable job", async () => {
  const store = new MemoryStore(),
    scope = "jobs";
  await transaction(store, "global", async (tx) =>
    tx.put(resource("global", "workspaceRef", "Jobs", {}, scope)),
  );
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "source",
        "MySQL source",
        {
          kind: "mysql",
          secret: seal({ database: "fixture" }),
          schedule: "* * * * *",
          nextRun: 0,
        },
        "source",
      ),
    );
    tx.put(
      resource(
        scope,
        "job",
        "Manual import",
        { type: "sync", sourceId: "source", status: "queued" },
        "job",
      ),
    );
  });
  // The next run is the minute after the worker scheduled it, which the import
  // itself can cross.
  const started = Date.now();
  const stop = startWorker(store);
  try {
    for (
      let i = 0;
      i < 50 && (await store.get(scope, "job"))?.data.status !== "succeeded";
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    expect((await store.get(scope, "job"))?.data.status).toBe("succeeded");
    expect(imports.count).toBe(1);
    expect((await store.list(scope, "job")).length).toBe(1);
    expect((await store.get(scope, "source"))?.data.nextRun).toBeGreaterThan(
      started,
    );
  } finally {
    stop();
  }
});
it("recovers an interrupted import lease without creating another operation", async () => {
  const store = new MemoryStore(),
    scope = "recovery";
  await transaction(store, "global", async (tx) =>
    tx.put(resource("global", "workspaceRef", "Recovery", {}, scope)),
  );
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "source",
        "Orders",
        { kind: "mysql", secret: seal({ database: "fixture" }) },
        "source",
      ),
    );
    tx.put(
      resource(
        scope,
        "job",
        "Orders",
        {
          type: "sync",
          sourceId: "source",
          status: "running",
          leaseUntil: Date.now() - 1,
          attempts: 1,
        },
        "interrupted",
      ),
    );
  });
  const stop = startWorker(store);
  try {
    for (
      let i = 0;
      i < 60 &&
      (await store.get(scope, "interrupted"))?.data.status !== "succeeded";
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    expect((await store.get(scope, "interrupted"))?.data.status).toBe(
      "succeeded",
    );
    expect((await store.get(scope, "interrupted"))?.data.attempts).toBe(2);
    expect(await store.list(scope, "job")).toHaveLength(1);
  } finally {
    stop();
  }
});
it("fails an over-cap interrupted job without invoking its handler", async () => {
  imports.count = 0;
  imports.error = undefined;
  const store = new MemoryStore(),
    scope = "over-cap";
  await transaction(store, "global", async (tx) =>
    tx.put(resource("global", "workspaceRef", "Over cap", {}, scope)),
  );
  await transaction(store, scope, async (tx) =>
    tx.put(
      resource(
        scope,
        "job",
        "Poison job",
        {
          type: "sync",
          status: "running",
          leaseUntil: Date.now() - 1,
          attempts: 3,
        },
        "poison",
      ),
    ),
  );
  const stop = startWorker(store);
  try {
    for (
      let i = 0;
      i < 50 && (await store.get(scope, "poison"))?.data.status !== "failed";
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    const job = await store.get(scope, "poison"),
      findings = await store.list(scope, "finding");
    expect(job?.data.status).toBe("failed");
    expect(job?.data.attempts).toBe(3);
    expect(findings).toHaveLength(1);
    expect(imports.count).toBe(0);
  } finally {
    await stop();
  }
});
it("retries completion without re-running a successful handler", async () => {
  imports.count = 0;
  imports.error = undefined;
  const store = new MemoryStore(),
    scope = "completion-retry";
  await transaction(store, "global", async (tx) =>
    tx.put(resource("global", "workspaceRef", "Completion", {}, scope)),
  );
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "source",
        "Orders",
        { kind: "mysql", secret: seal({ database: "fixture" }) },
        "source",
      ),
    );
    tx.put(
      resource(
        scope,
        "job",
        "Orders",
        { type: "sync", sourceId: "source", status: "queued" },
        "completion",
      ),
    );
  });
  const commit = store.commit.bind(store);
  let completionFailure = true;
  vi.spyOn(store, "commit").mockImplementation(async (s, version, changes) => {
    if (
      completionFailure &&
      changes.some(
        (change) =>
          "put" in change &&
          change.put.id === "completion" &&
          change.put.data.status === "succeeded",
      )
    ) {
      completionFailure = false;
      throw new Error("forced completion conflict");
    }
    return commit(s, version, changes);
  });
  const stop = startWorker(store);
  try {
    for (
      let i = 0;
      i < 80 && (await store.get(scope, "completion"))?.data.status !== "succeeded";
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    const job = await store.get(scope, "completion");
    expect(job?.data.status).toBe("succeeded");
    expect(job?.data.attempts).toBe(1);
    expect(imports.count).toBe(1);
  } finally {
    await stop();
  }
});
it("requeues handler errors and fails on the third attempt", async () => {
  imports.count = 0;
  imports.error = new Error("fixture handler failure");
  const store = new MemoryStore(),
    scope = "handler-retry";
  await transaction(store, "global", async (tx) =>
    tx.put(resource("global", "workspaceRef", "Handler retry", {}, scope)),
  );
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "source",
        "Orders",
        { kind: "mysql", secret: seal({ database: "fixture" }) },
        "source",
      ),
    );
    tx.put(
      resource(
        scope,
        "job",
        "Orders",
        { type: "sync", sourceId: "source", status: "queued" },
        "handler-retry",
      ),
    );
  });
  const stop = startWorker(store);
  try {
    for (
      let i = 0;
      i < 180 && (await store.get(scope, "handler-retry"))?.data.status !== "failed";
      i++
    )
      await new Promise((r) => setTimeout(r, 100));
    const job = await store.get(scope, "handler-retry");
    expect(job?.data.status).toBe("failed");
    expect(job?.data.attempts).toBe(3);
    expect(imports.count).toBe(3);
    expect(await store.list(scope, "finding")).toHaveLength(1);
  } finally {
    imports.error = undefined;
    await stop();
  }
});
