import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  getAll,
  resource,
  transaction,
} from "../apps/api/src/store.js";
import {
  applyPartitionPrune,
  inputsFor,
} from "../apps/api/src/assistant/provider.js";
import { datasetTable } from "../packages/shared/src/index.js";

const scope = "w";

// Counts the reads that each cost a network round trip against HelixDB.
class CountingStore extends MemoryStore {
  gets = 0;
  batches: number[] = [];
  async get(s: string, id: string) {
    this.gets++;
    return super.get(s, id);
  }
  async getMany(s: string, ids: string[]) {
    this.batches.push(new Set(ids).size);
    return super.getMany(s, ids);
  }
  get roundTrips() {
    return this.gets + this.batches.length;
  }
}

async function seed(store: CountingStore, n: number, partitioned = false) {
  const datasets = new Map<string, ReturnType<typeof resource>>();
  const writes: ReturnType<typeof resource>[] = [];
  for (let i = 0; i < n; i++) {
    const ds = resource(
      scope,
      "dataset",
      "Table " + i,
      { activeVersion: "v" + i, profile: { columns: [] } },
      "d" + i,
    );
    datasets.set(ds.id, ds);
    writes.push(
      resource(
        scope,
        "version",
        "v" + i,
        partitioned
          ? {
              partitionColumn: "region",
              partitions: [
                { key: "EU", file: `p${i}/EU.parquet` },
                { key: "US", file: `p${i}/US.parquet` },
              ],
            }
          : { sourcePath: `t${i}.parquet`, sourceFingerprint: { size: i, mtimeMs: i } },
        "v" + i,
      ),
    );
  }
  await transaction(store, scope, async (tx) => {
    for (const r of writes) tx.put(r);
  });
  store.gets = 0;
  store.batches = [];
  return datasets;
}

describe("getAll", () => {
  it("reads in chunks, drops duplicates and omits missing ids", async () => {
    const store = new CountingStore();
    await seed(store, 3);
    const ids = ["v0", "v1", "v1", "nope", "v2"];
    const found = await getAll(store, scope, ids);
    expect([...found.keys()].sort()).toEqual(["v0", "v1", "v2"]);
    // One batch of the four distinct ids.
    expect(store.batches).toEqual([4]);
    expect(store.gets).toBe(0);
  });

  it("splits a large request instead of sending one oversized batch", async () => {
    const store = new CountingStore();
    const ids = Array.from({ length: 120 }, (_, i) => "x" + i);
    await getAll(store, scope, ids);
    expect(store.batches).toEqual([50, 50, 20]);
  });

  it("does nothing for an empty request", async () => {
    const store = new CountingStore();
    expect((await getAll(store, scope, [])).size).toBe(0);
    expect(store.roundTrips).toBe(0);
  });
});

describe("round trips", () => {
  it("builds the executor inputs for 30 datasets in one batched read", async () => {
    const store = new CountingStore();
    const datasets = await seed(store, 30);
    const inputs = await inputsFor(store, scope, [...datasets.keys()], datasets);
    expect(inputs).toHaveLength(30);
    // Was one get() per input (30 round trips).
    expect(store.gets).toBe(0);
    expect(store.batches).toEqual([30]);
    expect(inputs[7]).toMatchObject({
      table: datasetTable("d7"),
      version: "v7",
      sourcePath: "t7.parquet",
      sourceFingerprint: { size: 7, mtimeMs: 7 },
    });
  });

  it("still rejects an unknown dataset before reading anything", async () => {
    const store = new CountingStore();
    const datasets = await seed(store, 2);
    await expect(
      inputsFor(store, scope, ["d0", "missing"], datasets),
    ).rejects.toThrow(/Unknown dataset missing/);
    expect(store.roundTrips).toBe(0);
  });

  it("fetches every scoped partition manifest in one batched read", async () => {
    const store = new CountingStore();
    const datasets = await seed(store, 12, true);
    const inputs = [...datasets.values()].map((d) => ({
      table: datasetTable(d.id),
      version: d.data.activeVersion as string,
      files: [`p${d.id.slice(1)}/EU.parquet`, `p${d.id.slice(1)}/US.parquet`],
    }));
    const declared = Object.fromEntries(inputs.map((i) => [i.table, ["US"]]));
    const pruned = await applyPartitionPrune(inputs, declared, datasets, store, scope);
    expect(store.gets).toBe(0);
    expect(store.batches).toEqual([12]);
    expect(pruned[3].files).toEqual(["p3/US.parquet"]);
  });
});
