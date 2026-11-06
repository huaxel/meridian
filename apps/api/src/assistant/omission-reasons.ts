import type {
  Bundle,
  ValidationOmission,
  ValidationReport,
} from "../../../../packages/shared/src/index.js";
import { redact } from "../security.js";

// Diagnostic only: compare the actual before/after definitions, never decide
// what to prune. Keep historical failures separate from final passing checks.
export function omittedDefinitions(
  before: Bundle,
  after: Bundle,
  report: ValidationReport,
): ValidationOmission[] {
  const names = (items: { name: string }[]) =>
    new Set(items.map((x) => x.name));
  const pipelines = names(after.pipelines),
    types = names(after.ontology),
    relationships = names(after.relationships),
    actions = names(after.actions);
  const removedTypes = new Set(
    before.ontology.filter((t) => !types.has(t.name)).map((t) => t.name),
  );
  const out: ValidationOmission[] = [];
  const record = (
    kind: ValidationOmission["kind"],
    name: string,
    prefix: string,
    dependencies: string[] = [],
  ) => {
    const reasons = [
      ...report.checks
        .filter((c) => !c.passed && c.name === prefix + name)
        .map((c) => c.detail),
      ...dependencies
        .filter((n) => removedTypes.has(n))
        .map((n) => `Object type "${n}" was omitted during validation pruning`),
    ];
    out.push({
      kind,
      name,
      reasons: [
        ...new Set(
          (reasons.length
            ? reasons
            : [
                "Removed during confirmed-build validation pruning; no individual failure detail was retained",
              ]
          ).map(redact),
        ),
      ],
    });
  };
  for (const p of before.pipelines)
    if (!pipelines.has(p.name)) record("pipeline", p.name, "Pipeline: ");
  for (const t of before.ontology)
    if (!types.has(t.name)) record("objectType", t.name, "Ontology: ");
  for (const r of before.relationships)
    if (!relationships.has(r.name))
      record("relationship", r.name, "Relationship: ", [r.fromType, r.toType]);
  for (const a of before.actions)
    if (!actions.has(a.name))
      record("action", a.name, "Action: ", [a.objectType]);
  return out;
}
