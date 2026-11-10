import { z } from "zod";
import { SourceSchema } from "./data.js";
import { PipelineSchema } from "./pipelines.js";
import { AnalyticalSourceSchema, OntologySchema, RelationshipSchema } from "./ontology.js";
import { DashboardSchema } from "./workspace.js";
// Connector cards the sample data imitates; highlighted when it loads.
export const sampleSources = [
  "workos",
  "posthog",
  "planetscale",
  "stripe",
  "s3",
] as const;
export const RoleSchema = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;
export type Resource = {
  id: string;
  workspaceId: string;
  kind: string;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
};
export const hostingProviders = ["neon", "supabase", "planetscale"] as const;
export const HostingProviderSchema = z.enum(hostingProviders);
export type HostingProvider = z.infer<typeof HostingProviderSchema>;
export const PlanetScaleTokenSchema = z
  .object({
    serviceTokenId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/),
    serviceToken: z
      .string()
      .trim()
      .min(10)
      .max(4000)
      .regex(/^[\x21-\x39\x3b-\x7e]+$/),
  })
  .strict();
export type PlanetScaleToken = z.infer<typeof PlanetScaleTokenSchema>;
export const HostingTokenSchema = z.union([
  z.object({ apiKey: z.string().trim().min(10).max(4000) }).strict(),
  PlanetScaleTokenSchema,
]);
export const HostingSelectionSchema = z.object({
  accountId: z.string().min(1).max(100),
  path: z.array(z.string().min(1).max(200)).max(4).default([]),
  password: z.string().max(1000).optional(),
});
export type HostingSelection = z.infer<typeof HostingSelectionSchema>;
export type HostingOption = { id: string; name: string; description?: string };
export type HostingOptions = {
  title: string;
  options: HostingOption[];
  ready?: boolean;
  needsPassword?: boolean;
};
export type HostedConnection = {
  id: string;
  name: string;
  kind: "postgres" | "mysql";
  config: { hostedConnectionId: string };
  discovery: any;
};
export const ProviderSchema = z
  .object({
    provider: z.enum(["local", "claude", "openai"]),
    localApi: z.enum(["ollama", "openai-compatible"]).default("ollama"),
    model: z.string().min(1).max(150),
    baseUrl: z.url().optional(),
    apiKey: z.string().optional(),
    allowRawData: z.boolean().default(false),
    dailyTokens: z.number().int().min(1000).max(10_000_000).default(200_000),
    maxCalls: z.number().int().min(1).max(20).default(20),
    timeoutSeconds: z.number().int().min(30).max(1800).default(600),
    continuous: z.boolean().default(true),
  })
  .superRefine((settings, ctx) => {
    if (
      settings.provider !== "local" ||
      settings.localApi !== "openai-compatible"
    )
      return;
    if (!settings.baseUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Endpoint URL is required",
      });
      return;
    }
    const endpoint = new URL(settings.baseUrl);
    if (!["http:", "https:"].includes(endpoint.protocol))
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Use an HTTP(S) endpoint URL",
      });
    if (endpoint.username || endpoint.password)
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Use the API key field instead of URL credentials",
      });
  });
export type ProviderSettings = z.infer<typeof ProviderSchema>;
export const OnboardingProviderSchema = ProviderSchema.extend({
  advanceToData: z.boolean().optional(),
});
export type OnboardingProvider = z.infer<typeof OnboardingProviderSchema>;
export type ColumnProfile = {
  name: string;
  type: string;
  nulls: number;
  distinct: number;
  examples: unknown[];
  sensitive: boolean;
  primaryKey: boolean;
  // Empty-string values in text columns. Empty is not SQL NULL, so it passes
  // uniqueness/non-null checks while carrying no record identity. Recorded at
  // import in the same per-column scan; undefined means unmeasured (legacy
  // profiles or the memory-fallback path), never zero.
  blanks?: number;
};
// Sample values are stored truncated: previews, examples and prompts show the
// beginning of a value, and a table of large documents would otherwise store
// megabytes per dataset.
export const SAMPLE_VALUE_LIMIT = 200;
export function compactValue(v: unknown): unknown {
  const text =
    typeof v === "string"
      ? v
      : v && typeof v === "object"
        ? JSON.stringify(v)
        : undefined;
  return text !== undefined && text.length > SAMPLE_VALUE_LIMIT
    ? text.slice(0, SAMPLE_VALUE_LIMIT) + "…"
    : v;
}
export const compactSample = (rows: Record<string, unknown>[]) =>
  rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, compactValue(v)])),
  );
