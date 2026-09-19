import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvidenceStore,
  contraryQuery,
  diverseExamples,
  scopeQuery,
  validateMapping,
} from "../src/server/elastic.js";
import { filtersSchema, type EvidenceRecord } from "../src/shared/contracts.js";

const mock = vi.hoisted(() => ({
  bulk: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
  deleteByQuery: vi.fn(),
  embed: vi.fn(),
  info: vi.fn(),
  indices: { exists: vi.fn(), create: vi.fn(), getMapping: vi.fn() },
}));
vi.mock("@elastic/elasticsearch", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@elastic/elasticsearch")>();
  return {
    ...original,
    Client: vi.fn(function () {
      return mock;
    }),
  };
});
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { embeddings: { create: mock.embed } };
  }),
}));
const base: EvidenceRecord = {
  id: "one",
  sessionId: "session",
  researchId: "f559ecb9-b396-457b-b13d-27838e078e10",
  snapshotVersion: 1,
  text: "Pricing is fair. Support is slow.",
  contextualText: "Pricing is fair. Support is slow.",
  threadId: "thread-one",
  threadTitle: "A discussion",
  parentId: null,
  url: null,
  publishedAt: null,
  collectedAt: "2026-09-01T00:00:00.000Z",
  source: "fixture",
  provenance: "synthetic",
  contentHash: "hash",
  relevant: true,
  productIdentity: "match",
  analysisVersion: "fixture-v1",
  extractionStatus: "verified",
  aspects: [
    { aspect: "pricing", sentiment: "positive", quote: "Pricing is fair." },
    { aspect: "support", sentiment: "negative", quote: "Support is slow." },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.create.mockResolvedValue({});
  mock.bulk.mockResolvedValue({
    errors: false,
    items: [{ create: { status: 201 } }],
  });
});

