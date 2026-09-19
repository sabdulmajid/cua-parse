import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureRecords } from "../fixtures/acmeflow.js";
import {
  analyze,
  contentHash,
  validateModelLabel,
} from "../src/server/analysis.js";
import type {
  AnalysisOptions,
  EvidenceRecord,
  RawRecord,
} from "../src/shared/contracts.js";
const expected = JSON.parse(
  readFileSync(
    new URL("../fixtures/acmeflow.expected.json", import.meta.url),
    "utf8",
  ),
);
const context = {
  researchId: "research-one",
  sessionId: "session-one",
  product: "AcmeFlow",
  snapshotVersion: 1,
};
const options = (
  mode: AnalysisOptions["mode"] = "fixture",
): AnalysisOptions => ({
  mode,
  model: "test-model",
  signal: new AbortController().signal,
  ...(mode === "openai" ? { apiKey: "test-key-not-a-secret" } : {}),
});
const raw = (): RawRecord => ({
  id: "source-one",
  text: "AcmeFlow pricing is fair, but onboarding was hard.",
  threadTitle: "AcmeFlow feedback",
  threadId: "thread-one",
  parentId: null,
  url: "https://example.com/feedback",
  source: "import",
  provenance: "imported",
  publishedAt: null,
  collectedAt: "2026-09-19T12:00:00.000Z",
});
const label = () => ({
  id: "source-one",
  relevant: true,
  productIdentity: "match",
  identityQuote: "AcmeFlow",
  identitySource: "text",
  aspects: [
    { aspect: "pricing", sentiment: "positive", quote: "pricing is fair" },
    {
      aspect: "onboarding",
      sentiment: "negative",
      quote: "onboarding was hard",
    },
  ],
});
const response = (labels: unknown[], status = "completed") =>
  new Response(
    JSON.stringify({
      id: "test-response",
      object: "response",
      status,
      output: [
        {
          id: "message-one",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ records: labels }),
              annotations: [],
            },
          ],
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
afterEach(() => vi.unstubAllGlobals());
function counts(records: EvidenceRecord[], aspect: string) {
  const labels = records
    .filter((record) => record.relevant)
    .flatMap((record) => record.aspects)
    .filter((label) => label.aspect === aspect);
  return {
    mentions: labels.length,
    ...Object.fromEntries(
      ["positive", "negative", "mixed", "neutral", "unknown"].map(
        (sentiment) => [
          sentiment,
          labels.filter((label) => label.sentiment === sentiment).length,
        ],
      ),
    ),
  };
}

describe("declared synthetic evidence", () => {
  it("matches the independent oracle and exact quote spans", async () => {
    const original = fixtureRecords();
    const result = await analyze(original, context, options());
    expect(original).toHaveLength(expected.rawRecords);
    expect(result.records).toHaveLength(expected.uniqueRecords);
    expect(result.duplicates).toBe(expected.duplicates);
    expect(result.failures).toEqual([]);
    const relevant = result.records.filter((record) => record.relevant);
    expect(relevant).toHaveLength(expected.relevantRecords);
    expect(new Set(relevant.map((record) => record.threadId)).size).toBe(
      expected.relevantThreads,
    );
    expect(relevant.flatMap((record) => record.aspects)).toHaveLength(
      expected.aspectMentions,
    );
    for (const aspect of [
      "pricing",
      "onboarding",
      "support",
      "features",
      "reliability",
    ])
      expect(counts(result.records, aspect)).toEqual(expected[aspect]);
    for (const record of result.records)
      for (const aspect of record.aspects)
        expect(record.text).toContain(aspect.quote);
    expect(
      result.records
        .filter((record) => !record.relevant)
        .map((record) => record.id),
    ).toEqual(expected.excludedFromRelevance);
    expect(
      result.records
        .filter((record) => record.publishedAt === null)
        .map((record) => record.id),
    ).toEqual(expected.missingPublicationDate);
  });
  it("changes the conclusion denominator after the concentrated thread is excluded", async () => {
    const result = await analyze(fixtureRecords(), context, options());
    const without = result.records.filter(
      (record) => record.threadId !== expected.dominantThread.id,
    );
    expect(without.filter((record) => record.relevant)).toHaveLength(
      expected.afterExcludingAngry.relevantRecords,
    );
    expect(counts(without, "pricing")).toEqual(
      expected.afterExcludingAngry.pricing,
    );
    expect(
      without
        .filter((record) =>
          record.aspects.some(
            (aspect) =>
              aspect.aspect === "pricing" && aspect.sentiment === "positive",
          ),
        )
        .map((record) => record.id),
    ).toEqual(expected.positivePricingEvidenceIds);
  });
  it("does not reuse a label for a changed fixture or a different product", async () => {
    const record = {
      ...fixtureRecords()[0]!,
      text: "An attacker changed this text.",
    };
    const result = await analyze([record], context, options());
    expect(result.records[0]?.extractionStatus).toBe("failed");
    expect(result.records[0]?.aspects).toEqual([]);
    await expect(
      analyze(
        fixtureRecords(),
        { ...context, product: "OtherFlow" },
        options(),
      ),
    ).rejects.toThrow("only describe AcmeFlow");
  });
  it("deduplicates exact source text but preserves distinct comments", async () => {
    expect(contentHash("cafe\u0301\r\ntext")).toBe(contentHash("café\ntext"));
    const record = raw();
    const result = await analyze(
      [
        record,
        { ...record, id: "copy" },
        { ...record, id: "distinct", text: "AcmeFlow pricing is fairly good." },
      ],
      context,
      options("unlabeled"),
    );
    expect(result.duplicates).toBe(1);
    expect(result.records).toHaveLength(2);
  });
  it("uses no hidden heuristic when analysis is disabled", async () => {
    const result = await analyze([raw()], context, options("unlabeled"));
    expect(result.records[0]).toMatchObject({
      relevant: false,
      productIdentity: "ambiguous",
      aspects: [],
      extractionStatus: "unlabeled",
    });
    expect(result.failures[0]).toContain("unknown");
  });
});

describe("strict structured-label validation", () => {
  it("keeps aspect and sentiment associations intact", () =>
    expect(validateModelLabel(label(), raw(), "AcmeFlow", "").aspects).toEqual(
      label().aspects,
    ));
  it("rejects fabricated quotation and inconsistent identity", () => {
    expect(() =>
      validateModelLabel(
        {
          ...label(),
          aspects: [
            {
              aspect: "pricing",
              sentiment: "positive",
              quote: "this is invented",
            },
          ],
        },
        raw(),
        "AcmeFlow",
        "",
      ),
    ).toThrow("absent");
    expect(() =>
      validateModelLabel(
        { ...label(), productIdentity: "ambiguous" },
        raw(),
        "AcmeFlow",
        "",
      ),
    ).toThrow("matched");
    expect(() =>
      validateModelLabel(
        { ...label(), identityQuote: "pricing is fair" },
        raw(),
        "AcmeFlow",
        "",
      ),
    ).toThrow("identity span");
  });
  it("rejects duplicate aspects and an identity substring belonging to another product", () => {
    expect(() =>
      validateModelLabel(
        { ...label(), aspects: [label().aspects[0], label().aspects[0]] },
        raw(),
        "AcmeFlow",
        "",
      ),
    ).toThrow("only once");
    expect(() =>
      validateModelLabel(
        { ...label(), identityQuote: "SuperAcmeFlow" },
        { ...raw(), text: "SuperAcmeFlow pricing is fair" },
        "AcmeFlow",
        "",
      ),
    ).toThrow("identity span");
  });
  it("uses parent context for identity but not for source quotes", () => {
    const record = { ...raw(), text: "The price is fair." };
    const value = {
      ...label(),
      identitySource: "parentText",
      aspects: [
        { aspect: "pricing", sentiment: "positive", quote: "price is fair" },
      ],
    };
    expect(
      validateModelLabel(value, record, "AcmeFlow", "AcmeFlow discussion")
        .relevant,
    ).toBe(true);
    expect(() =>
      validateModelLabel(
        {
          ...value,
          aspects: [
            {
              aspect: "pricing",
              sentiment: "positive",
              quote: "AcmeFlow discussion",
            },
          ],
        },
        record,
        "AcmeFlow",
        "AcmeFlow discussion",
      ),
    ).toThrow("absent");
  });
});

describe("official SDK response handling with explicitly mocked provider HTTP", () => {
  it("parses structured output, passes untrusted data separately, and copies cache labels into new snapshots", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response([label()]);
    });
    vi.stubGlobal("fetch", fetcher);
    const scope = { ...context, sessionId: "cache-isolated-session" };
    const first = await analyze([raw()], scope, options("openai"));
    expect(first.failures).toEqual([]);
    expect(first.records[0]?.aspects).toEqual(label().aspects);
    expect(bodies[0]?.store).toBe(false);
    expect(JSON.stringify(bodies[0]?.input)).toContain("untrusted data");
    first.records[0]!.aspects[0]!.quote = "changed outside cache";
    const second = await analyze(
      [raw()],
      { ...scope, researchId: "research-two", snapshotVersion: 2 },
      options("openai"),
    );
    expect(second.records[0]?.researchId).toBe("research-two");
    expect(second.records[0]?.snapshotVersion).toBe(2);
    expect(second.records[0]?.aspects[0]?.quote).toBe("pricing is fair");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await analyze(
      [raw()],
      { ...scope, sessionId: "another-session" },
      options("openai"),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid model quotes without inventing fallback labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response([
          {
            ...label(),
            aspects: [
              { aspect: "pricing", sentiment: "positive", quote: "invented" },
            ],
          },
        ]),
      ),
    );
    const result = await analyze(
      [raw()],
      { ...context, sessionId: "invalid-model-quotes" },
      options("openai"),
    );
    expect(result.records[0]).toMatchObject({
      extractionStatus: "failed",
      aspects: [],
      relevant: false,
    });
    expect(result.failures).toHaveLength(1);
  });
  it("handles refusal/incomplete output and cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([label()], "incomplete")),
    );
    const result = await analyze(
      [raw()],
      { ...context, sessionId: "incomplete-model" },
      options("openai"),
    );
    expect(result.records[0]?.extractionStatus).toBe("failed");
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyze([raw()], context, {
        ...options("openai"),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
  it("stops provider requests after an access error and hides remote content", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "PRIVATE PROVIDER MESSAGE",
              type: "invalid_request_error",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const inputs = Array.from({ length: 6 }, (_, i) => ({
      ...raw(),
      id: `record-${i}`,
      text: `AcmeFlow statement ${i}`,
    }));
    const result = await analyze(
      inputs,
      { ...context, sessionId: "failed-access" },
      options("openai"),
    );
    expect(result.records).toHaveLength(6);
    expect(
      result.records.every((record) => record.extractionStatus === "failed"),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE PROVIDER MESSAGE");
  });
});

