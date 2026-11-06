import {
  BundleSchema,
  SuggestedLinkSchema,
  type Bundle,
  type Resource,
  type SuggestedLink,
  type ValidationReport,
} from "../../../../packages/shared/src/index.js";
import type { Store } from "../store.js";
import { assert } from "../security.js";
import { proposalHash } from "./provider.js";

export type PublicationMode = "records" | "schema-only";

// Evidence already lives in the server-generated validation report. Bind it to
// that proposal's exact relationship/type definitions and input versions rather
// than accepting counters from a request or duplicating a large ontology.
export async function publicationReview(
  store: Store,
  scope: string,
  proposal: Resource | undefined,
  edited: Bundle,
): Promise<{
  mode: PublicationMode;
  relationshipEvidence: Map<string, SuggestedLink>;
}> {
  const relationshipEvidence = new Map<string, SuggestedLink>();
  if (!proposal || proposal.kind !== "proposal")
    return { mode: "records", relationshipEvidence };
  const explicit = proposal.data.publicationMode;
  assert(
    explicit === undefined ||
      explicit === "records" ||
      explicit === "schema-only",
    "Invalid saved publication mode. Rebuild this proposal.",
    409,
  );
  if (explicit === "records") return { mode: "records", relationshipEvidence };
  const original = BundleSchema.parse(proposal.data.bundle);
  const report = proposal.data.validation as ValidationReport;
  const types = new Map(original.ontology.map((t) => [t.name, t]));
  const memberLinks = original.relationships.filter(
    (r) =>
      (r.fromDatasetId &&
        r.fromDatasetId !== types.get(r.fromType)?.datasetId) ||
      (r.toDatasetId && r.toDatasetId !== types.get(r.toType)?.datasetId),
  );
  // Legacy raw-member proposals could only pass with server-supplied evidence.
  // Ordinary anchor-only legacy proposals have no reliable mode marker.
  if (!explicit && !memberLinks.length) {
    assert(
      proposal.data.status !== "published",
      "Legacy publication mode is unknown. Rebuild this proposal before review or rollback.",
      409,
    );
    return { mode: "records", relationshipEvidence };
  }
  assert(
    report && proposal.data.hash === proposalHash(proposal.data.bundle, report),
    "Saved validation no longer matches this proposal. Rebuild it.",
    409,
  );
  const restored = new Map<string, SuggestedLink>();
  for (const rel of original.relationships) {
    if (
      !report.checks.some(
        (c) => c.name === "Relationship: " + rel.name && c.passed,
      )
    )
      continue;
    const preview = report.previews["relation:" + rel.name] as any;
    const from = types.get(rel.fromType),
      to = types.get(rel.toType);
    if (!from || !to || !preview?.rows?.[0]) continue;
    const parsed = SuggestedLinkSchema.safeParse({
      id: rel.name,
      name: rel.name,
      from: rel.fromType,
      to: rel.toType,
      fromDatasetId: rel.fromDatasetId || from.datasetId,
      toDatasetId: rel.toDatasetId || to.datasetId,
      fromColumn: rel.fromColumn,
      toColumn: rel.toColumn,
      ...(rel.additionalJoinPairs ? { additionalJoinPairs: rel.additionalJoinPairs } : {}),
      ...(rel.predicate ? { predicate: rel.predicate, predicateBasis: rel.predicateBasis } : {}),
      totalRows: preview.rows[0].total,
      matchedRows: preview.rows[0].matched,
      matchBasis: preview.matchBasis || "unverified",
      evidence:
        preview.evidence ||
        (preview.matchBasis === "measured" ? "values" : undefined),
      caseInsensitive: preview.caseInsensitive ?? false,
    });
    if (
      parsed.success &&
      parsed.data.totalRows >= 0 &&
      parsed.data.matchedRows >= 0 &&
      parsed.data.matchedRows <= parsed.data.totalRows &&
      [
        from.datasetId,
        to.datasetId,
        parsed.data.fromDatasetId,
        parsed.data.toDatasetId,
      ].every((id) => typeof report.inputVersions[id] === "string")
    )
      restored.set(rel.name, parsed.data);
  }
  if (
    !explicit &&
    (!report.valid || memberLinks.some((r) => !restored.has(r.name)))
  )
    return { mode: "records", relationshipEvidence };
  const current = await store.getMany(scope, Object.keys(report.inputVersions));
  if (
    Object.entries(report.inputVersions).every(
      ([id, version]) => current.get(id)?.data.activeVersion === version,
    )
  ) {
    const canonical = BundleSchema.parse(edited);
    const binding = (bundle: Bundle, rel: Bundle["relationships"][number]) => {
      const normalized = rel.additionalJoinPairs
        ? { ...rel, additionalJoinPairs: [...rel.additionalJoinPairs].sort((a, b) => a.fromColumn.localeCompare(b.fromColumn) || a.toColumn.localeCompare(b.toColumn)) }
        : rel;
      return JSON.stringify([
        normalized,
        bundle.ontology.find((t) => t.name === rel.fromType),
        bundle.ontology.find((t) => t.name === rel.toType),
      ]);
    };
    for (const rel of canonical.relationships) {
      const old = original.relationships.find((r) => r.name === rel.name);
      const saved = restored.get(rel.name);
      if (old && saved && binding(original, old) === binding(canonical, rel))
        relationshipEvidence.set(rel.name, saved);
    }
  }
  return { mode: "schema-only", relationshipEvidence };
}