describe("Elasticsearch scope and evidence safety", () => {
  it("uses explicit exclusions, source, dates, and a nested aspect filter", () => {
    const filters = filtersSchema.parse({
      excludedThreadIds: ["angry-thread"],
      aspect: "pricing",
      source: "fixture",
      from: "2026-01-01T00:00:00.000Z",
    });
    expect(scopeQuery(filters)).toEqual({
      bool: {
        filter: [
          { term: { source: "fixture" } },
          { range: { publishedAt: { gte: filters.from } } },
          {
            nested: {
              path: "aspects",
              query: { term: { "aspects.aspect": "pricing" } },
            },
          },
        ],
        must_not: [{ terms: { threadId: ["angry-thread"] } }],
      },
    });
  });
  it("pairs contrary sentiment with the same selected aspect", () => {
    expect(contraryQuery("pricing", "negative")).toEqual({
      nested: {
        path: "aspects",
        query: {
          bool: {
            filter: [
              { term: { "aspects.sentiment": "positive" } },
              { term: { "aspects.aspect": "pricing" } },
            ],
          },
        },
      },
    });
    expect(JSON.stringify(contraryQuery(null, "positive"))).toContain(
      "negative",
    );
  });
  it("selects several threads before filling remaining example slots", () => {
    const records = [0, 1, 2, 3, 4].map((id) => ({
      ...base,
      id: `${id}`,
      threadId: id < 4 ? "large" : "small",
    }));
    expect(diverseExamples(records, 3).map((r) => r.id)).toEqual([
      "0",
      "1",
      "4",
    ]);
  });
  it("rejects a flattened aspect mapping even when metadata matches", () => {
    const expected = {
      dynamic: "strict" as const,
      _meta: {
        schemaVersion: 1,
        embeddingModel: null,
        embeddingDimensions: null,
      },
      properties: {
        aspects: {
          type: "nested" as const,
          properties: { aspect: { type: "keyword" as const } },
        },
      },
    };
    expect(() =>
      validateMapping(
        { ...expected, properties: { aspects: { type: "object" } } },
        expected,
      ),
    ).toThrow("aspects");
    expect(() => validateMapping(expected, expected)).not.toThrow();
    expect(() =>
      validateMapping(
        {
          ...expected,
          _meta: { ...expected._meta, embeddingModel: "different" },
        },
        expected,
      ),
    ).toThrow("metadata");
  });
  it("refuses an invented quote before indexing anything", async () => {
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await expect(
      store.ingest([
        {
          ...base,
          aspects: [
            {
              aspect: "pricing",
              sentiment: "positive",
              quote: "Imaginary quote",
            },
          ],
        },
      ]),
    ).rejects.toThrow("exact span");
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("rejects mixed snapshots and duplicate IDs before indexing", async () => {
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await expect(
      store.ingest([base, { ...base, id: "two", sessionId: "another" }]),
    ).rejects.toThrow("one complete");
    await expect(store.ingest([base, base])).rejects.toThrow("Duplicate");
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("checks every bulk item even when the top-level error flag is false", async () => {
    mock.bulk.mockResolvedValue({
      errors: false,
      items: [
        {
          create: { status: 400, error: { type: "mapper_parsing_exception" } },
        },
      ],
    });
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await expect(store.ingest([base])).rejects.toThrow("bulk ingest failed");
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it("does not write records after the immutable snapshot seal conflicts", async () => {
    mock.create.mockRejectedValue(new Error("version conflict"));
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await expect(store.ingest([base])).rejects.toThrow("version conflict");
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("never sends imported vectors to the index in BM25 mode", async () => {
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await store.ingest([{ ...base, embedding: [1, 0] }]);
    expect(mock.bulk.mock.calls[0][0].operations[1].embedding).toBeUndefined();
  });
  it("rejects malformed embedding responses before sealing or indexing the snapshot", async () => {
    mock.embed.mockResolvedValue({ data: [{ index: 0, embedding: [1] }] });
    const store = new EvidenceStore({
      url: "http://127.0.0.1:9200",
      embedding: {
        apiKey: "test-placeholder",
        model: "text-embedding-3-small",
        dimensions: 2,
      },
    });
    await expect(store.ingest([base])).rejects.toThrow("dimension");
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("generates configured vectors and sends model metadata with indexed evidence", async () => {
    mock.embed.mockResolvedValue({ data: [{ index: 0, embedding: [1, 0] }] });
    const store = new EvidenceStore({
      url: "http://127.0.0.1:9200",
      embedding: {
        apiKey: "test-placeholder",
        model: "text-embedding-3-small",
        dimensions: 2,
      },
    });
    await store.ingest([base]);
    expect(mock.embed.mock.calls[0][0]).toMatchObject({
      model: "text-embedding-3-small",
      dimensions: 2,
      encoding_format: "float",
    });
    expect(mock.bulk.mock.calls[0][0].operations[1]).toMatchObject({
      embedding: [1, 0],
      embeddingModel: "text-embedding-3-small",
    });
  });
  it("propagates a failed embedding call without creating a partial snapshot", async () => {
    mock.embed.mockRejectedValue(new Error("provider timeout"));
    const store = new EvidenceStore({
      url: "http://127.0.0.1:9200",
      embedding: {
        apiKey: "test-placeholder",
        model: "text-embedding-3-small",
        dimensions: 2,
      },
    });
    await expect(store.ingest([base])).rejects.toThrow("provider timeout");
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("limits deletion to the owning session and research", async () => {
    mock.deleteByQuery.mockResolvedValue({
      failures: [],
      version_conflicts: 0,
    });
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await store.deleteResearch("session", base.researchId);
    expect(mock.deleteByQuery.mock.calls[0][0].query).toEqual({
      bool: {
        filter: [
          { term: { sessionId: "session" } },
          { term: { researchId: base.researchId } },
        ],
      },
    });
  });
});

describe("Elasticsearch and embedding cancellation", () => {
  const embedding = {
    apiKey: "test-placeholder",
    model: "text-embedding-3-small",
    dimensions: 2,
  };
  it("does not start any request when already cancelled", async () => {
    const control = new AbortController();
    control.abort(new Error("cancelled before start"));
    const store = new EvidenceStore({
      url: "http://127.0.0.1:9200",
      embedding,
    });
    await expect(store.init(control.signal)).rejects.toThrow(
      "cancelled before start",
    );
    await expect(store.ingest([base], control.signal)).rejects.toThrow(
      "cancelled before start",
    );
    expect(mock.info).not.toHaveBeenCalled();
    expect(mock.embed).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("forwards cancellation to an in-flight Elasticsearch initialization request", async () => {
    const control = new AbortController();
    mock.info.mockImplementation(
      (_params, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          expect(options.signal).toBe(control.signal);
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    const pending = store.init(control.signal);
    control.abort(new Error("cancelled during init"));
    await expect(pending).rejects.toThrow("cancelled during init");
    expect(mock.indices.exists).not.toHaveBeenCalled();
  });
  it("stops index creation if cancellation arrives after the existence request", async () => {
    const control = new AbortController();
    mock.info.mockResolvedValue({ version: { number: "8.19.13" } });
    mock.indices.exists.mockImplementation(
      async (_params, options: { signal: AbortSignal }) => {
        expect(options.signal).toBe(control.signal);
        control.abort(new Error("cancelled before index creation"));
        return false;
      },
    );
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await expect(store.init(control.signal)).rejects.toThrow(
      "cancelled before index creation",
    );
    expect(mock.indices.create).not.toHaveBeenCalled();
    expect(mock.indices.getMapping).not.toHaveBeenCalled();
  });
  it("forwards cancellation to a pending embedding request and makes no writes", async () => {
    const control = new AbortController();
    mock.embed.mockImplementation(
      (_params, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          expect(options.signal).toBe(control.signal);
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    const store = new EvidenceStore({
      url: "http://127.0.0.1:9200",
      embedding,
    });
    const pending = store.ingest([base], control.signal);
    control.abort(new Error("cancelled during embedding"));
    await expect(pending).rejects.toThrow("cancelled during embedding");
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("never starts a later embedding batch after cancellation", async () => {
    const control = new AbortController();
    mock.embed.mockImplementation(async ({ input }: { input: string[] }) => {
      control.abort(new Error("cancelled between batches"));
      return {
        data: input.map((_text, index) => ({ index, embedding: [1, 0] })),
      };
    });
    const store = new EvidenceStore({
      url: "http://127.0.0.1:9200",
      embedding,
    });
    await expect(
      store.ingest(
        Array.from({ length: 21 }, (_, i) => ({ ...base, id: `item-${i}` })),
        control.signal,
      ),
    ).rejects.toThrow("cancelled between batches");
    expect(mock.embed).toHaveBeenCalledTimes(1);
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("never starts bulk indexing when cancellation arrives after sealing", async () => {
    const control = new AbortController();
    mock.create.mockImplementation(
      async (_params, options: { signal: AbortSignal }) => {
        expect(options.signal).toBe(control.signal);
        control.abort(new Error("cancelled before bulk"));
        return {};
      },
    );
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await expect(store.ingest([base], control.signal)).rejects.toThrow(
      "cancelled before bulk",
    );
    expect(mock.bulk).not.toHaveBeenCalled();
  });
  it("forwards cancellation to the bulk request", async () => {
    const control = new AbortController();
    mock.bulk.mockImplementation(
      (_params, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          expect(options.signal).toBe(control.signal);
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
          control.abort(new Error("cancelled during bulk"));
        }),
    );
    const store = new EvidenceStore({ url: "http://127.0.0.1:9200" });
    await expect(store.ingest([base], control.signal)).rejects.toThrow(
      "cancelled during bulk",
    );
  });
});
