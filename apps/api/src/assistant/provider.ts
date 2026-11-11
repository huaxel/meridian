import {
  type Bundle,
  ProviderSchema,
  type Resource,
  type ValidationReport,
  datasetAliases,
  datasetTable,
} from "../../../../packages/shared/src/index.js";
import { getAll, type Store } from "../store.js";
import { assert, digest, unseal } from "../security.js";
import { config } from "../config.js";

export const proposalHash = (bundle: Bundle, report: ValidationReport) => {
  const canonicalBundle = {
    ...bundle,
    relationships: bundle.relationships.map((relationship) =>
      relationship.additionalJoinPairs
        ? {
            ...relationship,
            additionalJoinPairs: [...relationship.additionalJoinPairs].sort(
              (a, b) => a.fromColumn.localeCompare(b.fromColumn) || a.toColumn.localeCompare(b.toColumn),
            ),
          }
        : relationship,
    ),
    analyticalSources: [...bundle.analyticalSources]
      .map((source) => ({
        ...source,
        dimensions: [...source.dimensions].sort(),
        measures: [...source.measures].sort(),
      }))
      .sort((a, b) => a.datasetId.localeCompare(b.datasetId) || a.name.localeCompare(b.name)),
  };
  return digest(JSON.stringify({
    bundle: canonicalBundle,
    inputVersions: report.inputVersions,
    baseGeneration: report.baseGeneration || null,
  }));
};
export async function providerSettings(store: Store, scope: string) {
  const r = await store.get(scope, "provider");
  return r
    ? {
        ...ProviderSchema.parse(r.data.settings),
        apiKey: r.data.secret ? unseal<string>(r.data.secret) : undefined,
      }
    : ProviderSchema.parse({
        provider: "local",
        localApi: "openai-compatible",
        model: "Qwen3.6-35B-A3B-MTP",
        baseUrl: config.modelEndpoint,
      });
}
export async function datasetsMap(store: Store, scope: string) {
  const generation = (await store.get(scope, "workspace"))?.data
    .activeGeneration;
  return new Map(
    (await store.list(scope, "dataset"))
      .filter((d) => !d.data.generation || d.data.generation === generation)
      .map((d) => [d.id, d]),
  );
}
export async function inputsFor(
  store: Store,
  scope: string,
  ids: string[],
  datasets: Map<string, Resource>,
) {
  // Local Parquet datasets are file references, not snapshots: forward the
  // version's source path so the executor reads the mounted file instead of
  // a snapshot that was never materialized. Derived-only inputs have no
  // version record and keep resolving to their persisted snapshot.
  const unique = [...new Set(ids)];
  for (const id of unique)
    assert(datasets.get(id)?.data.activeVersion, `Unknown dataset ${id}`);
  // One batched read for every version record instead of a get per input.
  const versions = await getAll(
    store,
    scope,
    unique.map((id) => datasets.get(id)!.data.activeVersion as string),
  );
  return Promise.all(
    unique.map(async (id) => {
      const d = datasets.get(id)!;
      const v = versions.get(d.data.activeVersion as string);
      const vd = v?.data;
      return {
        table: datasetTable(id),
        version: d.data.activeVersion as string,
        // Partitioned version: read the whole partition set (the assistant's
        // general aggregations have no partition-key filter to prune by).
        ...(vd?.partitions && vd.partitions.length
          ? { files: vd.partitions.map((p: any) => p.file) }
          : {}),
        ...(vd?.sourcePath
          ? {
              sourcePath: vd.sourcePath,
              sourceFingerprint: vd.sourceFingerprint,
            }
          : {}),
        aliases: datasetAliases(d.name),
      };
    }),
  );
}

// Prune a partitioned input down to the partition files a scoped question
// actually needs. `declared` maps a dataset table name to the partition
// values the model named; `manifests` maps the table to its stored
// partition manifest. Pruning is opt-in: a table with no (valid)
// declaration keeps every partition, so an uncertain model always reads
// the full, correct snapshot.
export function prunePartitionInputs<T extends { table: string; files?: string[] }>(
  inputs: T[],
  declared: Record<string, string[]> | undefined,
  manifests: Record<string, { key: string; file: string }[]>,
): T[] {
  if (!declared || !Object.keys(declared).length) return inputs;
  const norm = (x: unknown) => (x === null || x === undefined ? "" : String(x));
  return inputs.map((input) => {
    const values = declared[input.table];
    const manifest = manifests[input.table];
    if (!values?.length || !manifest?.length) return input;
    const keys = new Set(manifest.map((p) => norm(p.key)));
    const wanted = new Set(values.map(norm));
    if (![...wanted].some((v) => keys.has(v))) return input;
    return {
      ...input,
      files: manifest
        .filter((p) => wanted.has(norm(p.key)))
        .map((p) => p.file),
    } as T;
  });
}

// Resolve the model's declared partitions (keyed by dataset id, name, or
// table) to table names, fetch each scoped input's stored manifest, and
// prune the inputs' file lists to the matching partitions.
export async function applyPartitionPrune<T extends {
  table: string;
  version: string;
  files?: string[];
}>(
  inputs: T[],
  declared: Record<string, string[]> | undefined,
  datasets: Map<string, Resource>,
  store: Store,
  scope: string,
): Promise<T[]> {
  if (!declared || !Object.keys(declared).length) return inputs;
  const byTable: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(declared)) {
    if (!Array.isArray(values) || !values.length) continue;
    const d = [...datasets.values()].find(
      (x) => x.id === key || x.name === key || datasetTable(x.id) === key,
    );
    if (d) byTable[datasetTable(d.id)] = values.map(String);
  }
  if (!Object.keys(byTable).length) return inputs;
  const manifests: Record<string, { key: string; file: string }[]> = {};
  const scoped = inputs.filter((input) => byTable[input.table]);
  const versions = await getAll(
    store,
    scope,
    scoped.map((input) => input.version),
  );
  for (const input of scoped) {
    const v = versions.get(input.version);
    if (v?.data.partitions?.length)
      manifests[input.table] = v.data.partitions.map((p: any) => ({
        key: p.key,
        file: p.file,
      }));
  }
  return prunePartitionInputs(inputs, byTable, manifests);
}
