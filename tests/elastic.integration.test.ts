import { randomUUID } from "node:crypto";
import { Client } from "@elastic/elasticsearch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/server/elastic.js";
import {
  filtersSchema,
  type EvidenceRecord,
  type QueryInput,
  type ResearchJob,
} from "../src/shared/contracts.js";

const url = process.env.ELASTICSEARCH_URL || "http://127.0.0.1:9200";
const apiKey = process.env.ELASTICSEARCH_API_KEY;
const index = `cua-parse-test-${randomUUID()}`;
const client = new Client({
  node: url,
  ...(apiKey ? { auth: { apiKey } } : {}),
  requestTimeout: 10_000,
  maxRetries: 0,
});
const store = new EvidenceStore({ url, apiKey, index });
const researchId = randomUUID();
const session = randomUUID();
const timestamp = "2026-09-01T00:00:00.000Z";
const job: ResearchJob = {
  id: researchId,
  product: "AcmeFlow",
  question: "pricing",
  mode: "fixture",
  state: "ready",
  createdAt: timestamp,
  updatedAt: timestamp,
  collected: 20,
  analyzed: 20,
  indexed: 20,
  duplicates: 0,
  attempts: [],
  failures: [],
  partial: false,
  evidenceVersion: 1,
};
function record(
  id: string,
  threadId: string,
  aspects: EvidenceRecord["aspects"],
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  const text =
    aspects.map((label) => label.quote).join(" ") || "Different product.";
  return {
    id,
    sessionId: session,
    researchId,
    snapshotVersion: 1,
    text,
    contextualText: text,
    threadId,
    threadTitle: `Thread ${threadId}`,
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
    aspects,
    ...overrides,
  };
}
const positive = {
  aspect: "pricing" as const,
  sentiment: "positive" as const,
  quote: "Pricing is fair and affordable.",
};
const negative = {
  aspect: "pricing" as const,
  sentiment: "negative" as const,
  quote: "Pricing is too expensive.",
};
const corpus = [
  ...Array.from({ length: 12 }, (_, i) =>
    record(`complaint-${i}`, "large-complaint", [negative]),
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    record(`praise-${i}`, `praise-${i}`, [positive], {
      publishedAt: i === 0 ? null : timestamp,
    }),
  ),
  record("cross-aspect", "cross", [
    negative,
    {
      aspect: "support",
      sentiment: "positive",
      quote: "Support is excellent.",
    },
  ]),
  record("irrelevant", "other", [], {
    relevant: false,
    productIdentity: "other",
  }),
  record("mixed", "mixed", [
    {
      aspect: "pricing",
      sentiment: "mixed",
      quote: "Pricing is costly but fair.",
    },
  ]),
];
const query = (overrides: Partial<QueryInput> = {}) =>
  store.query(session, job, {
    researchId,
    question: "What do people dislike about pricing?",
    filters: filtersSchema.parse({}),
    challenge: false,
    challengeSentiment: "negative",
    requestId: randomUUID(),
    ...overrides,
  });

beforeAll(async () => {
  await store.init();
  await store.ingest(corpus);
  await store.ingest([
    record("foreign-session", "foreign", [negative], {
      sessionId: "another-session",
    }),
  ]);
  await store.ingest([
    record("old-version", "old", [negative], { snapshotVersion: 2 }),
  ]);
}, 60_000);
afterAll(async () => {
  // This unique name is generated in this test. No configured app index is deleted.
  if (await client.indices.exists({ index }))
    await client.indices.delete({ index });
  await store.close();
  await client.close();
});

