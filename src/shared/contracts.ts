import { z } from "zod";
export const Aspects = [
  "pricing",
  "onboarding",
  "reliability",
  "support",
  "features",
  "other",
] as const;
export const Sentiments = [
  "positive",
  "negative",
  "mixed",
  "neutral",
  "unknown",
] as const;
export const aspectSchema = z
  .object({
    aspect: z.enum(Aspects),
    sentiment: z.enum(Sentiments),
    quote: z.string().min(1).max(10000),
  })
  .strict();
export type AspectLabel = z.infer<typeof aspectSchema>;
export const rawRecordSchema = z
  .object({
    id: z.string().min(1).max(160),
    text: z.string().min(1).max(20000),
    url: z.string().url().nullable(),
    threadId: z.string().min(1).max(160),
    threadTitle: z.string().max(500),
    parentId: z.string().max(160).nullable(),
    publishedAt: z.string().datetime().nullable(),
    collectedAt: z.string().datetime(),
    source: z.enum(["hackernews", "import", "fixture"]),
    provenance: z.enum(["live", "imported", "synthetic"]),
  })
  .strict();
export type RawRecord = z.infer<typeof rawRecordSchema>;
export interface EvidenceRecord extends RawRecord {
  researchId: string;
  sessionId: string;
  snapshotVersion: number;
  contentHash: string;
  relevant: boolean;
  productIdentity: "match" | "ambiguous" | "other";
  aspects: AspectLabel[];
  analysisVersion: string;
  extractionStatus: "verified" | "unlabeled" | "failed";
  contextualText: string;
  embedding?: number[];
}
export const filtersSchema = z
  .object({
    excludedThreadIds: z.array(z.string().max(160)).max(150).default([]),
    aspect: z.enum(Aspects).nullable().default(null),
    source: z
      .enum(["hackernews", "import", "fixture"])
      .nullable()
      .default(null),
    from: z.string().datetime().nullable().default(null),
    to: z.string().datetime().nullable().default(null),
  })
  .strict();
export type Filters = z.infer<typeof filtersSchema>;
export const startSchema = z
  .object({
    product: z.string().trim().min(2).max(120),
    question: z.string().trim().min(3).max(1000),
    mode: z.enum(["fixture", "live", "import"]),
    idempotencyKey: z.string().min(8).max(120),
    records: z.array(rawRecordSchema).max(150).optional(),
  })
  .strict();
export type StartInput = z.infer<typeof startSchema>;
export const querySchema = z
  .object({
    researchId: z.string().uuid(),
    question: z.string().trim().min(1).max(1000),
    filters: filtersSchema,
    challenge: z.boolean().default(false),
    challengeSentiment: z.enum(["positive", "negative"]).default("negative"),
    requestId: z.string().min(1).max(100),
  })
  .strict();
export type QueryInput = z.infer<typeof querySchema>;
export const jobStates = [
  "queued",
  "collecting",
  "analyzing",
  "indexing",
  "ready",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof jobStates)[number];
export interface SourceAttempt {
  query: string;
  url: string | null;
  status: "success" | "failed" | "skipped";
  count: number;
  message?: string;
}
export interface ResearchJob {
  id: string;
  product: string;
  question: string;
  mode: StartInput["mode"];
  state: JobState;
  createdAt: string;
  updatedAt: string;
  collected: number;
  analyzed: number;
  indexed: number;
  duplicates: number;
  attempts: SourceAttempt[];
  failures: string[];
  partial: boolean;
  evidenceVersion: number;
}
export interface Metrics {
  collectedRecords: number;
  scopedRecords: number;
  relevantRecords: number;
  distinctThreads: number;
  aspectMentions: number;
  aspects: Array<{
    aspect: string;
    mentions: number;
    positive: number;
    negative: number;
    mixed: number;
    neutral: number;
    unknown: number;
  }>;
  threads: Array<{ threadId: string; title: string; count: number }>;
}
export interface Finding {
  id: string;
  aspect: string;
  text: string;
  evidenceIds: string[];
}
export interface EvidencePacket {
  researchId: string;
  snapshotVersion: number;
  scopeVersion: string;
  requestId: string;
  question: string;
  filters: Filters;
  challenge: boolean;
  retrievalMode: "bm25" | "hybrid";
  provenance: Array<RawRecord["provenance"]>;
  metrics: Metrics;
  findings: Finding[];
  evidence: EvidenceRecord[];
  opposingEvidence: EvidenceRecord[];
  limitations: string[];
  spokenSummary: string;
  generatedAt: string;
}
export type ProviderStatus = {
  status:
    | "missing"
    | "configured-but-unverified"
    | "verified"
    | "failed"
    | "disabled";
  detail: string;
};
export interface SessionResponse {
  csrfToken: string;
  providers: Record<string, ProviderStatus>;
  jobs: ResearchJob[];
  voiceAvailable: boolean;
  elasticAgentAvailable?: boolean;
}
export interface DecisionBrief {
  researchId: string;
  scopeVersion: string;
  filename: string;
  markdown: string;
}
export interface CollectionResult {
  records: RawRecord[];
  attempts: SourceAttempt[];
  failures: string[];
}
export interface CollectionOptions {
  maxThreads: number;
  maxItems: number;
  concurrency: number;
  signal: AbortSignal;
  onProgress?: (attempt: SourceAttempt) => void;
}
export interface AnalysisOptions {
  mode: "fixture" | "openai" | "unlabeled";
  model: string;
  apiKey?: string;
  signal: AbortSignal;
  onProgress?: (count: number) => void;
}
export interface AnalysisResult {
  records: EvidenceRecord[];
  duplicates: number;
  failures: string[];
}

// Uploaded Elastic corpus labels are retained as supplied, not marked verified.
export const elasticScopeSchema = z
  .object({
    excludedVideoIds: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{11}$/))
      .max(10)
      .default([]),
    from: z.string().datetime().nullable().default(null),
    to: z.string().datetime().nullable().default(null),
  })
  .strict();
export type ElasticScope = z.infer<typeof elasticScopeSchema>;
export const elasticQuerySchema = z
  .object({
    question: z.string().trim().min(3).max(2000),
    scope: elasticScopeSchema.default({
      excludedVideoIds: [],
      from: null,
      to: null,
    }),
    requestId: z.string().min(8).max(100),
  })
  .strict();
export type ElasticQueryInput = z.infer<typeof elasticQuerySchema>;
export interface ElasticComment {
  id: string;
  text: string;
  videoId: string;
  videoTitle: string;
  url: string;
  publishedAt: string | null;
  sentiment: string;
  isComplaint: boolean;
  categories: string[];
  likeCount: number;
}
export interface ElasticMetrics {
  totalRecords: number;
  scopedRecords: number;
  positive: number;
  negative: number;
  neutral: number;
  complaints: number;
  distinctVideos: number;
  firstPublished: string | null;
  lastPublished: string | null;
  videos: Array<{
    id: string;
    title: string;
    count: number;
    complaints: number;
  }>;
  categories: Array<{ name: string; count: number }>;
}
export interface ElasticAnswer {
  requestId: string;
  question: string;
  scope: ElasticScope;
  index: string;
  answer: string;
  metrics: ElasticMetrics;
  examples: ElasticComment[];
  toolCalls: Array<{ tool: string; query?: string }>;
  limitations: string[];
  generatedAt: string;
}
