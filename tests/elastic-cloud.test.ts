import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  ElasticCloud,
  cloudScopeQuery,
  cloudStatsQuery,
  diverseCloudComments,
} from "../src/server/elastic-cloud.js";
import {
  elasticQuerySchema,
  type ElasticComment,
} from "../src/shared/contracts.js";
const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  close: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@elastic/elasticsearch", () => ({
  Client: vi.fn(function () {
    return { search: mocks.search, close: mocks.close };
  }),
}));
const options = {
  url: "https://search.example.test",
  kibanaUrl: "https://kibana.example.test",
  apiKey: "placeholder-secret",
  index: "youtube-product-comments",
};
const input = elasticQuerySchema.parse({
  question: "What are the concrete Teams problems?",
  requestId: "request-one",
});
const videoIds = ["L4j4oGbfRy4", "HOQdEsI4dgo", "NNui0axypdM", "yyRddSjm19I"];
const records = Array.from({ length: 240 }, (_, i) => ({
  id: `comment_${i}`,
  text: `Teams calls freeze when I share my screen. Original comment ${i}.`,
  video_id: videoIds[i < 200 ? 0 : i < 225 ? 1 : i < 237 ? 2 : 3],
  video_title: i < 200 ? "Teams discussion" : "Product experience",
  published_at: "2025-02-08T19:52:11Z",
  sentiment: i < 150 ? "positive" : i < 202 ? "negative" : "neutral",
  is_complaint: i >= 188,
  issue_categories: i >= 188 ? ["performance"] : [],
  like_count: 240 - i,
}));
function response(items = records, total = 240) {
  const videoBuckets = [...new Set(items.map((x) => x.video_id))].map((id) => {
    const group = items.filter((x) => x.video_id === id);
    return {
      key: id,
      doc_count: group.length,
      complaints: { doc_count: group.filter((x) => x.is_complaint).length },
      title: {
        hits: { hits: [{ _source: { video_title: group[0].video_title } }] },
      },
      examples: {
        hits: { hits: group.slice(0, 4).map((x) => ({ _source: x })) },
      },
    };
  });
  return {
    timed_out: false,
    _shards: { failed: 0 },
    hits: {
      total: { value: items.length, relation: "eq" },
      hits: items
        .slice(0, 500)
        .map((x) => ({ _id: `elastic-hash-${x.id}`, _source: x })),
    },
    aggregations: {
      corpus: { doc_count: total },
      positive: {
        doc_count: items.filter((x) => x.sentiment === "positive").length,
      },
      negative: {
        doc_count: items.filter((x) => x.sentiment === "negative").length,
      },
      neutral: {
        doc_count: items.filter((x) => x.sentiment === "neutral").length,
      },
      complaints: { doc_count: items.filter((x) => x.is_complaint).length },
      earliest: {
        value_as_string: items.length ? "2025-02-08T19:52:11.000Z" : undefined,
      },
      latest: {
        value_as_string: items.length ? "2025-02-08T19:52:11.000Z" : undefined,
      },
      videos: {
        sum_other_doc_count: 0,
        doc_count_error_upper_bound: 0,
        buckets: videoBuckets,
      },
      categories: {
        sum_other_doc_count: 0,
        doc_count_error_upper_bound: 0,
        buckets: [],
      },
    },
  };
}
function tool(items = records) {
  const groups = new Map<string, [number, string, boolean]>();
  for (const item of items) {
    const key = `${item.sentiment}/${item.is_complaint}`;
    const row = groups.get(key) || [0, item.sentiment, item.is_complaint];
    row[0]++;
    groups.set(key, row);
  }
  return {
    results: [
      {
        type: "esql_results",
        data: {
          columns: [
            { name: "records" },
            { name: "sentiment" },
            { name: "is_complaint" },
          ],
          values: [...groups.values()],
        },
      },
    ],
  };
}
function generated(ids = ["comment_0", "comment_200"]) {
  return {
    status: "completed",
    conversation_id: "provider-private-id",
    response: {
      message: JSON.stringify({
        summary:
          "The original comments report calls freezing during screen sharing. This sample does not establish the current experience of all customers.",
        findings: ids.map((id) => ({
          id,
          quote: "Teams calls freeze when I share my screen.",
          interpretation:
            "A commenter reports call freezing during screen sharing.",
        })),
      }),
    },
    steps: [],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.search.mockResolvedValue(response());
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(url.endsWith("_execute") ? tool() : generated()),
        { status: 200 },
      ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("read-only Elastic Cloud query", () => {
  it("counts all 240 records and calls fixed ESQL before tool-free Agent Builder", async () => {
    const result = await new ElasticCloud(options).query(input);
    expect(result.metrics).toMatchObject({
      totalRecords: 240,
      scopedRecords: 240,
      positive: 150,
      negative: 52,
      neutral: 38,
      complaints: 52,
      distinctVideos: 4,
    });
    expect(result.metrics.videos.map((x) => x.count)).toEqual([200, 25, 12, 3]);
    expect(result.examples[0].id).toBe("comment_0");
    expect(result.examples[1].id).toBe("comment_200");
    expect(result.examples[0].url).toBe(
      "https://www.youtube.com/watch?v=L4j4oGbfRy4&lc=comment_0",
    );
    expect(result.answer).toContain("[1]");
    expect(result.answer).toContain("[2]");
    const [search, searchOptions] = mocks.search.mock.calls[0];
    expect(search).toMatchObject({
      index: options.index,
      size: 500,
      track_total_hits: true,
      allow_partial_search_results: false,
    });
    expect(search._source).not.toContain("author");
    expect(searchOptions.signal).toBeInstanceOf(AbortSignal);
    const request = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(request).toEqual({
      tool_id: "platform.core.execute_esql",
      tool_params: { query: cloudStatsQuery(options.index, input.scope) },
    });
    const narrative = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(narrative.configuration_overrides).toMatchObject({
      enable_elastic_capabilities: false,
      skill_ids: [],
      tools: [],
    });
    expect(narrative.configuration_overrides.instructions).toContain(
      "Microsoft Loop",
    );
    expect(narrative.configuration_overrides.instructions).toContain(
      "product field",
    );
    expect(narrative).not.toHaveProperty("conversation_id");
    expect(JSON.parse(narrative.input).comments).toHaveLength(240);
    expect(JSON.stringify(result)).not.toContain("provider-private-id");
    expect(JSON.stringify(result)).not.toContain("placeholder-secret");
    expect(result.limitations.join(" ")).toContain("supplied with the corpus");
  });
  it("applies identical exclusions and date limits to count and source reads", async () => {
    const selected = records.filter((x) => x.video_id !== videoIds[0]);
    mocks.search.mockResolvedValue(response(selected));
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("_execute")
              ? tool(selected)
              : generated(["comment_200", "comment_237"]),
          ),
          { status: 200 },
        ),
    );
    const result = await new ElasticCloud(options).query({
      ...input,
      scope: {
        excludedVideoIds: [videoIds[0]],
        from: "2025-01-01T00:00:00.000Z",
        to: "2025-03-01T00:00:00.000Z",
      },
    });
    expect(result.metrics.scopedRecords).toBe(40);
    expect(result.metrics.totalRecords).toBe(240);
    expect(result.examples.every((x) => x.videoId !== videoIds[0])).toBe(true);
    expect(JSON.stringify(mocks.search.mock.calls[0][0].query)).toContain(
      "must_not",
    );
    expect(JSON.stringify(mocks.fetch.mock.calls[0][1].body)).toContain(
      "NOT (video_id IN",
    );
    expect(JSON.stringify(mocks.fetch.mock.calls[0][1].body)).toContain(
      "TO_DATETIME",
    );
  });
  it("keeps original text when its stored positive label conflicts with a complaint", async () => {
    const selected = [
      {
        ...records[0],
        text: "Calls keep freezing; I cannot finish meetings.",
        is_complaint: true,
      },
    ];
    mocks.search.mockResolvedValue(response(selected, 1));
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("_execute")
              ? tool(selected)
              : {
                  status: "completed",
                  response: {
                    message: JSON.stringify({
                      summary: "A commenter reports frozen calls.",
                      findings: [
                        {
                          id: selected[0].id,
                          quote: selected[0].text,
                          interpretation: "Calls freeze during meetings.",
                        },
                      ],
                    }),
                  },
                },
          ),
          { status: 200 },
        ),
    );
    const result = await new ElasticCloud(options).query(input);
    expect(result.metrics).toMatchObject({ positive: 1, complaints: 1 });
    expect(result.answer).toContain(selected[0].text);
    expect(result.examples[0].sentiment).toBe("positive");
    expect(result.examples[0].isComplaint).toBe(true);
  });
  it.each(["unknown id", "invented quote", "duplicate id", "invalid json"])(
    "falls back to source facts for %s",
    async (mode) => {
      const bad = generated();
      const data = JSON.parse(bad.response.message);
      if (mode === "unknown id") data.findings[0].id = "elsewhere";
      if (mode === "invented quote")
        data.findings[0].quote = "Invented exact quote in no comment.";
      if (mode === "duplicate id") data.findings[1].id = data.findings[0].id;
      bad.response.message =
        mode === "invalid json"
          ? "unstructured agent answer"
          : JSON.stringify(data);
      mocks.fetch.mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(url.endsWith("_execute") ? tool() : bad),
            { status: 200 },
          ),
      );
      const result = await new ElasticCloud(options).query(input);
      if (mode === "invalid json")
        expect(result.answer).toContain("could not be checked");
      else {
        expect(result.answer).toContain("[1]");
        expect(result.answer).not.toContain("[2]");
      }
      expect(result.answer).toContain("Stored labels mark 52");
      expect(result.answer).not.toContain("Invented exact quote");
      expect(result.limitations.join(" ")).toContain(
        "failed exact citation validation",
      );
    },
  );
  it("preserves valid citation neighbors and drops a summary that relied on an invalid finding", async () => {
    const mixed = generated();
    const data = JSON.parse(mixed.response.message);
    data.summary = "An unsupported claim in the summary.";
    data.findings[0].quote = "An unsupported quote.";
    mixed.response.message = JSON.stringify(data);
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith("_execute") ? tool() : mixed),
          { status: 200 },
        ),
    );
    const result = await new ElasticCloud(options).query(input);
    expect(result.answer).not.toContain("unsupported");
    expect(result.answer).toContain("The selected scope contains 240");
    expect(result.answer).toContain(
      "Teams calls freeze when I share my screen.",
    );
    expect(result.examples[0].id).toBe("comment_200");
    expect(result.answer).toContain("[1]");
    expect(result.answer).not.toContain("[2]");
  });
  it("renders only server counts and assigned citations, never model summary or interpretation", async () => {
    const reply = generated();
    const data = JSON.parse(reply.response.message);
    data.summary = "239 of 240 customers dislike Teams. See [12].";
    data.findings[0].interpretation = "999 complaints prove this claim [9].";
    reply.response.message = JSON.stringify(data);
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith("_execute") ? tool() : reply),
          { status: 200 },
        ),
    );
    const result = await new ElasticCloud(options).query(input);
    expect(result.answer).toContain(
      "The selected scope contains 240 comments from 4 videos.",
    );
    expect(result.answer).toContain("Stored labels mark 52 as complaints");
    expect(result.answer).toContain("unverified uploaded metadata");
    expect(result.answer).toContain(
      "does not establish the experience of all customers",
    );
    expect(result.answer).not.toContain("239");
    expect(result.answer).not.toContain("999");
    expect(result.answer.match(/\[\d+\]/g)).toEqual(["[1]", "[2]"]);
  });
  it("accepts the extractive response format without a summary or interpretation", async () => {
    const reply = generated();
    reply.response.message = JSON.stringify({
      findings: [{ id: "comment_0", quote: records[0].text }],
    });
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith("_execute") ? tool() : reply),
          { status: 200 },
        ),
    );
    const result = await new ElasticCloud(options).query(input);
    expect(result.answer).toContain(`“${records[0].text}” [1]`);
    expect(result.limitations.join(" ")).not.toContain(
      "failed exact citation validation",
    );
  });
  it.each([
    [
      "Teams is not reliable for calls. A separate sentence.",
      "reliable for calls.",
      "Teams is not reliable for calls.",
    ],
    [
      "I cannot say Teams is reliable for calls; it still freezes.",
      "Teams is reliable for calls",
      "I cannot say Teams is reliable for calls; it still freezes.",
    ],
    [
      "A previous sentence. Calls freeze. They also drop while sharing screens. A later sentence.",
      "freeze. They also drop",
      "Calls freeze. They also drop while sharing screens.",
    ],
  ])(
    "restores complete original sentence context for %s",
    async (text, quote, context) => {
      const selected = [{ ...records[0], text }];
      const reply = generated([selected[0].id]);
      reply.response.message = JSON.stringify({
        summary: "Unsupported positive conclusion.",
        findings: [
          {
            id: selected[0].id,
            quote,
            interpretation: "Teams is reliable for calls.",
          },
        ],
      });
      mocks.search.mockResolvedValue(response(selected, 1));
      mocks.fetch.mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(url.endsWith("_execute") ? tool(selected) : reply),
            { status: 200 },
          ),
      );
      const result = await new ElasticCloud(options).query(input);
      expect(result.answer).toContain(`“${context}” [1]`);
      expect(result.answer).not.toContain("Unsupported positive conclusion");
      expect(result.answer).not.toContain("Teams is reliable for calls. “");
      expect(result.examples[0].text).toBe(text);
      expect(result.limitations.join(" ")).not.toContain(
        "failed exact citation validation",
      );
    },
  );
  it("rejects a quote cropped from inside a source word", async () => {
    const selected = [
      { ...records[0], text: "Teams is unreliable for daily calls." },
    ];
    const reply = generated([selected[0].id]);
    reply.response.message = JSON.stringify({
      findings: [{ id: selected[0].id, quote: "reliable for daily calls." }],
    });
    mocks.search.mockResolvedValue(response(selected, 1));
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith("_execute") ? tool(selected) : reply),
          { status: 200 },
        ),
    );
    const result = await new ElasticCloud(options).query(input);
    expect(result.answer).toContain("could not be checked");
    expect(result.answer).not.toContain("[1]");
    expect(result.examples[0].text).toBe(selected[0].text);
  });
  it("does not turn source-authored bracketed numbers into assigned citations", async () => {
    const selected = [
      { ...records[0], text: "Calls freeze; see [12] for more detail." },
      records[200],
    ];
    const reply = generated(selected.map((record) => record.id));
    reply.response.message = JSON.stringify({
      findings: selected.map((record) => ({
        id: record.id,
        quote: record.text,
      })),
    });
    mocks.search.mockResolvedValue(response(selected, 2));
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith("_execute") ? tool(selected) : reply),
          { status: 200 },
        ),
    );
    const result = await new ElasticCloud(options).query(input);
    expect(result.answer).not.toContain("[12]");
    expect(result.answer.match(/\[\d+\]/g)).toEqual(["[1]"]);
    expect(result.examples[0].id).toBe(records[200].id);
    expect(
      result.examples.find((record) => record.id === selected[0].id)?.text,
    ).toBe(selected[0].text);
  });
  it("rejects an unfinished Agent Builder answer", async () => {
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("_execute")
              ? tool()
              : { ...generated(), status: "awaiting_prompt" },
          ),
          { status: 200 },
        ),
    );
    await expect(new ElasticCloud(options).query(input)).rejects.toThrow(
      "did not complete",
    );
  });
  it("does not call the model when count reads disagree", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify(tool(records.slice(1))), { status: 200 }),
    );
    await expect(new ElasticCloud(options).query(input)).rejects.toThrow(
      "reads disagreed",
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["partial", "truncated", "out-of-scope", "inexact hits"])(
    "rejects %s source results before Agent Builder",
    async (mode) => {
      const search = response();
      if (mode === "partial") search._shards.failed = 1;
      if (mode === "truncated")
        search.aggregations.videos.sum_other_doc_count = 1;
      if (mode === "inexact hits") search.hits.total.relation = "gte";
      mocks.search.mockResolvedValue(search);
      const scoped =
        mode === "out-of-scope"
          ? {
              ...input,
              scope: { ...input.scope, excludedVideoIds: [videoIds[0]] },
            }
          : input;
      await expect(
        new ElasticCloud(options).query(scoped),
      ).rejects.toMatchObject({ category: "provider" });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it("returns an empty scope without a paid model request", async () => {
    mocks.search.mockResolvedValue(response([]));
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify(tool([])), { status: 200 }),
    );
    const result = await new ElasticCloud(options).query(input);
    expect(result.metrics.scopedRecords).toBe(0);
    expect(result.answer).toContain("No comments");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 404, 503])(
    "sanitizes HTTP %s and never retries",
    async (status) => {
      mocks.fetch.mockResolvedValue(
        new Response("raw secret provider body", { status }),
      );
      try {
        await new ElasticCloud(options).query(input);
        throw new Error("Unexpected success");
      } catch (error) {
        expect(error).toMatchObject({ statusCode: status });
        expect(String(error)).not.toContain("raw secret");
      }
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("honors cancellation before reads", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private reason"));
    await expect(
      new ElasticCloud(options).query(input, controller.signal),
    ).rejects.toMatchObject({ category: "timeout" });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("honors cancellation between query steps", async () => {
    const controller = new AbortController();
    mocks.search.mockImplementation(async () => {
      controller.abort();
      return response();
    });
    await expect(
      new ElasticCloud(options).query(input, controller.signal),
    ).rejects.toMatchObject({ category: "timeout" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects an unexpected model tool call", async () => {
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("_execute")
              ? tool()
              : {
                  ...generated(),
                  steps: [{ type: "tool_call", tool_id: "unexpected" }],
                },
          ),
          { status: 200 },
        ),
    );
    await expect(new ElasticCloud(options).query(input)).rejects.toThrow(
      "unexpected tool call",
    );
  });
  it("bounds whole-comment context and reports selection without reducing counts", async () => {
    const large = records.map((item) => ({
      ...item,
      text: item.text + " More context.".repeat(1000),
    }));
    mocks.search.mockResolvedValue(response(large));
    const result = await new ElasticCloud(options).query(input);
    const context = JSON.parse(
      JSON.parse(mocks.fetch.mock.calls[1][1].body).input,
    );
    expect(context.comments.length).toBeLessThan(240);
    expect(context.comments.length).toBeGreaterThan(4);
    expect(JSON.stringify(context.comments).length).toBeLessThan(101_000);
    expect(
      new Set(context.comments.map((x: ElasticComment) => x.videoId)).size,
    ).toBe(4);
    expect(result.metrics.scopedRecords).toBe(240);
    expect(result.limitations.join(" ")).toContain(
      "selected original comments",
    );
  });
  it("rejects reversed dates and wildcard indexes without provider calls", async () => {
    expect(() => new ElasticCloud({ ...options, index: "*" })).toThrow(
      "exact Elastic corpus",
    );
    await expect(
      new ElasticCloud(options).query({
        ...input,
        scope: {
          ...input.scope,
          from: "2026-01-01T00:00:00.000Z",
          to: "2025-01-01T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow("start date");
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("uses a fixed read query and keeps the user question out of ES|QL", () => {
    expect(cloudStatsQuery(options.index, input.scope)).toBe(
      "FROM youtube-product-comments | STATS records = COUNT(*) BY sentiment, is_complaint | SORT sentiment, is_complaint | LIMIT 100",
    );
    expect(cloudScopeQuery(input.scope)).toEqual({
      bool: { filter: [], must_not: [] },
    });
  });
  it("interleaves groups before a large video fills the context", () => {
    const source = records.slice(0, 10).map(
      (item) =>
        ({
          id: item.id,
          text: item.text,
          videoId: item.video_id,
          sentiment: item.sentiment,
          isComplaint: item.is_complaint,
        }) as ElasticComment,
    );
    source.push({ ...source[0], id: "small", videoId: videoIds[1] });
    expect(diverseCloudComments(source)[1].id).toBe("small");
  });
});