describe("independent model record validation", () => {
  const inputs = (length = 4) =>
    Array.from({ length }, (_, i) => ({
      ...raw(),
      id: `isolated-${i}`,
      text: `${raw().text} Comment ${i}.`,
    }));
  const valid = (id: string) => ({ ...label(), id });
  it.each([
    [
      "unsupported source quote",
      {
        aspects: [
          {
            aspect: "pricing",
            sentiment: "positive",
            quote: "PRIVATE INVENTED QUOTE",
          },
        ],
      },
    ],
    ["unsupported product identity", { identityQuote: "pricing is fair" }],
    [
      "invalid record schema",
      {
        aspects: [
          {
            aspect: "not-an-aspect",
            sentiment: "positive",
            quote: "pricing is fair",
          },
        ],
      },
    ],
  ])(
    "preserves three valid neighbors after one %s failure",
    async (reason, change) => {
      const records = inputs();
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const data = JSON.parse(
          JSON.parse(String(init?.body)).input[1].content,
        );
        return response(
          data.records.map((r: { id: string }) => ({
            ...valid(r.id),
            ...(r.id === "isolated-1" ? change : {}),
          })),
        );
      });
      vi.stubGlobal("fetch", fetcher);
      const result = await analyze(
        records,
        { ...context, sessionId: `isolated-${reason}` },
        options("openai"),
      );
      expect(result.records.map((r) => r.extractionStatus)).toEqual([
        "verified",
        "failed",
        "verified",
        "verified",
      ]);
      expect(result.records[1]).toMatchObject({ relevant: false, aspects: [] });
      expect(result.records[0]?.aspects).toEqual(label().aspects);
      expect(result.failures).toEqual([
        `Analysis failed for 1 of 4 records (${reason}: 1). Original text remains available; failed records have no inferred labels.`,
      ]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE INVENTED QUOTE");
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it("isolates duplicate and missing IDs while rejecting unexpected IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response([
          valid("isolated-0"),
          valid("isolated-0"),
          valid("isolated-2"),
          valid("not-requested"),
        ]),
      ),
    );
    const result = await analyze(
      inputs(),
      { ...context, sessionId: "invalid-id-isolation" },
      options("openai"),
    );
    expect(result.records.map((r) => r.extractionStatus)).toEqual([
      "failed",
      "failed",
      "verified",
      "failed",
    ]);
    expect(result.failures).toEqual([
      "Analysis failed for 3 of 4 records (duplicate record ID: 1; missing record label: 2). Original text remains available; failed records have no inferred labels.",
      "Ignored 1 model labels with missing or unrequested record IDs.",
    ]);
    expect(result.records.some((r) => r.id === "not-requested")).toBe(false);
  });
  it("aggregates failures across batches and caches only independently valid labels", async () => {
    const records = inputs(8);
    const bodies: Array<{ records: Array<{ id: string }> }> = [];
    let repair = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const data = JSON.parse(body.input[1].content);
        bodies.push(data);
        return response(
          data.records.map((r: { id: string }) => ({
            ...valid(r.id),
            ...(!repair && ["isolated-1", "isolated-5"].includes(r.id)
              ? {
                  aspects: [
                    {
                      aspect: "pricing",
                      sentiment: "positive",
                      quote: "absent quote",
                    },
                  ],
                }
              : {}),
          })),
        );
      }),
    );
    const scope = { ...context, sessionId: "aggregated-and-cached" };
    const first = await analyze(records, scope, options("openai"));
    expect(
      first.records.filter((r) => r.extractionStatus === "verified"),
    ).toHaveLength(6);
    expect(first.failures).toEqual([
      "Analysis failed for 2 of 8 records (unsupported source quote: 2). Original text remains available; failed records have no inferred labels.",
    ]);
    repair = true;
    const second = await analyze(
      records,
      { ...scope, snapshotVersion: 2 },
      options("openai"),
    );
    expect(bodies).toHaveLength(5);
    expect(bodies[4]?.records.map((r) => r.id)).toEqual([
      "isolated-1",
      "isolated-5",
    ]);
    expect(second.failures).toEqual([]);
    expect(
      second.records.every(
        (r) => r.extractionStatus === "verified" && r.snapshotVersion === 2,
      ),
    ).toBe(true);
    expect(second.records.map((r) => r.id)).toEqual(records.map((r) => r.id));
  });
  it("fails a refused response without exposing the refusal content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "refused-response",
              object: "response",
              status: "completed",
              output: [
                {
                  id: "refusal",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    { type: "refusal", refusal: "PRIVATE REFUSAL CONTENT" },
                  ],
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const result = await analyze(
      inputs(),
      { ...context, sessionId: "specific-refusal" },
      options("openai"),
    );
    expect(result.records.every((r) => r.extractionStatus === "failed")).toBe(
      true,
    );
    expect(result.failures[0]).toContain("model refusal: 4");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE REFUSAL CONTENT");
  });
  it("does not salvage labels from an incomplete response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          inputs().map((r) => valid(r.id)),
          "incomplete",
        ),
      ),
    );
    const result = await analyze(
      inputs(),
      { ...context, sessionId: "specific-incomplete" },
      options("openai"),
    );
    expect(result.records.every((r) => r.extractionStatus === "failed")).toBe(
      true,
    );
    expect(result.failures[0]).toContain("incomplete model response: 4");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("counts records skipped after a provider access failure", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "PRIVATE PROVIDER BODY",
              type: "invalid_request_error",
            },
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await analyze(
      inputs(7),
      { ...context, sessionId: "specific-provider-failure" },
      options("openai"),
    );
    expect(result.failures).toEqual([
      "Analysis failed for 7 of 7 records (provider HTTP 403: 4; not attempted after provider HTTP 403: 3). Original text remains available; failed records have no inferred labels.",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE PROVIDER BODY");
  });
});

