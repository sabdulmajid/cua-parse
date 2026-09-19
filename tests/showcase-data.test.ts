/** Static export checks only. No server, Elasticsearch, or provider calls. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_PRODUCT,
  FIXTURE_VERSION,
  fixtureLabel,
  fixtureRecords,
} from "../fixtures/acmeflow.js";
import expected from "../fixtures/acmeflow.expected.json";
import demo from "../showcase/data/demo.json";
import type {
  EvidencePacket,
  EvidenceRecord,
} from "../src/shared/contracts.js";

type StateName = "overview" | "pricing" | "excluded" | "challenge";
type PublicRecord = Omit<
  EvidenceRecord,
  "sessionId" | "researchId" | "embedding"
>;
type PublicPacket = Omit<
  EvidencePacket,
  "researchId" | "requestId" | "generatedAt" | "evidence" | "opposingEvidence"
> & { evidence: PublicRecord[]; opposingEvidence: PublicRecord[] };
const states = demo.states as Record<StateName, PublicPacket>;
const originals = new Map(
  fixtureRecords().map((record) => [record.id, record]),
);
const stateNames: StateName[] = [
  "overview",
  "pricing",
  "excluded",
  "challenge",
];

function sourceRecords(packet: PublicPacket) {
  return new Map(
    [...packet.evidence, ...packet.opposingEvidence].map((record) => [
      record.id,
      record,
    ]),
  );
}

function assertInScope(record: PublicRecord, packet: PublicPacket) {
  expect(packet.filters.excludedThreadIds).not.toContain(record.threadId);
  if (packet.filters.aspect)
    expect(record.aspects.map((label) => label.aspect)).toContain(
      packet.filters.aspect,
    );
  if (packet.filters.source) expect(record.source).toBe(packet.filters.source);
  if (packet.filters.from) {
    expect(record.publishedAt).not.toBeNull();
    expect(Date.parse(record.publishedAt!)).toBeGreaterThanOrEqual(
      Date.parse(packet.filters.from),
    );
  }
  if (packet.filters.to) {
    expect(record.publishedAt).not.toBeNull();
    expect(Date.parse(record.publishedAt!)).toBeLessThanOrEqual(
      Date.parse(packet.filters.to),
    );
  }
}

function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysIn(item)]);
}

describe("public synthetic research export", () => {
  it("keeps full-sample counts separate from selected examples", () => {
    expect(demo.schemaVersion).toBe(1);
    expect(demo.synthetic).toBe(true);
    expect(demo.product).toBe(FIXTURE_PRODUCT);
    expect(Object.keys(states).sort()).toEqual([...stateNames].sort());
    expect(demo.dominantThreadId).toBe(expected.dominantThread.id);
    expect(states.overview.metrics).toMatchObject({
      collectedRecords: expected.uniqueRecords,
      scopedRecords: expected.uniqueRecords,
      relevantRecords: expected.relevantRecords,
      aspectMentions: expected.aspectMentions,
      distinctThreads: new Set(
        [...originals.values()].map((row) => row.threadId),
      ).size,
    });
    expect(
      states.overview.metrics.threads.find(
        (row) => row.threadId === demo.dominantThreadId,
      )?.count,
    ).toBe(expected.dominantThread.records);
    for (const aspect of [
      "pricing",
      "onboarding",
      "support",
      "features",
      "reliability",
    ] as const)
      expect(
        states.overview.metrics.aspects.find((row) => row.aspect === aspect),
      ).toEqual({
        aspect,
        ...expected[aspect],
      });
    // The complete denominator must survive a smaller presentation sample.
    expect(states.overview.evidence.length).toBeLessThan(
      states.overview.metrics.scopedRecords,
    );
  });

  it("preserves the pricing-first exclusion effect from the independent oracle", () => {
    const { pricing, excluded } = states;
    expect(pricing.filters).toMatchObject({
      aspect: "pricing",
      excludedThreadIds: [],
    });
    expect(excluded.filters).toEqual({
      ...pricing.filters,
      excludedThreadIds: [expected.dominantThread.id],
    });
    expect(pricing.metrics).toMatchObject({
      collectedRecords: expected.uniqueRecords,
      scopedRecords: expected.pricing.mentions,
      relevantRecords: 13,
      distinctThreads: 4,
      aspectMentions: expected.pricing.mentions,
      aspects: [{ aspect: "pricing", ...expected.pricing }],
    });
    expect(excluded.metrics).toMatchObject({
      collectedRecords: expected.uniqueRecords,
      scopedRecords: expected.afterExcludingAngry.pricing.mentions,
      relevantRecords: 5,
      distinctThreads: 3,
      aspectMentions: expected.afterExcludingAngry.pricing.mentions,
      aspects: [{ aspect: "pricing", ...expected.afterExcludingAngry.pricing }],
    });
    expect(
      pricing.metrics.aspects[0].negative -
        excluded.metrics.aspects[0].negative,
    ).toBe(expected.dominantThread.pricingNegative);
    expect(
      excluded.metrics.threads.some(
        (row) => row.threadId === demo.dominantThreadId,
      ),
    ).toBe(false);
    expect(new Set(excluded.evidence.map((row) => row.id)).size).toBe(5);
  });

  it("challenges with the three positive sources without changing the denominator", () => {
    const { excluded, challenge } = states;
    expect(excluded.challenge).toBe(false);
    expect(challenge.challenge).toBe(true);
    expect(challenge.filters).toEqual(excluded.filters);
    expect(challenge.scopeVersion).toBe(excluded.scopeVersion);
    expect(challenge.metrics).toEqual(excluded.metrics);
    expect(challenge.opposingEvidence.map((row) => row.id).sort()).toEqual(
      [...expected.positivePricingEvidenceIds].sort(),
    );
    expect(new Set(challenge.opposingEvidence.map((row) => row.id)).size).toBe(
      3,
    );
    for (const record of challenge.opposingEvidence) {
      assertInScope(record, challenge);
      expect(record.aspects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ aspect: "pricing", sentiment: "positive" }),
        ]),
      );
    }
    for (const finding of challenge.findings)
      for (const id of finding.evidenceIds)
        expect(expected.positivePricingEvidenceIds).toContain(id);
  });

  it.each(stateNames)(
    "retains exact fixture originals, labels, and valid citations in %s",
    (state) => {
      const packet = states[state];
      expect(packet.provenance).toEqual(["synthetic"]);
      expect(packet.retrievalMode).toBe("bm25");
      expect(packet.question).toBe(demo.question);
      expect(packet.snapshotVersion).toBe(states.overview.snapshotVersion);
      expect(packet.evidence.length).toBeGreaterThan(0);
      for (const list of [packet.evidence, packet.opposingEvidence]) {
        expect(new Set(list.map((record) => record.id)).size).toBe(list.length);
        for (const record of list) {
          const original = originals.get(record.id);
          expect(original, `Unknown original ${record.id}`).toBeDefined();
          expect(record).toMatchObject(original!);
          expect(record).toMatchObject({
            source: "fixture",
            provenance: "synthetic",
            url: null,
          });
          const declared = fixtureLabel(original!);
          expect(declared).not.toBeNull();
          expect(record.aspects).toEqual(declared!.aspects);
          expect(record.relevant).toBe(declared!.relevant);
          expect(record.productIdentity).toBe(declared!.productIdentity);
          expect(record.analysisVersion).toBe(FIXTURE_VERSION);
          for (const label of record.aspects)
            expect(original!.text).toContain(label.quote);
          assertInScope(record, packet);
        }
      }
      const sources = sourceRecords(packet);
      expect(packet.findings.length).toBeGreaterThan(0);
      for (const finding of packet.findings) {
        expect(finding.evidenceIds.length).toBeGreaterThan(0);
        const quote = finding.text.match(/“([\s\S]+)”/u)?.[1];
        expect(quote, "A finding needs an original quotation").toBeTruthy();
        if (packet.filters.aspect)
          expect(finding.aspect).toBe(packet.filters.aspect);
        for (const id of finding.evidenceIds) {
          const record = sources.get(id);
          expect(record, `Missing citation ${id}`).toBeDefined();
          assertInScope(record!, packet);
          expect(record!.text).toContain(quote!);
          expect(record!.aspects).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ aspect: finding.aspect, quote }),
            ]),
          );
        }
      }
      expect(packet.metrics.threads.reduce((n, row) => n + row.count, 0)).toBe(
        packet.metrics.scopedRecords,
      );
    },
  );

  it("contains no runtime identity, generated timestamp, or embedding fields", () => {
    const forbidden = new Set([
      "session",
      "sessionid",
      "research",
      "researchid",
      "request",
      "requestid",
      "generatedat",
      "embedding",
      "embeddings",
      "csrftoken",
      "apikey",
      "authorization",
      "conversationid",
      "signedurl",
    ]);
    const unsafe = keysIn(demo).filter((key) =>
      forbidden.has(key.replace(/[^a-z]/gi, "").toLowerCase()),
    );
    expect(unsafe).toEqual([]);
    expect(demo.provenance).toMatchObject({
      fixtureVersion: FIXTURE_VERSION,
      publicSourceUrls: false,
      paidProviderCalls: 0,
    });
    expect(demo.briefs.challenge).not.toMatch(
      /^Generated:|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/im,
    );
  });

  it("exports a brief with the challenge scope and only in-scope source citations", () => {
    const packet = states.challenge;
    const brief = demo.briefs.challenge;
    expect(brief).toContain(
      `Evidence snapshot: ${packet.snapshotVersion}; scope: ${packet.scopeVersion}`,
    );
    expect(brief).toContain(`Question: ${packet.question}`);
    expect(brief).toContain(
      `Scoped records: ${packet.metrics.scopedRecords}. Relevant records: ${packet.metrics.relevantRecords}. Distinct scoped threads: ${packet.metrics.distinctThreads}.`,
    );
    expect(brief).toContain(
      `Excluded threads: ${demo.dominantThreadId}. Aspect: pricing.`,
    );
    expect(brief).toContain("Data: synthetic.");
    const sources = sourceRecords(packet);
    const evidenceIds = [...brief.matchAll(/^### (fixture:[^\s]+)$/gm)].map(
      (match) => match[1],
    );
    expect([...evidenceIds].sort()).toEqual([...sources.keys()].sort());
    const citations = [...brief.matchAll(/Citations: ([^\n]+)/g)].flatMap(
      (match) => match[1].split(", "),
    );
    expect([...new Set(citations)].sort()).toEqual(
      [...expected.positivePricingEvidenceIds].sort(),
    );
    for (const id of citations) {
      expect(sources.has(id)).toBe(true);
      assertInScope(sources.get(id)!, packet);
    }
    for (const record of sources.values()) {
      expect(brief).toContain(`> ${record.text}`);
      expect(brief).toContain(`### ${record.id}`);
    }
    expect(brief).not.toMatch(/^### fixture:angry/m);
    expect(brief).toContain("Synthetic evidence; no original public URL.");
  });

  it("keeps the public README focused on a clearly labelled guided sample", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    expect(readme).toContain("synthetic AcmeFlow feedback");
    expect(readme).toMatch(/\[.*guided demo.*\]\(https:\/\//i);
    expect(readme).not.toMatch(
      /\btrial\b|localhost|docker compose|\bnpm\s|```(?:sh|bash|shell)/i,
    );
  });
});