export type DatasetProfile = {
  rows: number;
  duplicateRows?: number;
  approximate?: boolean;
  columns: ColumnProfile[];
  sample: Record<string, unknown>[];
  fingerprint: string;
};
// A bundle's pipeline budget. Setup normally builds a handful (one per merged
// entity); promoting composite identities in a schema-only plan needs one per
// promoted identity, so the ceiling is set by the number of composite entities
// a large workspace can declare, not by the merge default of 10.
export const MAX_BUNDLE_PIPELINES = 48;
export const BundleSchema = z.object({
  summary: z.string(),
  assumptions: z.array(z.string()),
  catalog: z.array(
    z.object({
      datasetId: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
    }),
  ),
  pipelines: z.array(PipelineSchema).max(MAX_BUNDLE_PIPELINES),
  ontology: z.array(OntologySchema).max(1000),
  analyticalSources: z.array(AnalyticalSourceSchema).max(1000).default([]),
  relationships: z.array(RelationshipSchema).max(2000),
  dashboards: z.array(DashboardSchema).max(5),
  actions: z
    .array(
      z.object({
        name: z.string(),
        objectType: z.string(),
        fields: z.array(z.string()),
      }),
    )
    .default([]),
});
export type Bundle = z.infer<typeof BundleSchema>;
const validateScopedRelationships = (bundle: Bundle, ctx: z.RefinementCtx) => {
  bundle.relationships.forEach((relationship, index) => {
    if (!!relationship.predicate !== !!relationship.predicateBasis)
      ctx.addIssue({ code: "custom", path: ["relationships", index], message: "Predicate value and provenance must be present together" });
    const pairs = [
      { fromColumn: relationship.fromColumn, toColumn: relationship.toColumn },
      ...(relationship.additionalJoinPairs || []),
    ];
    if (new Set(pairs.map((pair) => pair.fromColumn)).size !== pairs.length || new Set(pairs.map((pair) => pair.toColumn)).size !== pairs.length)
      ctx.addIssue({ code: "custom", path: ["relationships", index], message: "Relationship tuple components must be unique on each side" });
  });
};
// V2 exchange protects scoped relationship fields; it cannot carry analytical sources.
export const BundleV2Schema = BundleSchema.extend({
  relationships: z.array(RelationshipSchema.strict()).max(2000),
}).strict().superRefine((bundle, ctx) => {
  validateScopedRelationships(bundle, ctx);
  if (bundle.analyticalSources.length)
    ctx.addIssue({ code: "custom", path: ["analyticalSources"], message: "Analytical sources require definitions version 3" });
});
// V3 adds explicit keyless analytical-source definitions; all fields remain strict.
export const BundleV3Schema = BundleSchema.extend({
  relationships: z.array(RelationshipSchema.strict()).max(2000),
  analyticalSources: z.array(AnalyticalSourceSchema.strict()).max(1000),
}).strict().superRefine(validateScopedRelationships);
const legacyBundleHasNoScopedSemantics = (value: unknown) => {
  if (!value || typeof value !== "object") return false;
  const relationships = (value as { relationships?: unknown }).relationships;
  const analyticalSources = (value as { analyticalSources?: unknown }).analyticalSources;
  return (analyticalSources === undefined || (Array.isArray(analyticalSources) && analyticalSources.length === 0)) &&
    Array.isArray(relationships) && relationships.every((r) =>
      !!r && typeof r === "object" &&
      !("additionalJoinPairs" in r) && !("predicate" in r) && !("predicateBasis" in r),
    );
};
export const ProposalUpdateSchema = z.union([
  BundleSchema,
  z.object({ version: z.literal(3), bundle: BundleV3Schema }).strict(),
]);
export const DefinitionsImportSchema = z.union([
  z.object({ version: z.literal(1), proposals: z.array(z.unknown()) }).superRefine((v, ctx) => {
    v.proposals.forEach((proposal, i) => {
      if (!legacyBundleHasNoScopedSemantics(proposal)) ctx.addIssue({ code: "custom", path: ["proposals", i], message: "Definitions v1 cannot contain scoped or composite relationships" });
      else if (!BundleSchema.safeParse(proposal).success) ctx.addIssue({ code: "custom", path: ["proposals", i], message: "Invalid definitions v1 proposal" });
    });
  }),
  z.object({ version: z.literal(2), proposals: z.array(BundleV2Schema) }).strict(),
  z.object({ version: z.literal(3), proposals: z.array(BundleV3Schema) }).strict(),
]);
export type ValidationOmission = {
  kind: "pipeline" | "objectType" | "relationship" | "action";
  name: string;
  reasons: string[];
};
export type ValidationReport = {
  // Checks describe the surviving bundle; omissions explain removed definitions.
  omissions?: ValidationOmission[];
  valid: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  previews: Record<string, unknown>;
  inputVersions: Record<string, string>;
  validatedAt: string;
  baseGeneration?: string | null;
};
export type ChangeProposal = {
  bundle: Bundle;
  validation: ValidationReport;
  status: "draft" | "ready" | "rejected" | "published";
  hash: string;
  parentId?: string;
  publishedGeneration?: string;
};
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permission: "read" | "draft";
};
export interface ModelProvider {
  generate(
    system: string,
    context: unknown,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ value: unknown; tokens: number }>;
}
export function datasetTable(id: string) {
  return `d_${id.replace(/-/g, "")}`;
}
export function jsonSafe(value: unknown): any {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

export function datasetAliases(name: string) {
  return [
    ...new Map(
      [name, name.replace(/[^a-zA-Z0-9]+/g, "_")]
        .filter((x) => x.length > 0 && x.length <= 100)
        .map((x) => [x.toLowerCase(), x]),
    ).values(),
  ];
}

// Setup progress is optional workspace metadata; readiness is always derived on the server.
export const OnboardingUpdateSchema = z.object({
  step: z.enum(["ai", "data", "outcome", "review"]).optional(),
  deferred: z.boolean().optional(),
  goal: z.string().max(4000).optional(),
  excludedIds: z.array(z.string()).max(500).optional(),
});
export const OnboardingImportSchema = SourceSchema.extend({
  selections: z
    .array(
      z.object({
        table: z.string().optional(),
        schema: z.string().optional(),
        key: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
  operationId: z.string().min(8).max(100),
});
// POST /demo: advance moves setup to the Outcome step before the samples load.
export const DemoSchema = z.object({ advance: z.boolean().optional() });
export const OnboardingOutcomeSchema = z.object({
  goal: z.string().min(5).max(4000),
  parentId: z.string().optional(),
});
export const OutcomeRecommendationsSchema = z.object({
  description: z.string(),
  outcomes: z
    .array(
      z.object({
        title: z.string(),
        question: z.string(),
        goal: z.string().min(5),
        evidence: z
          .array(
            z.object({
              datasetId: z.string(),
              columns: z.array(z.string()).min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(3),
});
export type OutcomeRecommendations = z.infer<
  typeof OutcomeRecommendationsSchema
>;
export type OnboardingUpdate = z.infer<typeof OnboardingUpdateSchema>;
export type OnboardingImport = z.infer<typeof OnboardingImportSchema>;
export const ResourceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: z.string(),
  name: z.string(),
  description: z.string(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  data: z.record(z.string(), z.any()),
});
// A suggested ontology computed from the connected data: real-world entities, each
// consolidated from one or more source datasets joined by matching keys, and the
// links between them. Display metadata lives here, outside BundleSchema.
export const OntologyMemberSchema = z.object({
  datasetId: z.string(),
  datasetName: z.string(),
  // Where the dataset came from: a sample source or connector kind, or "upload".
  source: z.string(),
  key: z.string(),
  rows: z.number(),
  // Rows of this dataset that belong to the entity (all rows for the anchor).
  matched: z.number(),
  // How a merged dataset joins the entity; null for the anchor dataset.
  via: z
    .object({
      column: z.string(),
      targetDatasetId: z.string(),
      targetColumn: z.string(),
    })
    .nullable(),
});
export const SuggestedEntitySchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  description: z.string(),
  // Activity streams (e.g. product events) feed metrics but are not stored as records.
  kind: z.enum(["record", "activity"]),
  anchorDatasetId: z.string(),
  // Name provenance: catalog business term, derived from a definition,
  // or a raw slug still needing a proper name.
  namedBy: z.enum(["catalog", "derived", "slug"]).optional(),
  key: z.string(),
  // Record identity basis. Absent means single-column. A composite carries
  // the resolved physical anchor columns; `key` stays a human-readable
  // label ("a + b") that must never be quoted as a column. Promotion to a
  // published identity happens only through a materialized surrogate plus
  // measured uniqueness/non-null checks — see COMPOSITE-KEY-DESIGN.md.
  keyKind: z.enum(["single", "composite"]).optional(),
  compositeKey: z.array(z.string()).optional(),
  rows: z.number(),
  members: z.array(OntologyMemberSchema).min(1),
  properties: z.array(z.string()),
});
export const SuggestedLinkSchema = z.object({
  id: z.string(),
  name: z.string(),
  from: z.string(),
  to: z.string(),
  fromDatasetId: z.string(),
  fromColumn: z.string(),
  toDatasetId: z.string(),
  toColumn: z.string(),
  // Legacy counts can be asserted placeholders, not measured coverage.
  // An absent basis is unverified; do not infer measurement from `evidence`.
  totalRows: z.number(),
  matchedRows: z.number(),
  matchBasis: z.enum(["measured", "asserted", "unverified"]).optional(),
  additionalJoinPairs: z.array(z.object({ fromColumn: z.string().min(1), toColumn: z.string().min(1) }).strict()).min(1).optional(),
  predicate: z.object({ side: z.enum(["from", "to"]), column: z.string().min(1), op: z.literal("="), value: z.string() }).strict().optional(),
  predicateBasis: z.enum(["asserted", "confirmed"]).optional(),
  predicateCandidates: z.array(z.object({
    side: z.enum(["from", "to"]), column: z.string(),
    values: z.array(z.object({ value: z.string(), candidateRows: z.number(), matchedSourceRows: z.number(), eligibleSourceRows: z.number(), joinPairs: z.number() })),
  })).optional(),
  caseInsensitive: z.boolean(),
  evidence: z.enum(["declared", "name", "values"]),
});
export const OntologyNoteSchema = z.object({
  kind: z.enum(["merged", "unmatched", "case", "unlinked"]),
  text: z.string(),
  // What the note is about, so it is dropped with an excluded entity or link.
  entities: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
});
export const SuggestedOntologySchema = z.object({
  signature: z.string(),
  // Optional for persisted suggestions created before versioned discovery.
  discoveryRevision: z.number().int().positive().optional(),
  hash: z.string(),
  summary: z.string(),
  // True once the AI has written the summary and descriptions.
  described: z.boolean(),
  entities: z.array(SuggestedEntitySchema),
  // Proposed business names for slug-named entities (model suggestions for
  // bulk review; never applied automatically — confirmation carries names).
  nameProposals: z.record(z.string(), z.string()).optional(),
  links: z.array(SuggestedLinkSchema),
  notes: z.array(OntologyNoteSchema),
  unplaced: z.array(z.string()),
  // Owner-reviewed classification of keyless datasets; discovery itself never populates this.
  analyticalSources: z.array(AnalyticalSourceSchema).optional(),
});
export type SuggestedOntology = z.infer<typeof SuggestedOntologySchema>;
export type SuggestedEntity = z.infer<typeof SuggestedEntitySchema>;
export type SuggestedLink = z.infer<typeof SuggestedLinkSchema>;
export const OntologyConfirmSchema = z.object({
  hash: z.string(),
  excluded: z.array(z.string()).max(1000).default([]),
  names: z.record(z.string(), z.string().min(1).max(60)).default({}),
  predicates: z.record(z.string(), z.object({ side: z.enum(["from", "to"]), column: z.string().min(1), value: z.string() })).default({}),
  analyticalSources: z.array(AnalyticalSourceSchema).max(1000).default([]),
});
export type OntologyConfirm = z.input<typeof OntologyConfirmSchema>;
export const OntologyEditsSchema = z.object({
  excluded: z.array(z.string()),
  names: z.record(z.string(), z.string()),
  predicates: z.record(z.string(), z.object({ side: z.enum(["from", "to"]), column: z.string(), value: z.string() })).optional(),
  analyticalSources: z.array(AnalyticalSourceSchema).max(1000).optional(),
});
export const SampleProgressSchema = z.object({
  total: z.number(),
  loaded: z.number(),
  pending: z.array(z.string()),
});
export const OnboardingStateSchema = z.object({
  step: z.enum(["ai", "data", "outcome", "review"]),
  deferred: z.boolean(),
  goal: z.string(),
  complete: z.boolean(),
  dashboardId: z.string().optional(),
  excludedIds: z.array(z.string()),
  datasets: z.array(ResourceSchema),
  sources: z.array(ResourceSchema),
  imports: z.array(ResourceSchema),
  providerJob: ResourceSchema.optional(),
  providerReady: z.boolean(),
  inputsReady: z.boolean(),
  blockers: z.array(z.string()),
  signature: z.string(),
  recommendationRun: ResourceSchema.optional(),
  buildRun: ResourceSchema.optional(),
  recommendations: OutcomeRecommendationsSchema.optional(),
  proposal: ResourceSchema.optional(),
  stale: z.boolean(),
  // Sample datasets still being loaded, when sample data was requested.
  sampleProgress: SampleProgressSchema.optional(),
  // Suggested ontology for the current data, and its AI description run.
  ontology: SuggestedOntologySchema.optional(),
  ontologyRun: ResourceSchema.optional(),
  // Background suggestion job for the current signature (queued/running/failed).
  suggestJob: ResourceSchema.optional(),
  ontologyConfirmed: z.boolean(),
  // The review edits confirmed for the current suggestion, to restore them.
  ontologyEdits: OntologyEditsSchema.optional(),
});

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

// Area schema modules; each area owns its file.
export * from "./data.js";
export * from "./pipelines.js";
export * from "./ontology.js";
export * from "./catalog.js";
export * from "./analyst.js";
export * from "./workspace.js";
