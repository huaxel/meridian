const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const textType = (type: string) => /^(VARCHAR|CHAR|TEXT|STRING)(\s*\(\s*\d+\s*\))?$/i.test(type.trim());

type Relationship = {
  fromColumn: string;
  toColumn: string;
  additionalJoinPairs?: { fromColumn: string; toColumn: string }[];
  predicate?: { side: "from" | "to"; column: string; op: "="; value: string };
  predicateBasis?: "asserted" | "confirmed";
};
type ProfileColumn = { name: string; type: string };

/** Build a fail-closed ON clause from the complete persisted relationship contract. */
export function relationshipJoinCondition(
  relationship: Relationship,
  fromColumns: ProfileColumn[],
  toColumns: ProfileColumn[],
  fromAlias = "a",
  toAlias = "b",
): string {
  const pairs = [
    { fromColumn: relationship.fromColumn, toColumn: relationship.toColumn },
    ...(relationship.additionalJoinPairs || []),
  ];
  const seenFrom = new Set<string>(), seenTo = new Set<string>();
  const conditions = pairs.map(({ fromColumn, toColumn }) => {
    if (!fromColumn || !toColumn || seenFrom.has(fromColumn) || seenTo.has(toColumn))
      throw new Error("Malformed or repeated relationship join component");
    seenFrom.add(fromColumn); seenTo.add(toColumn);
    if (!fromColumns.some((column) => column.name === fromColumn) || !toColumns.some((column) => column.name === toColumn))
      throw new Error("Unknown relationship join column");
    return `${fromAlias}.${quote(fromColumn)}=${toAlias}.${quote(toColumn)}`;
  });
  const predicate = relationship.predicate;
  if (!predicate && relationship.predicateBasis)
    throw new Error("Relationship predicate provenance is present without a predicate");
  if (predicate) {
    if (!relationship.predicateBasis) throw new Error("Relationship predicate provenance is missing");
    const columns = predicate.side === "from" ? fromColumns : toColumns;
    const column = columns.find((candidate) => candidate.name === predicate.column);
    if (!column || !textType(column.type) || typeof predicate.value !== "string")
      throw new Error("Relationship predicate must use a known scalar text column and string value");
    const alias = predicate.side === "from" ? fromAlias : toAlias;
    conditions.push(`${alias}.${quote(predicate.column)}=${literal(predicate.value)}`);
  }
  return conditions.join(" AND ");
}
