import { createHash } from "node:crypto";
import { Client, errors, type estypes } from "@elastic/elasticsearch";
import OpenAI from "openai";
import {
  Aspects,
  Sentiments,
  aspectSchema,
  querySchema,
  type EvidenceRecord,
  type EvidencePacket,
  type ResearchJob,
  type QueryInput,
  type Filters,
  type Metrics,
  type ProviderStatus,
} from "../shared/contracts.js";

import { questionSentiment, sourceFindings } from "./findings.js";

const MAX_RECORDS = 150;
const EXAMPLES = 12;
const SCHEMA_VERSION = 1;
type Query = estypes.QueryDslQueryContainer;
type Aggregation = estypes.AggregationsAggregationContainer;
interface StoreOptions {
  url: string;
  apiKey?: string;
  index?: string;
  embedding?: { apiKey: string; model: string; dimensions: number };
}
interface Count {
  doc_count: number;
}
interface Hits {
  hits: { hits: Array<{ _source?: EvidenceRecord }> };
}
interface AspectBucket extends Count {
  sentiments: { buckets: Record<string, Count> };
  originals: Count & { example: Hits };
}
interface ScopeAggregation extends Count {
  relevant: Count & {
    labels: Count & {
      selected: Count & { aspects: { buckets: Record<string, AspectBucket> } };
    };
  };
  threads: {
    sum_other_doc_count: number;
    buckets: Array<Count & { key: string; title: Hits }>;
  };
  provenance: { buckets: Array<Count & { key: EvidenceRecord["provenance"] }> };
  unlabeled: Count;
  missingDates: Count;
  embedded: Count;
}
interface Analytics {
  scope: ScopeAggregation;
}
const sourceConfig = {
  excludes: ["embedding", "recordKind", "embeddingModel"],
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function mappings(
  embedding?: StoreOptions["embedding"],
): estypes.MappingTypeMapping {
  const properties: Record<string, estypes.MappingProperty> = {
    recordKind: { type: "keyword" },
    id: { type: "keyword" },
    sessionId: { type: "keyword" },
    researchId: { type: "keyword" },
    snapshotVersion: { type: "integer" },
    text: { type: "text" },
    contextualText: { type: "text" },
    url: { type: "keyword", index: false },
    threadId: { type: "keyword" },
    threadTitle: { type: "text" },
    parentId: { type: "keyword" },
    publishedAt: { type: "date" },
    collectedAt: { type: "date" },
    source: { type: "keyword" },
    provenance: { type: "keyword" },
    contentHash: { type: "keyword" },
    relevant: { type: "boolean" },
    productIdentity: { type: "keyword" },
    analysisVersion: { type: "keyword" },
    extractionStatus: { type: "keyword" },
    aspects: {
      type: "nested",
      properties: {
        aspect: { type: "keyword" },
        sentiment: { type: "keyword" },
        quote: { type: "text", index: false },
      },
    },
  };
  if (embedding) {
    properties.embedding = {
      type: "dense_vector",
      dims: embedding.dimensions,
      index: true,
      similarity: "cosine",
    };
    properties.embeddingModel = { type: "keyword" };
  }
  return {
    dynamic: "strict",
    _meta: {
      schemaVersion: SCHEMA_VERSION,
      embeddingModel: embedding?.model ?? null,
      embeddingDimensions: embedding?.dimensions ?? null,
    },
    properties,
  };
}

/** Fail closed on incompatible existing indices; never replace someone else's index. */
export function validateMapping(
  actual: estypes.MappingTypeMapping,
  expected: estypes.MappingTypeMapping,
): void {
  if (
    actual.dynamic !== "strict" ||
    actual._source?.enabled === false ||
    actual._meta?.schemaVersion !== expected._meta?.schemaVersion ||
    actual._meta?.embeddingModel !== expected._meta?.embeddingModel ||
    actual._meta?.embeddingDimensions !== expected._meta?.embeddingDimensions
  ) {
    throw new Error(
      "Elasticsearch mapping metadata differs. Use a dedicated index with the expected schema and embedding model.",
    );
  }
  const check = (
    found: Record<string, estypes.MappingProperty>,
    required: Record<string, estypes.MappingProperty>,
    prefix = "",
  ) => {
    for (const [key, expectedProperty] of Object.entries(required)) {
      const property = found[key];
      if (!property || property.type !== expectedProperty.type)
        throw new Error(`Incompatible Elasticsearch field: ${prefix}${key}`);
      if (
        expectedProperty.type === "dense_vector" &&
        property.type === "dense_vector" &&
        (property.dims !== expectedProperty.dims ||
          property.index !== true ||
          property.similarity !== "cosine")
      ) {
        throw new Error(
          "Elasticsearch embedding dimensions or similarity differ.",
        );
      }
      if ("properties" in expectedProperty && expectedProperty.properties) {
        check(
          ("properties" in property && property.properties) || {},
          expectedProperty.properties,
          `${prefix}${key}.`,
        );
      }
    }
  };
  check(actual.properties ?? {}, expected.properties ?? {});
}

function snapshotQuery(
  sessionId: string,
  researchId: string,
  version: number,
): Query {
  return {
    bool: {
      filter: [
        { term: { recordKind: "evidence" } },
        { term: { sessionId } },
        { term: { researchId } },
        { term: { snapshotVersion: version } },
      ],
    },
  };
}

export function scopeQuery(filters: Filters): Query {
  const filter: Query[] = [];
  if (filters.source) filter.push({ term: { source: filters.source } });
  if (filters.from || filters.to)
    filter.push({
      range: {
        publishedAt: {
          ...(filters.from ? { gte: filters.from } : {}),
          ...(filters.to ? { lte: filters.to } : {}),
        },
      },
    });
  if (filters.aspect)
    filter.push({
      nested: {
        path: "aspects",
        query: { term: { "aspects.aspect": filters.aspect } },
      },
    });
  return {
    bool: {
      filter,
      must_not: filters.excludedThreadIds.length
        ? [{ terms: { threadId: filters.excludedThreadIds } }]
        : [],
    },
  };
}

/** Aspect and sentiment must match one nested label, not two unrelated labels. */
export function contraryQuery(
  aspect: Filters["aspect"],
  sentiment: "positive" | "negative",
): Query {
  return {
    nested: {
      path: "aspects",
      query: {
        bool: {
          filter: [
            {
              term: {
                "aspects.sentiment":
                  sentiment === "negative" ? "positive" : "negative",
              },
            },
            ...(aspect ? [{ term: { "aspects.aspect": aspect } }] : []),
          ],
        },
      },
    },
  };
}

function analytics(filters: Filters): Record<string, Aggregation> {
  const sentimentFilters = Object.fromEntries(
    Sentiments.map((s) => [s, { term: { "aspects.sentiment": s } }]),
  );
  return {
    scope: {
      filter: scopeQuery(filters),
      aggs: {
        relevant: {
          filter: { term: { relevant: true } },
          aggs: {
            labels: {
              nested: { path: "aspects" },
              aggs: {
                selected: {
                  filter: filters.aspect
                    ? { term: { "aspects.aspect": filters.aspect } }
                    : { match_all: {} },
                  aggs: {
                    aspects: {
                      filters: {
                        filters: Object.fromEntries(
                          Aspects.map((a) => [
                            a,
                            { term: { "aspects.aspect": a } },
                          ]),
                        ),
                      },
                      aggs: {
                        sentiments: { filters: { filters: sentimentFilters } },
                        originals: {
                          reverse_nested: {},
                          aggs: {
                            example: {
                              top_hits: {
                                size: 1,
                                sort: [{ id: "asc" }],
                                _source: sourceConfig,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        threads: {
          terms: {
            field: "threadId",
            size: MAX_RECORDS,
            shard_size: MAX_RECORDS,
            order: { _key: "asc" },
          },
          aggs: {
            title: {
              top_hits: {
                size: 1,
                sort: [{ id: "asc" }],
                _source: ["threadTitle"],
              },
            },
          },
        },
        provenance: {
          terms: { field: "provenance", size: 3, order: { _key: "asc" } },
        },
        unlabeled: {
          filter: {
            bool: { must_not: [{ term: { extractionStatus: "verified" } }] },
          },
        },
        missingDates: {
          filter: {
            bool: { must_not: [{ exists: { field: "publishedAt" } }] },
          },
        },
        embedded: { filter: { exists: { field: "embeddingModel" } } },
      },
    },
  };
}

function readHits(value: Hits): EvidenceRecord[] {
  return value.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
}

/** Two examples per thread first; fill any remaining places by rank. */
export function diverseExamples(
  records: EvidenceRecord[],
  size = EXAMPLES,
): EvidenceRecord[] {
  const selected: EvidenceRecord[] = [];
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const cap of [2, size]) {
    for (const record of records) {
      if (selected.length >= size) return selected;
      if (ids.has(record.id) || (counts.get(record.threadId) ?? 0) >= cap)
        continue;
      ids.add(record.id);
      counts.set(record.threadId, (counts.get(record.threadId) ?? 0) + 1);
      selected.push(record);
    }
  }
  return selected;
}

/** Reciprocal rank fusion combines real lexical and semantic result lists. */
function fuse(
  lexical: EvidenceRecord[],
  semantic: EvidenceRecord[],
): EvidenceRecord[] {
  const ranked = new Map<string, { record: EvidenceRecord; score: number }>();
  for (const records of [lexical, semantic])
    records.forEach((record, i) => {
      const prior = ranked.get(record.id);
      ranked.set(record.id, {
        record,
        score: (prior?.score ?? 0) + 1 / (60 + i + 1),
      });
    });
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .map((item) => item.record);
}

export class EvidenceStore {
  private readonly client: Client;
  private readonly index: string;
  private readonly options: StoreOptions;
  private readonly openai?: OpenAI;

  constructor(options: StoreOptions) {
    this.options = options;
    this.index = options.index ?? "cua-parse-evidence-v1";
    if (!/^[a-z0-9][a-z0-9_-]{0,200}$/.test(this.index))
      throw new Error("Use one explicit Elasticsearch index name.");
    if (
      options.embedding &&
      (!Number.isInteger(options.embedding.dimensions) ||
        options.embedding.dimensions < 1 ||
        options.embedding.dimensions > 3072)
    ) {
      throw new Error(
        "Embedding dimensions must be an integer between 1 and 3072.",
      );
    }
    this.client = new Client({
      node: options.url,
      ...(options.apiKey ? { auth: { apiKey: options.apiKey } } : {}),
      requestTimeout: 15_000,
      maxRetries: 1,
    });
    if (options.embedding)
      this.openai = new OpenAI({
        apiKey: options.embedding.apiKey,
        timeout: 20_000,
        maxRetries: 1,
      });
  }

  async init(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const info = await this.client.info({}, { signal });
    signal?.throwIfAborted();
    if (!info.version.number.startsWith("8.19."))
      throw new Error(
        "This build requires Elasticsearch 8.19.x; the local image is pinned to 8.19.13.",
      );
    const expected = mappings(this.options.embedding);
    const exists = await this.client.indices.exists(
      { index: this.index },
      { signal },
    );
    signal?.throwIfAborted();
    if (!exists) {
      try {
        await this.client.indices.create(
          {
            index: this.index,
            settings: { number_of_shards: 1, number_of_replicas: 0 },
            mappings: expected,
          },
          { signal },
        );
      } catch (error) {
        if (
          !(error instanceof errors.ResponseError) ||
          error.body?.error?.type !== "resource_already_exists_exception"
        )
          throw error;
      }
    }
    signal?.throwIfAborted();
    const result = await this.client.indices.getMapping(
      { index: this.index },
      { signal },
    );
    signal?.throwIfAborted();
    if (!result[this.index])
      throw new Error(
        "Elasticsearch index aliases are not supported. Use a dedicated concrete index.",
      );
    validateMapping(result[this.index].mappings, expected);
  }

  async probe(): Promise<ProviderStatus> {
    try {
      await this.init();
      return {
        status: "verified",
        detail:
          "Elasticsearch 8.19 connection and dedicated index mapping verified.",
      };
    } catch {
      return {
        status: "failed",
        detail:
          "Elasticsearch connection or mapping check failed. Run npm run setup for details.",
      };
    }
  }

  private async embed(
    input: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    signal?.throwIfAborted();
    const config = this.options.embedding;
    if (!config || !this.openai)
      throw new Error("Embeddings are not configured.");
    // Limit each input by UTF-8 bytes, a conservative upper bound on byte-level tokens.
    const bounded = input.map((text) => {
      let end = Math.min(text.length, 6000);
      while (Buffer.byteLength(text.slice(0, end), "utf8") > 6000) end -= 100;
      return text.slice(0, end);
    });
    const result = await this.openai.embeddings.create(
      {
        model: config.model,
        dimensions: config.dimensions,
        input: bounded,
        encoding_format: "float",
      },
      { signal },
    );
    signal?.throwIfAborted();
    const vectors = [...result.data].sort((a, b) => a.index - b.index);
    if (
      vectors.length !== input.length ||
      vectors.some(
        (v, i) =>
          v.index !== i ||
          v.embedding.length !== config.dimensions ||
          v.embedding.some((n) => !Number.isFinite(n)),
      )
    ) {
      throw new Error("Embedding response has an invalid count or dimension.");
    }
    return vectors.map((v) => v.embedding);
  }

  async ingest(records: EvidenceRecord[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!records.length) return;
    if (records.length > MAX_RECORDS)
      throw new Error("A research snapshot can contain at most 150 records.");
    const first = records[0];
    const identity = [first.sessionId, first.researchId, first.snapshotVersion];
    const ids = new Set<string>();
    for (const record of records) {
      if (
        record.sessionId !== first.sessionId ||
        record.researchId !== first.researchId ||
        record.snapshotVersion !== first.snapshotVersion
      )
        throw new Error("Ingest requires one complete research snapshot.");
      if (ids.has(record.id))
        throw new Error("Duplicate evidence ID in snapshot.");
      ids.add(record.id);
      if (!record.text.trim() || record.text.length > 20_000)
        throw new Error("Invalid evidence text.");
      for (const label of record.aspects) {
        aspectSchema.parse(label);
        if (!record.text.includes(label.quote))
          throw new Error(
            "An evidence quote is not an exact span of the original text.",
          );
      }
      if (record.provenance === "synthetic" && record.url !== null)
        throw new Error("Synthetic evidence cannot have a source URL.");
      if (
        record.url &&
        !["http:", "https:"].includes(new URL(record.url).protocol)
      )
        throw new Error("Unsafe evidence URL.");
    }
    const documents = records.map((record) => {
      const copy = {
        ...record,
        recordKind: "evidence" as const,
        embedding: undefined as number[] | undefined,
        embeddingModel: undefined as string | undefined,
      };
      return copy;
    });
    if (this.options.embedding) {
      // Bounded batches keep the maximum token count below the provider limit.
      for (let start = 0; start < documents.length; start += 20) {
        signal?.throwIfAborted();
        const batch = documents.slice(start, start + 20);
        const vectors = await this.embed(
          batch.map((record) => record.contextualText || record.text),
          signal,
        );
        batch.forEach((record, i) => {
          record.embedding = vectors[i];
          record.embeddingModel = this.options.embedding?.model;
        });
      }
    }
    // A create-only seal prevents later appends or overwrites, including concurrent ingest attempts.
    signal?.throwIfAborted();
    await this.client.create(
      {
        index: this.index,
        id: `snapshot-${digest(identity)}`,
        document: {
          recordKind: "snapshot",
          sessionId: first.sessionId,
          researchId: first.researchId,
          snapshotVersion: first.snapshotVersion,
        },
      },
      { signal },
    );
    signal?.throwIfAborted();
    const operations = documents.flatMap((record) => [
      { create: { _index: this.index, _id: digest([...identity, record.id]) } },
      record,
    ]);
    signal?.throwIfAborted();
    const result = await this.client.bulk(
      { operations, refresh: "wait_for" },
      { signal },
    );
    signal?.throwIfAborted();
    const failures = result.items.flatMap((item) => {
      const value = item.create;
      return !value || value.status >= 300 || value.error
        ? [value?.status ?? 500]
        : [];
    });
    if (
      result.errors ||
      failures.length ||
      result.items.length !== records.length
    ) {
      throw new Error(
        `Elasticsearch bulk ingest failed for ${failures.length || 1} records. The snapshot must not be marked ready.`,
      );
    }
  }

  private async ranked(
    query: Query,
    question: string,
    vector?: number[],
  ): Promise<EvidenceRecord[]> {
    const lexical = await this.client.search<EvidenceRecord>({
      index: this.index,
      size: MAX_RECORDS,
      allow_partial_search_results: false,
      _source: sourceConfig,
      query: {
        bool: {
          filter: [query],
          should: [
            {
              multi_match: {
                query: question,
                fields: ["text^3", "contextualText^2", "threadTitle"],
                type: "best_fields",
              },
            },
          ],
          minimum_should_match: 0,
        },
      },
      sort: [{ _score: { order: "desc" } }, { id: "asc" }],
    });
    if (lexical.timed_out || lexical._shards.failed)
      throw new Error("Elasticsearch example retrieval was incomplete.");
    const lexicalRecords = readHits(lexical);
    if (!vector) return diverseExamples(lexicalRecords);
    const semantic = await this.client.search<EvidenceRecord>({
      index: this.index,
      size: MAX_RECORDS,
      allow_partial_search_results: false,
      _source: sourceConfig,
      knn: {
        field: "embedding",
        query_vector: vector,
        k: MAX_RECORDS,
        num_candidates: MAX_RECORDS,
        filter: query,
      },
    });
    if (semantic.timed_out || semantic._shards.failed)
      throw new Error("Elasticsearch semantic retrieval was incomplete.");
    return diverseExamples(fuse(lexicalRecords, readHits(semantic)));
  }

  async query(
    sessionId: string,
    job: ResearchJob,
    rawInput: QueryInput,
  ): Promise<EvidencePacket> {
    const input = querySchema.parse(rawInput);
    if (input.researchId !== job.id || job.state !== "ready")
      throw new Error("Research is not ready for this query.");
    const filters: Filters = {
      ...input.filters,
      excludedThreadIds: [...new Set(input.filters.excludedThreadIds)].sort(),
      from: input.filters.from
        ? new Date(input.filters.from).toISOString()
        : null,
      to: input.filters.to ? new Date(input.filters.to).toISOString() : null,
    };
    if (filters.from && filters.to && filters.from > filters.to)
      throw new Error("The start date must not be after the end date.");
    const snapshot = snapshotQuery(sessionId, job.id, job.evidenceVersion);
    const result = await this.client.search<EvidenceRecord, Analytics>({
      index: this.index,
      size: 0,
      query: snapshot,
      track_total_hits: true,
      allow_partial_search_results: false,
      aggs: analytics(filters),
    });
    if (result.timed_out || result._shards.failed || !result.aggregations)
      throw new Error("Elasticsearch scope aggregation was incomplete.");
    const total = result.hits.total;
    if (
      !total ||
      typeof total === "number" ||
      total.relation !== "eq" ||
      total.value > MAX_RECORDS
    )
      throw new Error(
        "Elasticsearch did not return an exact bounded snapshot count.",
      );
    if (
      !Number.isSafeInteger(job.indexed) ||
      job.indexed < 0 ||
      total.value !== job.indexed
    )
      throw Object.assign(
        new Error(
          "Stored evidence no longer matches the completed research snapshot. Start a new research job.",
        ),
        { status: 409 },
      );
    const scoped = result.aggregations.scope;
    if (scoped.threads.sum_other_doc_count !== 0)
      throw new Error("Elasticsearch thread distribution was truncated.");
    const aspectBuckets = scoped.relevant.labels.selected.aspects.buckets;
    const aspectCounts: Metrics["aspects"] = Aspects.map((aspect) => {
      const bucket = aspectBuckets[aspect];
      return {
        aspect,
        mentions: bucket.doc_count,
        positive: bucket.sentiments.buckets.positive.doc_count,
        negative: bucket.sentiments.buckets.negative.doc_count,
        mixed: bucket.sentiments.buckets.mixed.doc_count,
        neutral: bucket.sentiments.buckets.neutral.doc_count,
        unknown: bucket.sentiments.buckets.unknown.doc_count,
      };
    })
      .filter((a) => a.mentions > 0)
      .sort(
        (a, b) =>
          b.negative - a.negative ||
          b.mentions - a.mentions ||
          a.aspect.localeCompare(b.aspect),
      );
    const metrics: Metrics = {
      collectedRecords: total.value,
      scopedRecords: scoped.doc_count,
      relevantRecords: scoped.relevant.doc_count,
      distinctThreads: scoped.threads.buckets.length,
      aspectMentions: scoped.relevant.labels.selected.doc_count,
      aspects: aspectCounts,
      threads: scoped.threads.buckets
        .map((bucket) => ({
          threadId: bucket.key,
          title: bucket.title.hits.hits[0]?._source?.threadTitle || bucket.key,
          count: bucket.doc_count,
        }))
        .sort(
          (a, b) => b.count - a.count || a.threadId.localeCompare(b.threadId),
        ),
    };
    const limitations = [
      "Counts describe this collected sample, not the market or verified customers.",
      "Scoped records and thread counts include irrelevant records. Aspect mentions count labels on relevant records; one record can mention several aspects.",
      "Examples are selected by relevance and thread diversity. Counts use all records in the selected scope.",
    ];
    const provenance = scoped.provenance.buckets.map((bucket) => bucket.key);
    if (provenance.includes("live"))
      limitations.push(
        "Public comments describe reports at their publication dates. Historical reports do not establish current product behavior.",
      );
    if (provenance.includes("synthetic"))
      limitations.push("This scope includes synthetic demonstration evidence.");
    if (scoped.unlabeled.doc_count)
      limitations.push(
        `${scoped.unlabeled.doc_count} scoped records have unverified or unavailable aspect labels. Unlabeled original examples have unknown relevance and sentiment and do not support findings.`,
      );
    if (scoped.missingDates.doc_count)
      limitations.push(
        `${scoped.missingDates.doc_count} scoped records have no publication date.`,
      );
    if (filters.from || filters.to)
      limitations.push(
        "Date filters exclude records without a publication date.",
      );
    if (job.partial)
      limitations.push(
        "Collection or analysis was partial. Inspect research failures and attempted sources.",
      );
    let vector: number[] | undefined;
    if (
      this.options.embedding &&
      scoped.doc_count &&
      scoped.embedded.doc_count === scoped.doc_count
    ) {
      try {
        [vector] = await this.embed([input.question]);
      } catch {
        limitations.push(
          "Semantic query embedding failed. These examples use BM25 keyword ranking.",
        );
      }
    } else if (this.options.embedding && scoped.doc_count) {
      limitations.push(
        "This snapshot does not have complete embeddings. These examples use BM25 keyword ranking.",
      );
    }
    if (!this.options.embedding)
      limitations.push(
        "Semantic retrieval is not configured. BM25 keyword ranking is active.",
      );
    if (vector)
      limitations.push(
        "Semantic ranking uses the first 6000 UTF-8 bytes of each contextual record. Original evidence remains complete.",
      );
    const scopedQuery: Query = {
      bool: {
        filter: [snapshot, scopeQuery(filters), { term: { relevant: true } }],
      },
    };
    // Retain inspectable originals when model analysis is unavailable. They do
    // not enter relevant-record aggregations, findings, or contrary retrieval.
    const originalQuery: Query = {
      bool: {
        filter: [snapshot, scopeQuery(filters)],
        should: [
          { term: { relevant: true } },
          { terms: { extractionStatus: ["unlabeled", "failed"] } },
        ],
        minimum_should_match: 1,
      },
    };
    let evidence: EvidenceRecord[];
    let opposingEvidence: EvidenceRecord[];
    let focusedEvidence: EvidenceRecord[];
    const focus = questionSentiment(input.question);
    const retrieve = async (v?: number[]) =>
      Promise.all([
        this.ranked(originalQuery, input.question, v),
        input.challenge
          ? this.ranked(
              {
                bool: {
                  filter: [
                    scopedQuery,
                    contraryQuery(filters.aspect, input.challengeSentiment),
                  ],
                },
              },
              input.question,
              v,
            )
          : Promise.resolve([] as EvidenceRecord[]),
        !input.challenge && focus
          ? this.ranked(
              {
                bool: {
                  filter: [
                    scopedQuery,
                    {
                      nested: {
                        path: "aspects",
                        query: {
                          bool: {
                            filter: [
                              {
                                terms: {
                                  "aspects.sentiment": [focus, "mixed"],
                                },
                              },
                              ...(filters.aspect
                                ? [
                                    {
                                      term: {
                                        "aspects.aspect": filters.aspect,
                                      },
                                    },
                                  ]
                                : []),
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
              input.question,
              v,
            )
          : Promise.resolve([] as EvidenceRecord[]),
      ]);
    try {
      [evidence, opposingEvidence, focusedEvidence] = await retrieve(vector);
    } catch (error) {
      if (!vector) throw error;
      vector = undefined;
      limitations.push(
        "Semantic search was unavailable. These examples use BM25 keyword ranking.",
      );
      [evidence, opposingEvidence, focusedEvidence] = await retrieve();
    }
    // Include an exact stored example for each aggregate finding, even if top-ranked examples omit that aspect.
    const byId = new Map(
      [...evidence, ...focusedEvidence].map((record) => [record.id, record]),
    );
    for (const aspect of aspectCounts)
      for (const record of readHits(
        aspectBuckets[aspect.aspect].originals.example,
      ))
        byId.set(record.id, record);
    evidence = [...byId.values()];
    const scopeVersion = digest({
      researchId: job.id,
      version: job.evidenceVersion,
      filters,
    }).slice(0, 24);
    const findings = sourceFindings(
      input.challenge ? opposingEvidence : [...focusedEvidence, ...evidence],
      input,
      scopeVersion,
    );
    const contrary =
      input.challengeSentiment === "negative" ? "positive" : "negative";
    const largestThread = metrics.threads[0];
    const concentration =
      largestThread && largestThread.count > metrics.scopedRecords / 2
        ? ` One discussion supplies ${largestThread.count} of the ${metrics.scopedRecords} records.`
        : "";
    const subjects = [
      ...new Set(findings.map((finding) => finding.aspect)),
    ].join(", ");
    const answer = input.challenge
      ? findings.length
        ? `The opposing examples concern ${subjects}. Read the source quotes below.`
        : `No ${contrary} opposing evidence was found in this scope. This does not prove the conclusion.`
      : findings.length
        ? `${focus === "negative" ? "The complaints in this sample concern" : focus === "positive" ? "The praise in this sample concerns" : "The feedback in this sample concerns"} ${subjects}. The source quotes below show the specific issues.`
        : focus
          ? `No verified ${focus} feedback was found in this sample. This does not mean none exists.`
          : "No verified feedback was found in this sample. Original records remain available below.";
    const summary = `${answer} Based on ${metrics.relevantRecords} relevant records across a sample of ${metrics.distinctThreads} discussions.${concentration}`;
    return {
      researchId: job.id,
      snapshotVersion: job.evidenceVersion,
      scopeVersion,
      requestId: input.requestId,
      question: input.question,
      filters,
      challenge: input.challenge,
      retrievalMode: vector ? "hybrid" : "bm25",
      provenance,
      metrics,
      findings,
      evidence,
      opposingEvidence,
      limitations,
      spokenSummary: `${provenance.includes("synthetic") ? "This is a synthetic demonstration sample. " : ""}${summary} These findings describe the collected sample only.`,
      generatedAt: new Date().toISOString(),
    };
  }

  async deleteResearch(sessionId: string, researchId: string): Promise<void> {
    const result = await this.client.deleteByQuery({
      index: this.index,
      refresh: true,
      conflicts: "proceed",
      query: {
        bool: { filter: [{ term: { sessionId } }, { term: { researchId } }] },
      },
    });
    if (result.failures?.length || result.version_conflicts)
      throw new Error("Research deletion was incomplete.");
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
