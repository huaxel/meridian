// Area schemas for Ontology: object types, link types, actions and object views.
// Owned by the ontology area. Import values only from "zod" (or other area modules):
// index.ts re-exports this file, so a value import from "./index.js" would be circular.
// Type-only imports from "./index.js" are fine.
import { z } from "zod";

export const OntologySchema = z.object({
  name: z.string().min(1),
  datasetId: z.string(),
  primaryKey: z.string(),
  properties: z.array(z.string()),
  description: z.string().default(""),
});
// Analytical sources are queryable datasets, not row-addressable records.
// Deliberately no primaryKey field: they cannot enter record APIs or graph edges.
export const AnalyticalSourceSchema = z.object({
  datasetId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  role: z.enum(["fact", "dimension", "other"]),
  grain: z.string().max(500).optional(),
  dimensions: z.array(z.string().min(1)).default([]),
  measures: z.array(z.string().min(1)).default([]),
});
export type AnalyticalSource = z.infer<typeof AnalyticalSourceSchema>;
export const JoinPairSchema = z.object({
  fromColumn: z.string().min(1),
  toColumn: z.string().min(1),
}).strict();
export const RelationshipPredicateSchema = z.object({
  side: z.enum(["from", "to"]),
  column: z.string().min(1),
  op: z.literal("="),
  value: z.string(),
}).strict();
export const RelationshipSchema = z.object({
  name: z.string(),
  fromType: z.string(),
  toType: z.string(),
  fromColumn: z.string(),
  toColumn: z.string(),
  additionalJoinPairs: z.array(JoinPairSchema).min(1).optional(),
  predicate: RelationshipPredicateSchema.optional(),
  predicateBasis: z.enum(["asserted", "confirmed"]).optional(),
  fromDatasetId: z.string().optional(),
  toDatasetId: z.string().optional(),
});
