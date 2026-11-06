import type {
  ValidationOmission,
  ValidationReport,
} from "../../../../../packages/shared/src";

const kindLabel: Record<ValidationOmission["kind"], string> = {
  pipeline: "Pipeline",
  objectType: "Object type",
  relationship: "Relationship",
  action: "Action",
};

export function PublicationValidation({
  report,
}: {
  report?: ValidationReport;
}) {
  const omissions = Array.isArray(report?.omissions)
    ? report.omissions
    : undefined;
  return (
    <section className="on-validation" aria-label="Publication validation">
      <h2>Publication validation</h2>
      <p className="on-validation-status">
        {report?.valid === true
          ? "Passed for published definitions"
          : report?.valid === false
            ? "Validation has unresolved checks"
            : "Validation report unavailable"}
      </p>
      <p>
        Validation applies to the published definitions. It does not establish
        completeness or business meaning.
      </p>
      {!omissions ? (
        <p>
          Omission history is unavailable for this publication. Missing reasons
          are not inferred from a passing report.
        </p>
      ) : omissions.length === 0 ? (
        <p>No definitions were removed by validation pruning.</p>
      ) : (
        <details>
          <summary>
            {omissions.length}{" "}
            {omissions.length === 1
              ? "definition omitted"
              : "definitions omitted"}{" "}
            during validation pruning
          </summary>
          <div
            className="on-validation-details"
            role="region"
            aria-label="Omitted definition details"
            tabIndex={0}
          >
            <ol>
              {omissions.map((omission, i) => (
                <li key={`${omission.kind}:${omission.name}:${i}`}>
                  <strong>
                    {kindLabel[omission.kind]}: {omission.name}
                  </strong>
                  <ul>
                    {(omission.reasons.length
                      ? omission.reasons
                      : ["No individual reason was retained."]
                    ).map((reason, j) => (
                      <li key={j}>{reason}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}
    </section>
  );
}