describe("real Elasticsearch evidence index", () => {
  it("normalizes equivalent dates and keeps their scope identity stable", async () => {
    const first = await query({
      filters: filtersSchema.parse({
        from: "2026-09-01T00:00:00Z",
        to: timestamp,
      }),
    });
    const same = await query({
      filters: filtersSchema.parse({ from: timestamp, to: timestamp }),
    });
    expect(first.metrics.scopedRecords).toBe(19);
    expect(first.filters.from).toBe(timestamp);
    expect(first.scopeVersion).toBe(same.scopeVersion);
  });
  it("rejects a damaged completed snapshot while accepting a genuinely empty one", async () => {
    const damaged = { ...job, id: randomUUID(), indexed: 2 };
    const request = {
      researchId: damaged.id,
      question: "pricing",
      filters: filtersSchema.parse({}),
      challenge: false,
      challengeSentiment: "negative" as const,
      requestId: randomUUID(),
    };
    await store.ingest([
      record("delete-only-this-test-record", "test-loss", [negative], {
        researchId: damaged.id,
      }),
      record("keep-this-test-record", "test-keep", [positive], {
        researchId: damaged.id,
      }),
    ]);
    expect(
      (await store.query(session, damaged, request)).metrics.collectedRecords,
    ).toBe(2);
    // Mutate only this run's generated test index and this test's research ID.
    const deleted = await client.deleteByQuery({
      index,
      refresh: true,
      query: {
        bool: {
          filter: [
            { term: { sessionId: session } },
            { term: { researchId: damaged.id } },
            { term: { id: "delete-only-this-test-record" } },
          ],
        },
      },
    });
    expect(deleted.deleted).toBe(1);
    await expect(store.query(session, damaged, request)).rejects.toThrow(
      "no longer matches",
    );
    await store.deleteResearch(session, damaged.id);
    await expect(store.query(session, damaged, request)).rejects.toThrow(
      "no longer matches",
    );
    const empty = {
      ...job,
      id: randomUUID(),
      indexed: 0,
      analyzed: 0,
      collected: 0,
    };
    const packet = await store.query(session, empty, {
      ...request,
      researchId: empty.id,
    });
    expect(packet.metrics.collectedRecords).toBe(0);
    expect(packet.evidence).toEqual([]);
  });
  it("returns exact full-scope counts independent of top examples and request wording", async () => {
    const packet = await query();
    expect(packet.metrics).toMatchObject({
      collectedRecords: 20,
      scopedRecords: 20,
      relevantRecords: 19,
      distinctThreads: 9,
      aspectMentions: 20,
    });
    expect(packet.metrics.aspects.find((a) => a.aspect === "pricing")).toEqual({
      aspect: "pricing",
      mentions: 19,
      positive: 5,
      negative: 13,
      mixed: 1,
      neutral: 0,
      unknown: 0,
    });
    expect(
      packet.metrics.aspects.find((a) => a.aspect === "support"),
    ).toMatchObject({ mentions: 1, positive: 1, negative: 0 });
    expect(packet.evidence.length).toBeLessThan(19);
    expect(packet.retrievalMode).toBe("bm25");
    expect(
      packet.evidence.every(
        (e) => e.sessionId === session && e.snapshotVersion === 1,
      ),
    ).toBe(true);
    const differentQuestion = await query({ question: "affordable" });
    expect(differentQuestion.metrics).toEqual(packet.metrics);
    expect(differentQuestion.evidence[0].id.startsWith("praise-")).toBe(true);
    expect(packet.limitations.some((s) => s.includes("synthetic"))).toBe(true);
  });
  it("excludes a dominant thread from counts, every example, and the distribution", async () => {
    const before = await query();
    const after = await query({
      filters: filtersSchema.parse({ excludedThreadIds: ["large-complaint"] }),
    });
    expect(after.metrics).toMatchObject({
      collectedRecords: 20,
      scopedRecords: 8,
      relevantRecords: 7,
      distinctThreads: 8,
      aspectMentions: 8,
    });
    expect(
      after.metrics.aspects.find((a) => a.aspect === "pricing"),
    ).toMatchObject({ mentions: 7, positive: 5, negative: 1 });
    expect(
      after.metrics.threads.some((t) => t.threadId === "large-complaint"),
    ).toBe(false);
    expect(after.evidence.some((e) => e.threadId === "large-complaint")).toBe(
      false,
    );
    expect(after.scopeVersion).not.toBe(before.scopeVersion);
  });
  it("retrieves real contrary labels and does not join unrelated nested sentiments", async () => {
    const packet = await query({
      challenge: true,
      filters: filtersSchema.parse({ aspect: "pricing" }),
    });
    expect(packet.opposingEvidence).toHaveLength(5);
    expect(
      packet.opposingEvidence.every((r) =>
        r.aspects.some(
          (a) => a.aspect === "pricing" && a.sentiment === "positive",
        ),
      ),
    ).toBe(true);
    expect(packet.opposingEvidence.some((r) => r.id === "cross-aspect")).toBe(
      false,
    );
    expect(packet.metrics.aspects).toHaveLength(1);
    expect(packet.metrics.aspectMentions).toBe(19);
    const reverse = await query({
      challenge: true,
      challengeSentiment: "positive",
      filters: filtersSchema.parse({
        aspect: "pricing",
        excludedThreadIds: ["large-complaint"],
      }),
    });
    expect(reverse.opposingEvidence.map((r) => r.id)).toEqual(["cross-aspect"]);
  });
  it("reports no opposing evidence without inventing a counterargument", async () => {
    const packet = await query({
      challenge: true,
      challengeSentiment: "positive",
      filters: filtersSchema.parse({ aspect: "support" }),
    });
    expect(packet.opposingEvidence).toEqual([]);
    expect(packet.spokenSummary).toContain("No negative opposing evidence");
  });
  it("returns exact original spans and citations that resolve in the packet", async () => {
    const packet = await query();
    const evidence = new Map(packet.evidence.map((e) => [e.id, e]));
    for (const finding of packet.findings) {
      expect(finding.evidenceIds.length).toBeGreaterThan(0);
      for (const id of finding.evidenceIds) expect(evidence.has(id)).toBe(true);
    }
    for (const item of [...packet.evidence, ...packet.opposingEvidence])
      for (const label of item.aspects)
        expect(item.text.includes(label.quote)).toBe(true);
  });
  it("filters source and missing publication dates in both counts and examples", async () => {
    const dated = await query({
      filters: filtersSchema.parse({ from: timestamp }),
    });
    expect(dated.metrics.scopedRecords).toBe(19);
    expect(dated.evidence.every((e) => e.publishedAt !== null)).toBe(true);
    const empty = await query({
      filters: filtersSchema.parse({ source: "hackernews" }),
      challenge: true,
    });
    expect(empty.metrics.scopedRecords).toBe(0);
    expect(empty.evidence).toEqual([]);
    expect(empty.opposingEvidence).toEqual([]);
  });
  it("protects immutable snapshots from another ingest and verifies existing mappings", async () => {
    await expect(
      store.ingest([record("append-attempt", "bad", [negative])]),
    ).rejects.toThrow();
    expect((await query()).metrics.collectedRecords).toBe(20);
    await store.init();
    const wrong = new EvidenceStore({
      url,
      apiKey,
      index,
      embedding: {
        apiKey: "unit-test-not-a-real-key",
        model: "text-embedding-3-small",
        dimensions: 256,
      },
    });
    await expect(wrong.init()).rejects.toThrow("mapping metadata");
    await wrong.close();
  });
  it("returns every thread even when there are more than the default ten term buckets", async () => {
    const extraJob = { ...job, id: randomUUID(), indexed: 150 };
    await store.ingest(
      Array.from({ length: 150 }, (_, i) =>
        record(`item-${i}`, `thread-${i}`, [positive], {
          researchId: extraJob.id,
        }),
      ),
    );
    const packet = await store.query(session, extraJob, {
      researchId: extraJob.id,
      question: "pricing",
      filters: filtersSchema.parse({}),
      challenge: false,
      challengeSentiment: "negative",
      requestId: randomUUID(),
    });
    expect(packet.metrics.distinctThreads).toBe(150);
    expect(packet.metrics.threads).toHaveLength(150);
    expect(
      packet.metrics.threads.reduce((total, t) => total + t.count, 0),
    ).toBe(150);
    await store.deleteResearch(session, extraJob.id);
  });
  it("keeps unlabeled original text inspectable without inventing findings or opposing evidence", async () => {
    const unlabeledJob = { ...job, id: randomUUID(), indexed: 3 };
    await store.ingest([
      record("unlabeled-original", "raw-one", [], {
        researchId: unlabeledJob.id,
        text: "AcmeFlow pricing needs explanation.",
        contextualText: "AcmeFlow pricing needs explanation.",
        relevant: false,
        productIdentity: "ambiguous",
        extractionStatus: "unlabeled",
      }),
      record("failed-analysis", "raw-two", [], {
        researchId: unlabeledJob.id,
        text: "My AcmeFlow experience.",
        contextualText: "My AcmeFlow experience.",
        relevant: false,
        productIdentity: "ambiguous",
        extractionStatus: "failed",
      }),
      record("verified-irrelevant", "other", [], {
        researchId: unlabeledJob.id,
        relevant: false,
        productIdentity: "other",
      }),
    ]);
    const packet = await store.query(session, unlabeledJob, {
      researchId: unlabeledJob.id,
      question: "pricing",
      filters: filtersSchema.parse({}),
      challenge: true,
      challengeSentiment: "negative",
      requestId: randomUUID(),
    });
    expect(packet.metrics).toMatchObject({
      scopedRecords: 3,
      relevantRecords: 0,
      aspectMentions: 0,
    });
    expect(packet.findings).toEqual([]);
    expect(packet.opposingEvidence).toEqual([]);
    expect(packet.evidence.map((e) => e.id).sort()).toEqual([
      "failed-analysis",
      "unlabeled-original",
    ]);
    expect(
      packet.limitations.some((s) =>
        s.includes("unknown relevance and sentiment"),
      ),
    ).toBe(true);
    await store.deleteResearch(session, unlabeledJob.id);
  });
  it("deletion cannot remove another session or another research snapshot", async () => {
    await store.deleteResearch("another-session", researchId);
    expect((await query()).metrics.collectedRecords).toBe(20);
    await expect(
      store.query(
        "another-session",
        { ...job, indexed: 1 },
        {
          researchId,
          question: "pricing",
          filters: filtersSchema.parse({}),
          challenge: false,
          challengeSentiment: "negative",
          requestId: randomUUID(),
        },
      ),
    ).rejects.toThrow("no longer matches");
  });
});