describe("bounded Microsoft Teams identity spelling", () => {
  it.each(["Microsoft Team", "Microsoft Teams"])(
    "recognizes full vendor-qualified identity for %s",
    (product) => {
      const record = {
        ...raw(),
        text: "Microsoft Teams pricing is fair.",
        threadTitle: "Microsoft Teams feedback",
      };
      const value = {
        ...label(),
        identityQuote: "Microsoft Teams",
        aspects: [label().aspects[0]],
      };
      expect(validateModelLabel(value, record, product, "").relevant).toBe(
        true,
      );
    },
  );
  it("keeps generic teams and longer product names out of identity matches", () => {
    for (const quote of [
      "Teams",
      "Microsoft Teamsters",
      "SuperMicrosoft Teams",
    ]) {
      expect(() =>
        validateModelLabel(
          { ...label(), identityQuote: quote, aspects: [] },
          {
            ...raw(),
            text: `${quote} pricing is fair.`,
            threadTitle: "Unrelated software",
          },
          "Microsoft Teams",
          "",
        ),
      ).toThrow("identity span");
    }
  });
  it("allows an explicit title to resolve the product without accepting an unsupported span", () => {
    const record = {
      ...raw(),
      text: "Teams pricing is fair.",
      threadTitle: "Microsoft Teams feedback",
    };
    expect(
      validateModelLabel(
        {
          ...label(),
          identityQuote: "Microsoft Teams",
          identitySource: "threadTitle",
          aspects: [label().aspects[0]],
        },
        record,
        "Microsoft Team",
        "",
      ).relevant,
    ).toBe(true);
    expect(() =>
      validateModelLabel(
        {
          ...label(),
          identityQuote: "Microsoft Teams",
          identitySource: "text",
          aspects: [],
        },
        record,
        "Microsoft Teams",
        "",
      ),
    ).toThrow("identity span");
  });
});

