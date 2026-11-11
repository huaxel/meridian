import { describe, expect, it } from "vitest";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { pruneJobHistory } from "../apps/api/src/job-retention.js";

const scope = "w";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function job(
  id: string,
  data: Record<string, unknown>,
  daysAgo: number,
  finishedDaysAgo = daysAgo,
) {
  return {
    ...resource(scope, "job", id, data, id),
    createdAt: iso(daysAgo),
    updatedAt: iso(finishedDaysAgo),
  };
}
async function seed(store: MemoryStore, jobs: ReturnType<typeof job>[]) {
  await transaction(store, scope, async (tx) => {
    for (const j of jobs) tx.put(j);
  });
}
const ids = async (store: MemoryStore) =>
  (await store.list(scope, "job")).map((j) => j.id).sort();

describe("listPage count option", () => {
  it("returns the full match count by default and the page size when skipped", async () => {
    const store = new MemoryStore();
    await seed(
      store,
      ["a", "b", "c"].map((id) => job(id, { status: "queued" }, 1)),
    );
    const counted = await store.listPage(scope, "job", {
      status: "queued",
      limit: 2,
    });
    expect(counted.items).toHaveLength(2);
    expect(counted.total).toBe(3);
    const uncounted = await store.listPage(scope, "job", {
      status: "queued",
      limit: 2,
      count: false,
    });
    expect(uncounted.total).toBe(2);
  });
});

describe("Tx.listByStatus", () => {
  it("returns only the matching status and applies the transaction's own writes", async () => {
    const store = new MemoryStore();
    await seed(store, [
      job("q1", { status: "queued" }, 1),
      job("r1", { status: "running" }, 1),
      job("s1", { status: "succeeded" }, 1),
      job("f1", { status: "failed" }, 1),
    ]);
    await transaction(store, scope, async (tx) => {
      expect(
        (await tx.listByStatus("job", ["queued", "running"])).map((j) => j.id).sort(),
      ).toEqual(["q1", "r1"]);
      // Cancelling a queued job removes it; queueing a new one adds it.
      const q1 = (await tx.get("q1"))!;
      tx.update(q1, { ...q1.data, status: "canceled" });
      tx.put(job("q2", { status: "queued" }, 0));
      // Deleting removes it; a job that finished in this transaction drops out.
      tx.delete("r1");
      expect(
        (await tx.listByStatus("job", ["queued", "running"])).map((j) => j.id),
      ).toEqual(["q2"]);
    });
  });

  it("ignores writes of other kinds", async () => {
    const store = new MemoryStore();
    await transaction(store, scope, async (tx) => {
      tx.put(resource(scope, "source", "src", { status: "queued" }, "src"));
      expect(await tx.listByStatus("job", ["queued"])).toEqual([]);
    });
  });
});

describe("pruneJobHistory", () => {
  const run = (store: MemoryStore, extra = {}) =>
    pruneJobHistory(store, scope, { now: NOW, ...extra });

  it("removes old finished jobs but keeps the newest three per source", async () => {
    const store = new MemoryStore();
    const sync = (n: number, status: string) =>
      job(`sync-${n}`, { type: "sync", sourceId: "src", status }, n);
    await seed(
      store,
      Array.from({ length: 12 }, (_, i) => sync(i + 10, "succeeded")),
    );
    const removed = await run(store);
    expect(removed).toBe(9);
    // The three most recently created survive, even though all are over a week old.
    expect(await ids(store)).toEqual(["sync-10", "sync-11", "sync-12"]);
  });

  it("keeps anything recent, failed, queued or running", async () => {
    const store = new MemoryStore();
    const base = { type: "sync", sourceId: "src" };
    await seed(store, [
      // Newest three of the key are protected regardless of status.
      job("n1", { ...base, status: "succeeded" }, 1),
      job("n2", { ...base, status: "succeeded" }, 2),
      job("n3", { ...base, status: "succeeded" }, 3),
      // Beyond the newest three: only these old finished ones may go.
      job("recent", { ...base, status: "succeeded" }, 4),
      job("old-ok", { ...base, status: "succeeded" }, 20),
      job("old-canceled", { ...base, status: "canceled" }, 21),
      job("old-failed", { ...base, status: "failed" }, 22),
      job("old-running", { ...base, status: "running" }, 23),
      job("old-queued", { ...base, status: "queued" }, 24),
    ]);
    expect(await run(store)).toBe(2);
    expect(await ids(store)).toEqual(
      ["n1", "n2", "n3", "old-failed", "old-queued", "old-running", "recent"].sort(),
    );
  });

  it("never removes the only job of a source, however old", async () => {
    const store = new MemoryStore();
    await seed(store, [
      job("only", { type: "sync", sourceId: "idle-source", status: "succeeded" }, 400),
    ]);
    expect(await run(store)).toBe(0);
    expect(await ids(store)).toEqual(["only"]);
  });

  it("groups by type and source, so one history cannot crowd out another", async () => {
    const store = new MemoryStore();
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(job(`a${i}`, { type: "sync", sourceId: "A", status: "succeeded" }, 10 + i));
      jobs.push(job(`b${i}`, { type: "sync", sourceId: "B", status: "succeeded" }, 10 + i));
      jobs.push(job(`v${i}`, { type: "validate", status: "succeeded" }, 10 + i));
      jobs.push(job(`u${i}`, { type: "upload", datasetId: "D", status: "succeeded" }, 10 + i));
    }
    await seed(store, jobs);
    expect(await run(store)).toBe(8);
    // Three newest of each of the four histories remain.
    expect(await ids(store)).toHaveLength(12);
    for (const prefix of ["a", "b", "v", "u"])
      expect((await ids(store)).filter((i) => i.startsWith(prefix))).toEqual(
        [0, 1, 2].map((n) => `${prefix}${n}`),
      );
  });

  it("bounds one pass, then finishes on the next", async () => {
    const store = new MemoryStore();
    await seed(
      store,
      Array.from({ length: 13 }, (_, i) =>
        job(`j${i}`, { type: "sync", sourceId: "s", status: "succeeded" }, 10 + i),
      ),
    );
    expect(await run(store, { maxDeleted: 4 })).toBe(4);
    expect(await ids(store)).toHaveLength(9);
    expect(await run(store, { maxDeleted: 100 })).toBe(6);
    expect(await ids(store)).toHaveLength(3);
    expect(await run(store)).toBe(0);
  });

  it("leaves runs and other resources alone", async () => {
    const store = new MemoryStore();
    await transaction(store, scope, async (tx) => {
      tx.put({
        ...resource(scope, "run", "old-run", { status: "succeeded" }, "old-run"),
        createdAt: iso(100),
        updatedAt: iso(100),
      });
    });
    await seed(store, [
      ...Array.from({ length: 5 }, (_, i) =>
        job(`j${i}`, { type: "sync", sourceId: "s", status: "succeeded" }, 10 + i),
      ),
    ]);
    await run(store);
    expect((await store.list(scope, "run")).map((r) => r.id)).toEqual(["old-run"]);
  });
});
