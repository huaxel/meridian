import {
  AnalyticalSourceSchema,
  OntologyConfirmSchema,
  SuggestedOntologySchema,
  type OntologyConfirm,
  type SuggestedOntology,
} from "../../../../packages/shared/src/index.js";
import { assert, digest } from "../security.js";
import { summarize } from "./suggest.js";
import { list, lowerFirst, plural } from "./names.js";

export function confirmOntology(
  s: SuggestedOntology,
  edits: OntologyConfirm,
): SuggestedOntology {
  const excludedEdits = edits.excluded || [],
    namesEdits = edits.names || {},
    predicateEdits = edits.predicates || {},
    analyticalSources = (edits.analyticalSources || []).map((source) => AnalyticalSourceSchema.parse(source));
  const ids = new Set(s.entities.map((e) => e.id));
  for (const id of [...excludedEdits, ...Object.keys(namesEdits)])
    assert(ids.has(id), "Unknown entity in the suggested ontology");
  const linksById = new Map(s.links.map((link) => [link.id, link]));
  for (const [id, choice] of Object.entries(predicateEdits)) {
    const link = linksById.get(id);
    assert(link, "Unknown link in predicate selection", 409);
    assert(!link.predicate, "Catalog-asserted predicates cannot be overridden", 409);
    assert(
      link.predicateCandidates?.some((candidate) =>
        candidate.side === choice.side && candidate.column === choice.column &&
        candidate.values.some((value) => value.value === choice.value),
      ),
      "Predicate selection is not one of the measured candidates for this link", 409,
    );
  }
  const unplaced = new Set(s.unplaced);
  assert(
    new Set(analyticalSources.map((source) => source.datasetId)).size === analyticalSources.length &&
      analyticalSources.every((source) => unplaced.has(source.datasetId)),
    "Analytical sources must be unique datasets from the unplaced list",
    409,
  );
  const excluded = new Set(excludedEdits);
  const entities = s.entities
    .filter((e) => !excluded.has(e.id))
    .map((e) => {
      const name = namesEdits[e.id]?.trim();
      return name === undefined ? e : { ...e, name };
    });
  assert(
    entities.every((e) => e.name.length > 0),
    "Entity names cannot be empty",
  );
  assert(
    new Set([...entities.map((e) => e.name.toLowerCase()), ...analyticalSources.map((source) => source.name.toLowerCase())]).size === entities.length + analyticalSources.length,
    "Record and analytical-source names must be unique",
  );
  // Data without a recognisable key still builds dashboards, so setup never stalls.
  assert(
    entities.some((e) => e.kind === "record") || analyticalSources.length > 0 ||
      !s.entities.some((e) => e.kind === "record"),
    "Keep at least one entity to build records from",
  );
  const links = s.links
    .filter((l) => !excluded.has(l.from) && !excluded.has(l.to))
    .map((link) => {
      const choice = predicateEdits[link.id];
      return choice
        ? { ...link, predicate: { ...choice, op: "=" as const }, predicateBasis: "confirmed" as const }
        : link;
    });
  const kept = new Set(links.map((l) => l.id));
  const renamed = Object.keys(namesEdits).length > 0;
  const members = entities.flatMap((e) => e.members);
  return {
    ...s,
    ...(analyticalSources.length ? { analyticalSources } : {}),
    unplaced: s.unplaced.filter((id) => !analyticalSources.some((source) => source.datasetId === id)),
    summary:
      excluded.size || analyticalSources.length || (renamed && !s.described)
        ? summarize(
            entities,
            new Set(members.map((m) => m.datasetId)).size + s.unplaced.length,
            new Set(members.map((m) => m.source)).size,
          ) + (analyticalSources.length ? ` Plus ${analyticalSources.length} reviewed analytical source${analyticalSources.length === 1 ? "" : "s"}.` : "")
        : s.summary,
    entities,
    links,
    notes: s.notes.filter(
      (n) =>
        !n.entities?.some((id) => excluded.has(id)) &&
        !n.links?.some((id) => !kept.has(id)),
    ),
  };
}
export function resolvedOntologyDigest(value: SuggestedOntology): string {
  const canonical = {
    ...value,
    entities: [...value.entities]
      .map((entity) => ({ ...entity, properties: [...entity.properties].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    links: [...value.links].sort((a, b) => a.id.localeCompare(b.id)),
    notes: [...value.notes].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    unplaced: [...value.unplaced].sort(),
    ...(value.analyticalSources?.length ? {
      analyticalSources: [...value.analyticalSources]
        .map((source) => ({ ...source, dimensions: [...source.dimensions].sort(), measures: [...source.measures].sort() }))
        .sort((a, b) => a.datasetId.localeCompare(b.datasetId)),
    } : {}),
  };
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) :
    v && typeof v === "object" ? Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]),
    ) : v;
  return digest(JSON.stringify(stable(canonical)));
}
export const ontologyGoal = (o: SuggestedOntology) =>
  `Give an overview of ${list(o.entities.map((e) => plural(lowerFirst(e.name))))}${o.analyticalSources?.length ? ` and ${o.analyticalSources.length} reviewed analytical source${o.analyticalSources.length === 1 ? "" : "s"}` : ""}, and how they connect.`.slice(
    0,
    4000,
  );

// Bundle definitions for a confirmed ontology: a pipeline per merged entity (the
// anchor LEFT JOIN its merged datasets), object types, and relationships. Links that
// match only ignoring case, or across column types, join on lower()-normalized key
// columns added by pipelines; a link that cannot be expressed is left out.

// Compact approvals reference mutable suggestions: identity alone is insufficient
// because description jobs can update text without changing the structural hash.
export function confirmedOntologyValue(
  onboarding: Record<string, any>,
  signature: string,
): SuggestedOntology | undefined {
  const approval = onboarding.ontology;
  if (approval?.signature !== signature) return undefined;
  try {
    let value: SuggestedOntology;
    const suggestion = onboarding.ontologySuggestion;
    if (suggestion?.signature === signature) {
      if (
        suggestion.hash !== (approval.suggestionHash || approval.value?.hash) ||
        !SuggestedOntologySchema.safeParse(suggestion).success
      )
        return undefined;
      const edits = OntologyConfirmSchema.parse({
        hash: suggestion.hash,
        excluded: approval.edits?.excluded || [],
        names: approval.edits?.names || {},
        predicates: approval.edits?.predicates || {},
        analyticalSources: approval.edits?.analyticalSources || [],
      });
      value = confirmOntology(suggestion, edits);
    } else {
      // Legacy approvals may retain the complete, already-edited snapshot.
      value = approval.value;
    }
    // Validate without reserializing Zod's output: parsing reorders object keys,
    // while existing approval hashes cover the original JSON representation.
    const hasScopedSemantics = !!value.analyticalSources?.length || value.links.some((link) => link.additionalJoinPairs !== undefined || link.predicate);
    const digestMatches = resolvedOntologyDigest(value) === approval.hash ||
      (!hasScopedSemantics && digest(JSON.stringify(value)) === approval.hash);
    if (
      !SuggestedOntologySchema.safeParse(value).success ||
      value.signature !== signature ||
      !digestMatches
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
