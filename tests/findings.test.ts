import { describe, expect, it } from "vitest";
import { questionSentiment, sourceFindings } from "../src/server/findings.js";
import {
  filtersSchema,
  type EvidenceRecord,
  type QueryInput,
} from "../src/shared/contracts.js";
const query: QueryInput = {
  researchId: "test",
  requestId: "request",
  question: "What sucks about Microsoft Team?",
  filters: filtersSchema.parse({}),
  challenge: false,
  challengeSentiment: "negative",
};
function record(
  id: string,
  quote: string,
  sentiment: "negative" | "positive" | "mixed",
  aspect: "reliability" | "features" = "reliability",
): EvidenceRecord {
  return {
    id,
    text: quote,
    aspects: [{ aspect, sentiment, quote }],
    relevant: true,
    extractionStatus: "verified",
    threadId: id,
  } as EvidenceRecord;
}
describe("answers grounded in source quotes", () => {
  it.each([
    ["What are its strengths and weaknesses?", null],
    ["What do people like and dislike?", null],
    ["What are the things people don't like?", "negative"],
    ["What don't people like?", "negative"],
    ["What don't people like and what do they praise?", null],
    ["What are the benefits?", "positive"],
    ["How do people use it?", null],
  ])("selects the requested sentiment for %s", (question, expected) => {
    expect(questionSentiment(question)).toBe(expected);
  });
  it("retains praise and complaints when the question asks for both", () => {
    const records = [
      record("bad", "Search misses messages.", "negative"),
      record("good", "Calls connect quickly.", "positive"),
    ];
    const twoSided = {
      ...query,
      question: "What are its strengths and weaknesses?",
    };
    expect(
      sourceFindings(records, twoSided, "scope").flatMap(
        (finding) => finding.evidenceIds,
      ),
    ).toEqual(["bad", "good"]);
    expect(
      sourceFindings(
        records,
        { ...twoSided, challenge: true },
        "scope",
      ).flatMap((finding) => finding.evidenceIds),
    ).toEqual(["good"]);
  });
  it("includes a different aspect from the same thread before filling repeated complaints", () => {
    const mixedQuote =
      "Screen sharing is useful, but the feature needs too many clicks.";
    const records = [
      record("feature", mixedQuote, "mixed", "features"),
      ...Array.from({ length: 4 }, (_, index) =>
        record(
          `lag-${index}`,
          `Teams freezes during call ${index + 1}.`,
          "negative",
        ),
      ),
    ].map((item) => ({ ...item, threadId: "one-discussion" }));
    const findings = sourceFindings(records, query, "scope");
    expect(findings.map((finding) => finding.evidenceIds)).toEqual([
      ["lag-0"],
      ["feature"],
      ["lag-1"],
      ["lag-2"],
    ]);
    expect(findings[0].text).toBe(
      "Reliability: “Teams freezes during call 1.”",
    );
    expect(findings[1].text).toBe(`Features: “${mixedQuote}”`);
  });
  it("includes a different thread for the same aspect before filling repeats", () => {
    const records = Array.from({ length: 5 }, (_, index) => ({
      ...record(
        `lag-${index}`,
        `Teams freezes during call ${index + 1}.`,
        "negative",
      ),
      threadId: index === 4 ? "second-discussion" : "first-discussion",
    }));
    expect(
      sourceFindings(records, query, "scope").map(
        (finding) => finding.evidenceIds,
      ),
    ).toEqual([["lag-0"], ["lag-4"], ["lag-1"], ["lag-2"]]);
  });
  it("answers the exact complaints question with specific source text, not praise or aggregate totals", () => {
    const records = [
      record("praise", "The app is fast.", "positive"),
      record("lag", "Teams takes ten seconds to switch channels.", "negative"),
      record(
        "missing",
        "Linux misses the background controls.",
        "negative",
        "features",
      ),
    ];
    expect(questionSentiment(query.question)).toBe("negative");
    const findings = sourceFindings(records, query, "scope");
    expect(findings).toHaveLength(2);
    expect(findings[0].text).toContain(
      "Teams takes ten seconds to switch channels.",
    );
    expect(findings.flatMap((f) => f.evidenceIds)).toEqual(["lag", "missing"]);
    expect(query.challenge).toBe(false);
  });
  it("uses actual opposing records only for an explicit challenge", () => {
    const records = [
      record("bad", "Search misses messages.", "negative"),
      record("good", "Search finds messages quickly.", "positive"),
    ];
    const findings = sourceFindings(
      records,
      { ...query, challenge: true },
      "scope",
    );
    expect(findings.map((f) => f.evidenceIds)).toEqual([["good"]]);
    expect(
      sourceFindings([records[0]], { ...query, challenge: true }, "scope"),
    ).toEqual([]);
  });
  it("does not use failed, irrelevant, invented or wrong-aspect source labels", () => {
    const valid = record(
      "valid",
      "Search misses messages.",
      "negative",
      "features",
    );
    const records = [
      valid,
      {
        ...record("failed", "Notifications vanish.", "negative"),
        extractionStatus: "failed" as const,
      },
      { ...record("other", "It is slow.", "negative"), relevant: false },
      {
        ...record("invented", "Invented quotation.", "negative"),
        text: "Actual text.",
      },
    ];
    expect(
      sourceFindings(records, query, "scope").map((f) => f.evidenceIds),
    ).toEqual([["valid"]]);
    expect(
      sourceFindings(
        records,
        { ...query, filters: filtersSchema.parse({ aspect: "reliability" }) },
        "scope",
      ),
    ).toEqual([]);
  });
  it("deduplicates exact quote claims and keeps citations within the returned source set", () => {
    const findings = sourceFindings(
      [
        record("a", "Teams freezes on startup.", "negative"),
        record("b", "Teams freezes on startup.", "negative"),
      ],
      query,
      "scope",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidenceIds).toEqual(["a"]);
  });
  it("keeps the complaint at the end of a long mixed quote", () => {
    const quote =
      "The call interface works well. ".repeat(12) +
      "But notification badges do not appear until I restart Teams.";
    const findings = sourceFindings(
      [record("mixed", quote, "mixed")],
      query,
      "scope",
    );
    expect(findings[0].text).toContain(quote);
    expect(findings[0].text).toContain("notification badges do not appear");
  });
  it("leads with direct complaints before mixed observations", () => {
    const findings = sourceFindings(
      [
        record(
          "mixed",
          "There is a new feature but old bugs remain.",
          "mixed",
          "features",
        ),
        record("bad", "Notifications do not arrive.", "negative"),
      ],
      query,
      "scope",
    );
    expect(findings[0].evidenceIds).toEqual(["bad"]);
  });
});
