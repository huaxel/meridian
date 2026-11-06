import type { SuggestedLink } from "../../../../packages/shared/src/index.js";

// Display labels, suggestion IDs and evidence counts do not change a mapping.
// Keep direction, entity roles, physical source columns and comparison mode.
export function sourceLinkIdentity(
  link: Pick<
    SuggestedLink,
    | "from"
    | "to"
    | "fromDatasetId"
    | "fromColumn"
    | "toDatasetId"
    | "toColumn"
    | "caseInsensitive"
    | "additionalJoinPairs"
    | "predicate"
    | "predicateBasis"
  >,
): string {
  const pairs = [
    [link.fromColumn, link.toColumn],
    ...(link.additionalJoinPairs || []).map((p) => [p.fromColumn, p.toColumn]),
  ].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return JSON.stringify([
    link.from,
    link.to,
    link.fromDatasetId,
    link.toDatasetId,
    pairs,
    link.caseInsensitive,
    link.predicate ? [link.predicate.side, link.predicate.column, link.predicate.op, link.predicate.value] : null,
  ]);
}
