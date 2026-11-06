import type { Resource } from "../../../../packages/shared/src/index.js";
import type { Store } from "../store.js";
import { resolveLocalParquet } from "../connectors.js";
import { AppError, assert } from "../security.js";

export async function assertMountedSourceCurrent(
  store: Store,
  scope: string,
  dataset: Resource,
): Promise<void> {
  const versionId = dataset.data.activeVersion;
  const version =
    typeof versionId === "string"
      ? await store.get(scope, versionId)
      : undefined;
  if (version?.kind !== "version") {
    // Preserve legacy snapshot-only schema validation behavior. A known
    // mounted source must never bypass its version/fingerprint checks.
    assert(
      !dataset.data.sourcePath && !dataset.data.sourceFingerprint,
      "Mounted source version metadata is unavailable",
      409,
    );
    return;
  }
  // Active version metadata is authoritative. The dataset's cache can describe
  // a pending import instead, including a different storage representation.
  const { sourcePath, sourceFingerprint: fingerprint } = version.data;
  if (!sourcePath) {
    const snapshot =
      typeof version.data.file === "string" && version.data.file.length > 0;
    const partitions =
      Array.isArray(version.data.partitions) &&
      version.data.partitions.length > 0;
    assert(
      snapshot ||
        partitions ||
        (!fingerprint &&
          !dataset.data.sourcePath &&
          !dataset.data.sourceFingerprint),
      "Mounted source version metadata is incomplete",
      409,
    );
    return;
  }
  assert(
    version.data.datasetId === dataset.id,
    "Mounted source version belongs to another dataset",
    409,
  );
  assert(typeof sourcePath === "string", "Invalid mounted source path", 409);
  assert(
    fingerprint &&
      Number.isFinite(fingerprint.size) &&
      fingerprint.size > 0 &&
      Number.isFinite(fingerprint.mtimeMs),
    "Mounted source fingerprint is unavailable or invalid",
    409,
  );
  try {
    await resolveLocalParquet(sourcePath, fingerprint);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      409,
      "Mounted Parquet source is missing or inaccessible; review the source before publishing",
    );
  }
}

// Cache successes AND failures only within one validation pass. Publication
// uses fresh calls at both boundaries, including each activation retry.
export function mountedSourceGuard(store: Store, scope: string) {
  const checked = new Map<string, Promise<void>>();
  return (dataset: Resource): Promise<void> => {
    const key = JSON.stringify([dataset.id, dataset.data.activeVersion]);
    let check = checked.get(key);
    if (!check) {
      check = assertMountedSourceCurrent(store, scope, dataset);
      checked.set(key, check);
    }
    return check;
  };
}
