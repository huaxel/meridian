import { transaction, type Store } from "./store.js";

// Finished jobs pile up without bound: a source on the five-minute fallback
// schedule adds about 288 a day, and several screens (setup progress, the
// worker's scheduling checks) read job history. The setup state needs only the
// latest job per source or dataset, so history older than a week is dead
// weight. Failed jobs are never pruned: a failure finding points at them.
export const JOB_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const JOBS_KEPT_PER_KEY = 3;
// One pass removes at most this many, so a first run on a long-neglected
// workspace is spread over several hours instead of one huge delete.
const MAX_DELETED_PER_PASS = 500;
// HelixDB cannot plan a single commit with hundreds of mutations.
const DELETE_CHUNK = 100;
const TERMINAL = new Set(["succeeded", "canceled"]);

// Same grouping the setup state uses to pick a source's latest job, plus the
// type so a source's sync history never crowds out its own validate jobs.
const keyOf = (j: { data: Record<string, any> }) =>
  `${j.data.type}:${j.data.sourceId || j.data.datasetId || "-"}`;

export async function pruneJobHistory(
  store: Store,
  scope: string,
  opts: {
    now?: number;
    maxAgeMs?: number;
    keepPerKey?: number;
    maxDeleted?: number;
  } = {},
): Promise<number> {
  const cutoff =
    (opts.now ?? Date.now()) - (opts.maxAgeMs ?? JOB_RETENTION_MS);
  const keep = opts.keepPerKey ?? JOBS_KEPT_PER_KEY;
  // The one full read of job history, once per interval, which is what lets
  // every other path read only the active jobs.
  const jobs = await store.list(scope, "job");
  const byKey = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const key = keyOf(job);
    const group = byKey.get(key);
    if (group) group.push(job);
    else byKey.set(key, [job]);
  }
  const doomed: string[] = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const job of group.slice(keep))
      if (
        TERMINAL.has(String(job.data.status)) &&
        Date.parse(job.updatedAt) < cutoff
      )
        doomed.push(job.id);
  }
  const ids = doomed.slice(0, opts.maxDeleted ?? MAX_DELETED_PER_PASS);
  for (let i = 0; i < ids.length; i += DELETE_CHUNK)
    await transaction(store, scope, async (tx) => {
      for (const id of ids.slice(i, i + DELETE_CHUNK)) tx.delete(id);
    });
  return ids.length;
}
