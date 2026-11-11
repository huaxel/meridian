import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { execute } from "../services/executor/src/engine.js";

// Record staging and relationship staging fetch a table in pages, each page a
// separate run of the query. With several DuckDB threads an unordered scan
// returned rows in a different order every run, so pages overlapped and
// skipped rows without any error.
const ROWS = 40_000;
const PAGE = 1000;
let dir: string;
let previousThreads: string | undefined;

beforeAll(async () => {
  previousThreads = process.env.DUCKDB_THREADS;
  process.env.DUCKDB_THREADS = "4";
  dir = await mkdtemp(join(tmpdir(), "meridian-paged-"));
  await mkdir(join(dir, "datasets", "s"), { recursive: true });
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  // Many small row groups, so the scan really is spread across threads.
  await c.run(
    `COPY (SELECT i AS id, md5(i::VARCHAR) AS h FROM range(${ROWS}) t(i)) TO '${join(dir, "datasets", "s", "v1.parquet")}' (FORMAT PARQUET, ROW_GROUP_SIZE 1024)`,
  );
  c.closeSync();
  db.closeSync();
});
afterAll(async () => {
  if (previousThreads === undefined) delete process.env.DUCKDB_THREADS;
  else process.env.DUCKDB_THREADS = previousThreads;
  await rm(dir, { recursive: true, force: true });
});

async function pageThrough(sql: string) {
  const seen = new Map<string, number>();
  for (let offset = 0; offset < ROWS; offset += PAGE) {
    const r = await execute(
      {
        mode: "query",
        scope: "s",
        inputs: [{ table: "t", version: "v1" }],
        sql,
        version: "q" + Math.random().toString(36).slice(2, 10),
        offset,
        limit: PAGE,
        profile: "basic",
      },
      dir,
    );
    for (const row of r.rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  }
  return {
    distinct: seen.size,
    duplicates: [...seen.values()].filter((n) => n > 1).length,
  };
}

describe("paged reads with several threads", () => {
  it("returns every row of an unordered scan exactly once", async () => {
    // Without the fix this lost about a third of the rows and duplicated others.
    expect(await pageThrough('SELECT * FROM "t"')).toEqual({
      distinct: ROWS,
      duplicates: 0,
    });
  });

  it("returns every row of an ordered join exactly once", async () => {
    // A join's output order is not stable, so staging orders by its keys.
    expect(
      await pageThrough(
        'SELECT a.id AS id, b.h AS h FROM "t" a JOIN "t" b ON a.id = b.id ORDER BY 1, 2',
      ),
    ).toEqual({ distinct: ROWS, duplicates: 0 });
  });
});
