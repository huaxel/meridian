import { expect, it, vi } from "vitest";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { startWorker } from "../apps/api/src/jobs.js";
import { seal } from "../apps/api/src/security.js";

vi.mock("../apps/api/src/connectors.js", () => ({
  importSource: async () => ({ file: "test.jsonl" }),
}));
vi.mock("../apps/api/src/datasets.js", () => ({
  ingestFile: async (
    _s: any,
    scope: string,
    name: string,
    _f: string,
    _source: string,
    id: string,
    version: string,
  ) => resource(scope, "dataset", name, { activeVersion: version }, id),
  removeStagedInput: vi.fn(),
  queryDatasets: vi.fn(),
}));

// Records how many job rows each kind of read pulled out of the store. The
// test's own reads go through `quietly`, so only the worker is counted.
class ReadCountingStore extends MemoryStore {
  counting = false;
  jobRowsViaList = 0;
  pageCalls: { kind: string; count?: boolean }[] = [];
  async list(scope: string, kind?: string) {
    const rows = await super.list(scope, kind);
    if (this.counting && kind === "job") this.jobRowsViaList += rows.length;
    return rows;
  }
  async listPage(scope: string, kind: string, opts: any = {}) {
    if (this.counting) this.pageCalls.push({ kind, count: opts.count });
    return super.listPage(scope, kind, opts);
  }
  async quietly<T>(fn: () => Promise<T>): Promise<T> {
    const was = this.counting;
    this.counting = false;
    try {
      return await fn();
    } finally {
      this.counting = was;
    }
  }
}

it("schedules a due sync without loading the job history, and skips the unused counts", async () => {
  const store = new ReadCountingStore(),
    scope = "history";
  await transaction(store, "global", async (tx) =>
    tx.put(resource("global", "workspaceRef", "History", {}, scope)),
  );
  const HISTORY = 300;
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
    // A long, finished sync history for the same source.
    for (let i = 0; i < HISTORY; i++)
      tx.put(
        resource(
          scope,
          "job",
          "Sync " + i,
          { type: "sync", sourceId: "source", status: "succeeded" },
          "old-" + i,
        ),
      );
  });

  store.counting = true;
  const stop = startWorker(store);
  const finished = () =>
    store.quietly(async () =>
      (await store.list(scope, "job")).filter(
        (j) => j.data.status === "succeeded",
      ).length,
    );
  try {
    // The due source gets a fresh job, which the worker runs to completion.
    for (let i = 0; i < 80 && (await finished()) <= HISTORY; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await finished()).toBeGreaterThan(HISTORY);
  } finally {
    stop();
    store.counting = false;
  }
  // Was at least HISTORY rows: the scheduling transaction listed every job.
  expect(store.jobRowsViaList).toBeLessThan(HISTORY);
  // The worker's own queue reads never ask for a count.
  const worker = store.pageCalls.filter(
    (c) => c.kind === "job" || c.kind === "run",
  );
  expect(worker.length).toBeGreaterThan(0);
  expect(worker.every((c) => c.count === false)).toBe(true);
});