describe("exact product identity boundaries in source text", () => {
  it.each([
    ["AcmeFlow", "SuperAcmeFlow"],
    ["Microsoft Team", "Microsoft Teamsters"],
    ["Microsoft Teams", "SuperMicrosoft Teams"],
  ])("rejects a cropped %s identity quote", (product, sourceName) => {
    expect(() =>
      validateModelLabel(
        {
          ...label(),
          identityQuote: product,
          aspects: [],
        },
        { ...raw(), text: `${sourceName} is slow.` },
        product,
        "",
      ),
    ).toThrow("identity span");
  });
  it("accepts a later exact full-name occurrence with valid boundaries", () => {
    expect(
      validateModelLabel(
        { ...label(), aspects: [] },
        {
          ...raw(),
          text: "SuperAcmeFlow differs from AcmeFlow.",
        },
        "AcmeFlow",
        "",
      ).relevant,
    ).toBe(true);
  });
});

describe("one bounded model repair pass", () => {
  it.each([
    [
      "unsupported source quote",
      {
        aspects: [
          {
            aspect: "pricing",
            sentiment: "positive",
            quote: "invented repair target",
          },
        ],
      },
    ],
    ["unsupported product identity", { identityQuote: "pricing is fair" }],
    ["invalid record schema", { relevant: "yes" }],
    ["duplicate aspect", { aspects: [label().aspects[0], label().aspects[0]] }],
    ["inconsistent relevance or identity", { relevant: false }],
  ])(
    "repairs %s once without resending valid neighbors",
    async (reason, invalid) => {
      const neighbor = {
        ...raw(),
        id: "verified-neighbor",
        text: `${raw().text} My experience.`,
      };
      const bodies: Array<{ input: Array<{ content: string }> }> = [];
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (bodies.length === 1)
          return response([
            { ...label(), ...invalid },
            { ...label(), id: neighbor.id },
          ]);
        return response([label()]);
      });
      vi.stubGlobal("fetch", fetcher);
      const progress: number[] = [];
      const scope = { ...context, sessionId: `successful-repair-${reason}` };
      const result = await analyze([raw(), neighbor], scope, {
        ...options("openai"),
        onProgress: (count) => progress.push(count),
      });
      expect(result.failures).toEqual([]);
      expect(result.records.map((r) => r.extractionStatus)).toEqual([
        "verified",
        "verified",
      ]);
      expect(result.records[0]?.aspects).toEqual(label().aspects);
      expect(progress).toEqual([1, 2]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const repairInput = JSON.parse(bodies[1]!.input[1]!.content);
      expect(repairInput.product).toBe(context.product);
      expect(repairInput.records).toEqual([
        {
          id: raw().id,
          text: raw().text,
          threadTitle: raw().threadTitle,
          parentText: "",
          validationIssue: reason,
        },
      ]);
      expect(bodies[1]!.input[0]!.content).toContain(
        "Re-label each original record once",
      );
      expect(bodies[1]!.input[0]!.content).toContain(
        "A feature name alone does not support",
      );
      expect(JSON.stringify(bodies[1])).not.toContain("invented repair target");
      await analyze(
        [raw(), neighbor],
        { ...scope, snapshotVersion: 2 },
        options("openai"),
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it("keeps a permanently unsupported quote failed after exactly two calls", async () => {
    const fetcher = vi.fn(async () =>
      response([
        {
          ...label(),
          aspects: [
            {
              aspect: "pricing",
              sentiment: "positive",
              quote: "still invented",
            },
          ],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await analyze(
      [raw()],
      { ...context, sessionId: "permanent-repair-failure" },
      options("openai"),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.records[0]).toMatchObject({
      extractionStatus: "failed",
      relevant: false,
      aspects: [],
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("unsupported source quote: 1");
  });
  it("does not retry network failures", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("PRIVATE NETWORK FAILURE");
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await analyze(
      [raw()],
      { ...context, sessionId: "repair-network-failure" },
      options("openai"),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.records[0]?.extractionStatus).toBe("failed");
    expect(result.failures[0]).toContain("provider request failed: 1");
    expect(JSON.stringify(result)).not.toContain("PRIVATE NETWORK FAILURE");
  });
  it("stops on repair access failure and retains the already verified neighbors", async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      ...raw(),
      id: `repair-access-${i}`,
      text: `${raw().text} Record ${i}.`,
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          records.slice(0, 4).map((record, i) => ({
            ...label(),
            id: record.id,
            ...(i === 0 ? { identityQuote: "pricing is fair" } : {}),
          })),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "PRIVATE ACCESS FAILURE",
              type: "invalid_request_error",
            },
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await analyze(
      records,
      { ...context, sessionId: "repair-access-failure" },
      options("openai"),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.records.map((record) => record.extractionStatus)).toEqual([
      "failed",
      "verified",
      "verified",
      "verified",
      "failed",
    ]);
    expect(result.failures[0]).toContain(
      "provider HTTP 403: 1; not attempted after provider HTTP 403: 1",
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE ACCESS FAILURE");
  });
});
