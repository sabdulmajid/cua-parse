import { randomUUID } from "node:crypto";
import { Client } from "@elastic/elasticsearch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EvidenceStore } from "../src/server/elastic.js";
import {
  filtersSchema,
  type EvidenceRecord,
  type ResearchJob,
} from "../src/shared/contracts.js";

// This suite tests the real dense-vector index and kNN query with a deterministic
// embedding provider stub. It does not verify OpenAI credentials or model quality.
const provider = vi.hoisted(() => ({ fail: false }));
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return {
      embeddings: {
        create: async ({ input }: { input: string[] }) => {
          if (provider.fail)
            throw new Error("test embedding provider unavailable");
          return {
            data: input.map((text, index) => ({
              index,
              embedding: text.includes("affordable") ? [1, 0] : [0, 1],
            })),
          };
        },
      },
    };
  }),
}));
const url = process.env.ELASTICSEARCH_URL || "http://127.0.0.1:9200";
const apiKey = process.env.ELASTICSEARCH_API_KEY;
const index = `cua-parse-test-hybrid-${randomUUID()}`;
const client = new Client({
  node: url,
  ...(apiKey ? { auth: { apiKey } } : {}),
  requestTimeout: 10_000,
  maxRetries: 0,
});
const store = new EvidenceStore({
  url,
  apiKey,
  index,
  embedding: {
    apiKey: "test-placeholder",
    model: "text-embedding-3-small",
    dimensions: 2,
  },
});
const sessionId = randomUUID();
const researchId = randomUUID();
const timestamp = "2026-09-01T00:00:00.000Z";
const job: ResearchJob = {
  id: researchId,
  product: "AcmeFlow",
  question: "pricing",
  mode: "fixture",
  state: "ready",
  createdAt: timestamp,
  updatedAt: timestamp,
  collected: 2,
  analyzed: 2,
  indexed: 2,
  duplicates: 0,
  attempts: [],
  failures: [],
  partial: false,
  evidenceVersion: 1,
};
function record(
  id: string,
  sentiment: "positive" | "negative",
  owner: string = sessionId,
): EvidenceRecord {
  const text =
    sentiment === "positive"
      ? "Pricing is affordable."
      : "Pricing is too expensive.";
  return {
    id,
    sessionId: owner,
    researchId,
    snapshotVersion: 1,
    text,
    contextualText: text,
    threadId: id,
    threadTitle: id,
    parentId: null,
    url: null,
    publishedAt: timestamp,
    collectedAt: timestamp,
    source: "fixture",
    provenance: "synthetic",
    contentHash: id,
    relevant: true,
    productIdentity: "match",
    analysisVersion: "test-v1",
    extractionStatus: "verified",
    aspects: [{ aspect: "pricing", sentiment, quote: text }],
  };
}
const query = (excludedThreadIds: string[] = []) =>
  store.query(sessionId, job, {
    researchId,
    question: "affordable",
    filters: filtersSchema.parse({ aspect: "pricing", excludedThreadIds }),
    challenge: true,
    challengeSentiment: "negative",
    requestId: randomUUID(),
  });
beforeAll(async () => {
  await store.init();
  await store.ingest([
    record("positive", "positive"),
    record("negative", "negative"),
  ]);
  await store.ingest([record("foreign", "positive", "foreign-session")]);
}, 60_000);
afterAll(async () => {
  if (await client.indices.exists({ index }))
    await client.indices.delete({ index });
  await store.close();
  await client.close();
});
describe("real Elasticsearch kNN with a deterministic embedding stub", () => {
  it("combines keyword and vector retrieval while preserving session and nested challenge filters", async () => {
    const packet = await query();
    expect(packet.retrievalMode).toBe("hybrid");
    expect(packet.metrics.scopedRecords).toBe(2);
    expect(packet.evidence[0].id).toBe("positive");
    expect(packet.evidence.every((e) => e.sessionId === sessionId)).toBe(true);
    expect(packet.opposingEvidence.map((e) => e.id)).toEqual(["positive"]);
    expect(packet.evidence.every((e) => e.embedding === undefined)).toBe(true);
  });
  it("applies thread exclusions to vector candidates and exact metrics", async () => {
    const packet = await query(["positive"]);
    expect(packet.retrievalMode).toBe("hybrid");
    expect(packet.metrics.scopedRecords).toBe(1);
    expect(packet.evidence.map((e) => e.id)).toEqual(["negative"]);
    expect(packet.opposingEvidence).toEqual([]);
  });
  it("labels a failed query embedding as BM25 and still returns exact evidence", async () => {
    provider.fail = true;
    try {
      const packet = await query();
      expect(packet.retrievalMode).toBe("bm25");
      expect(packet.metrics.scopedRecords).toBe(2);
      expect(
        packet.limitations.some((s) =>
          s.includes("Semantic query embedding failed"),
        ),
      ).toBe(true);
      expect(packet.opposingEvidence.map((e) => e.id)).toEqual(["positive"]);
    } finally {
      provider.fail = false;
    }
  });
});
