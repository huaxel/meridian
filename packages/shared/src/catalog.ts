import { z } from "zod";

// General data-catalog format (v1): any catalog can be imported to help Helix
// name entities, link tables, assert keys and flag quality. Helix never assumes
// a specific upstream catalog; converters live outside this repo.
export const CatalogTableSchema = z.object({
  // Physical table name (e.g. ZST_PERSON, DFKKOP). Matching to datasets is by
  // normalized name (case/path/extension/domain-insensitive).
  table: z.string().min(1),
  businessName: z.string().optional(),
  definition: z.string().optional(),
  owner: z.string().optional(),
  // Asserted keys (each a column or composite). Trusted on import; used where
  // Helix cannot prove uniqueness itself (e.g. composite SAP keys).
  keys: z.array(z.array(z.string().min(1)).min(1)).optional(),
  quality: z.enum(["canonical", "draft", "deprecated"]).optional(),
});
export const CatalogJoinSchema = z.object({
  leftTable: z.string().min(1),
  leftKey: z.string().min(1),
  rightTable: z.string().min(1),
  rightKey: z.string().min(1),
  cardinality: z.string().optional(),
  note: z.string().optional(),
});
export const CatalogDomainSchema = z.object({
  name: z.string().min(1),
  definition: z.string().optional(),
  tables: z.array(z.string().min(1)).optional(),
});
export const CatalogSchema = z.object({
  version: z.literal(1),
  name: z.string().optional(),
  tables: z.array(CatalogTableSchema).default([]),
  joins: z.array(CatalogJoinSchema).default([]),
  domains: z.array(CatalogDomainSchema).default([]),
});
const CatalogJoinV2Schema = CatalogJoinSchema.extend({
  additionalJoinPairs: z.array(z.object({
    leftKey: z.string().min(1), rightKey: z.string().min(1),
  }).strict()).min(1).optional(),
  predicate: z.object({
    side: z.enum(["left", "right"]), column: z.string().min(1),
    op: z.literal("="), value: z.string(),
  }).strict().optional(),
}).strict().superRefine((join, ctx) => {
  const pairs = [
    { leftKey: join.leftKey, rightKey: join.rightKey },
    ...(join.additionalJoinPairs || []),
  ];
  const left = pairs.map((pair) => pair.leftKey), right = pairs.map((pair) => pair.rightKey);
  if (new Set(left).size !== left.length || new Set(right).size !== right.length)
    ctx.addIssue({ code: "custom", message: "Catalog join components must be unique on each side" });
});
export const CatalogV2Schema = z.object({
  version: z.literal(2),
  name: z.string().optional(),
  tables: z.array(CatalogTableSchema).default([]),
  joins: z.array(CatalogJoinV2Schema).default([]),
  domains: z.array(CatalogDomainSchema).default([]),
}).strict();
export const CatalogImportSchema = z.unknown().superRefine((value, ctx) => {
  if (!value || typeof value !== "object" || !("version" in value)) {
    ctx.addIssue({ code: "custom", message: "Catalog must declare version 1 or 2" });
    return;
  }
  const version = (value as { version?: unknown }).version;
  if (version === 1) {
    const joins = (value as { joins?: unknown }).joins;
    if (Array.isArray(joins) && joins.some((join) => join && typeof join === "object" && ("additionalJoinPairs" in join || "predicate" in join))) {
      ctx.addIssue({ code: "custom", path: ["joins"], message: "Composite joins and predicates require catalog version 2" });
      return;
    }
    const parsed = CatalogSchema.safeParse(value);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: "Invalid catalog version 1" });
  } else if (version === 2) {
    const parsed = CatalogV2Schema.safeParse(value);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: "Invalid catalog version 2" });
  } else {
    ctx.addIssue({ code: "custom", message: "Unsupported catalog version" });
  }
}).transform((value) => parseCatalog(value));
export type CatalogV1 = z.infer<typeof CatalogSchema>;
export type CatalogV2 = z.infer<typeof CatalogV2Schema>;
export type Catalog = CatalogV1 | CatalogV2;
export function parseCatalog(value: unknown): Catalog {
  if (!value || typeof value !== "object" || !("version" in value))
    throw new Error("Catalog must declare version 1 or 2");
  if ((value as { version?: unknown }).version === 1)
    return CatalogSchema.parse(value);
  if ((value as { version?: unknown }).version === 2)
    return CatalogV2Schema.parse(value);
  throw new Error("Unsupported catalog version");
}
export type CatalogTable = z.infer<typeof CatalogTableSchema>;
export type CatalogJoin = z.infer<typeof CatalogJoinSchema> | z.infer<typeof CatalogJoinV2Schema>;
