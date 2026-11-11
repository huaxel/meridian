import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../services/executor/src/engine.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "meridian-basic-profile-"));
  await mkdir(join(dir, "incoming", "a"), { recursive: true });
  await writeFile(
    join(dir, "incoming", "a", "input.jsonl"),
    [
      { id: "a", amount: 10, region: "EU", email: "a@example.com" },
      { id: "b", amount: 20, region: "US", email: null },
      { id: "c", amount: 30, region: "EU", email: "c@example.com" },
      { id: "d", amount: 40, region: "US", email: "d@example.com" },
      { id: "e", amount: 50, region: "EU", email: null },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  await execute(
    { mode: "ingest", scope: "a", version: "one", file: "input.jsonl" },
    dir,
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const query = (extra: Record<string, unknown>) =>
  execute(
    {
      mode: "query",
      scope: "a",
      version: "q" + Math.random().toString(36).slice(2, 10),
      inputs: [{ table: "input", version: "one" }],
      sql: "SELECT * FROM input ORDER BY id",
      ...extra,
    } as any,
    dir,
  );

describe("basic query profile", () => {
  it("pages rows and reports the total row count", async () => {
    const r = await query({ profile: "basic", limit: 2, offset: 2 });
    expect(r.rows.map((row) => row.id)).toEqual(["c", "d"]);
    expect(r.profile.rows).toBe(5);
  });

  it("marks the profile basic and leaves measured-only fields as placeholders", async () => {
    const r = await query({ profile: "basic", limit: 2 });
    expect(r.profile.basic).toBe(true);
    expect(r.profile.columns.map((c) => c.name).sort()).toEqual([
      "amount",
      "email",
      "id",
      "region",
    ]);
    const email = r.profile.columns.find((c) => c.name === "email")!;
    // Sensitivity is decided from the name, so it is still reported.
    expect(email.sensitive).toBe(true);
    expect(email).toMatchObject({ nulls: 0, distinct: 0, primaryKey: false });
    expect(r.profile.columns.find((c) => c.name === "id")?.type).toMatch(
      /VARCHAR/i,
    );
    expect(r.profile).not.toHaveProperty("duplicateRows");
  });

  it("reads the query as written, including aggregates", async () => {
    const r = await query({
      profile: "basic",
      sql: "SELECT region, count(*) AS n FROM input GROUP BY region ORDER BY region",
    });
    expect(r.rows).toEqual([
      { region: "EU", n: "3" },
      { region: "US", n: "2" },
    ]);
    expect(r.profile.rows).toBe(2);
  });

  it("keeps the single-SELECT restriction", async () => {
    await expect(
      query({ profile: "basic", sql: "DROP TABLE input" }),
    ).rejects.toThrow(/single SELECT/i);
  });

  it("is not the default: an unflagged query is fully profiled", async () => {
    const r = await query({ limit: 2 });
    expect(r.profile.basic).toBeUndefined();
    expect(r.profile.columns.find((c) => c.name === "id")).toMatchObject({
      primaryKey: true,
      distinct: 5,
    });
    expect(r.profile.columns.find((c) => c.name === "email")?.nulls).toBe(2);
  });

  it("ignores basic when the result is persisted as a dataset", async () => {
    const version = "persisted-basic";
    const r = await query({ profile: "basic", persist: true, version });
    expect(r.profile.basic).toBeUndefined();
    expect(r.profile.columns.find((c) => c.name === "id")?.primaryKey).toBe(
      true,
    );
    const file = await stat(join(dir, "datasets", "a", `${version}.parquet`));
    expect(file.size).toBeGreaterThan(0);
  });
});
