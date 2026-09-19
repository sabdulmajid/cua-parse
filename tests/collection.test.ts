import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collect,
  discoveryQueries,
  htmlToText,
  validateReferenceUrl,
} from "../src/server/collection.js";
import type {
  CollectionOptions,
  RawRecord,
  StartInput,
} from "../src/shared/contracts.js";
const options = (): CollectionOptions => ({
  maxThreads: 10,
  maxItems: 150,
  concurrency: 2,
  signal: new AbortController().signal,
});
const input = (mode: StartInput["mode"] = "fixture"): StartInput => ({
  product: "AcmeFlow",
  question: "What about pricing and onboarding?",
  mode,
  idempotencyKey: "test-collection",
});
const imported = (): RawRecord => ({
  id: "import:one",
  text: "Original AcmeFlow comment.",
  url: "https://example.com/feedback/1",
  threadId: "import:thread",
  threadTitle: "AcmeFlow feedback",
  parentId: null,
  publishedAt: null,
  collectedAt: "2026-09-19T12:00:00.000Z",
  source: "import",
  provenance: "imported",
});
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
afterEach(() => vi.unstubAllGlobals());

describe("source text and reference safety", () => {
  it("decodes entities and preserves visible text without executing markup", () => {
    expect(
      htmlToText(
        "A &amp; B<p>Price &#36;5 &lt; 8<br>It&#39;s <i>useful</i>.</p><script>steal()</script>",
      ),
    ).toBe("A & B\nPrice $5 < 8\nIt's useful.");
    expect(htmlToText("&lt;script&gt;literal&lt;/script&gt;")).toBe(
      "<script>literal</script>",
    );
  });
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://127.0.0.1/x",
    "http://[::1]/x",
    "https://user:password@example.com/x",
    "http://service.local/x",
    "http://localhost/x",
    "http://localhost./x",
    "https://service.local./x",
    "https://service.internal./x",
    "https://sub.localhost../x",
    "http://192.168.1.1./x",
    "https://example.com:8000/x",
  ])("rejects unsafe imported link %s", (url) =>
    expect(() => validateReferenceUrl(url)).toThrow(),
  );
  it("preserves a safe source reference and null", () => {
    expect(validateReferenceUrl("https://example.com/feedback/1")).toBe(
      "https://example.com/feedback/1",
    );
    expect(validateReferenceUrl(null)).toBeNull();
    expect(validateReferenceUrl("https://example.com./feedback/1")).toBe(
      "https://example.com/feedback/1",
    );
  });
});

describe("offline adapters", () => {
  it("makes synthetic provenance explicit and never claims a search", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await collect(input(), options());
    expect(result.records).toHaveLength(22);
    expect(
      result.records.every(
        (record) => record.url === null && record.provenance === "synthetic",
      ),
    ).toBe(true);
    expect(result.attempts[0]?.message).toContain("No web search");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      collect({ ...input(), product: "Another product" }, options()),
    ).rejects.toThrow("only for AcmeFlow");
  });
  it("imports exact text and explicit provenance without fetching URLs", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const record = imported();
    const result = await collect(
      { ...input("import"), records: [record] },
      options(),
    );
    expect(result.records[0]).toEqual(record);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      collect(
        { ...input("import"), records: [{ ...record, provenance: "live" }] },
        options(),
      ),
    ).rejects.toThrow("provenance=imported");
  });
  it("rejects conflicting IDs, invalid dates and over-limit imports", async () => {
    const record = imported();
    await expect(
      collect(
        {
          ...input("import"),
          records: [record, { ...record, text: "different" }],
        },
        options(),
      ),
    ).rejects.toThrow("conflicting");
    await expect(
      collect(
        {
          ...input("import"),
          records: [{ ...record, publishedAt: "yesterday" }],
        },
        options(),
      ),
    ).rejects.toThrow();
    await expect(
      collect(
        {
          ...input("import"),
          records: [record, { ...record, id: "import:two" }],
        },
        { ...options(), maxItems: 1 },
      ),
    ).rejects.toThrow("item cap");
  });
  it.each([
    { threadId: "other-thread" },
    { threadTitle: "Another product" },
    { parentId: "other-parent" },
    { url: "https://example.org/other" },
    { publishedAt: "2026-09-01T00:00:00.000Z" },
  ])(
    "rejects conflicting imported metadata for the same ID: %j",
    async (change) => {
      const record = imported();
      await expect(
        collect(
          { ...input("import"), records: [record, { ...record, ...change }] },
          options(),
        ),
      ).rejects.toThrow("conflicting content or metadata");
    },
  );
  it("permits repeated imported observations with only a different collection time", async () => {
    const record = imported();
    const result = await collect(
      {
        ...input("import"),
        records: [
          record,
          { ...record, collectedAt: "2026-09-20T00:00:00.000Z" },
        ],
      },
      options(),
    );
    expect(result.records).toHaveLength(2);
  });
  it("supports a genuinely empty import", async () =>
    expect(
      (await collect({ ...input("import"), records: [] }, options())).records,
    ).toEqual([]));
  it("cancels before any source request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(input("live"), { ...options(), signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("bounded HN adapter with explicit mocked HTTP", () => {
  it("uses neutral and targeted queries", () =>
    expect(discoveryQueries("AcmeFlow", "pricing and onboarding")).toEqual([
      "AcmeFlow",
      "AcmeFlow pricing",
      "AcmeFlow onboarding",
    ]));
  it("adds a complaint query for a broad negative question without removing neutral discovery", () => {
    expect(
      discoveryQueries("Microsoft Teams", "What sucks about Microsoft Teams?"),
    ).toEqual(["Microsoft Teams", "Microsoft Teams complaints"]);
    expect(
      discoveryQueries("Microsoft Teams", "What pricing problems are there?"),
    ).toEqual(["Microsoft Teams", "Microsoft Teams pricing"]);
    expect(discoveryQueries("Microsoft Teams", "How is it used?")).toEqual([
      "Microsoft Teams",
      "Microsoft Teams experience",
    ]);
  });
  it.each([1, 2])(
    "shares the record cap across large threads at concurrency %i in stable order",
    async (concurrency) => {
      const requested: number[] = [];
      const fetcher = vi.fn(async (value: URL) => {
        if (value.origin === "https://hn.algolia.com")
          return json({ hits: [{ objectID: "1000" }, { objectID: "2000" }] });
        const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
        requested.push(id);
        if (id % 1000 === 0)
          return json({
            id,
            type: "story",
            title: `Thread ${id}`,
            kids: Array.from({ length: 80 }, (_, i) => id + i + 1),
          });
        // A slower first thread must not change the order of accepted records.
        if (id < 2000) await new Promise((resolve) => setTimeout(resolve, 1));
        return json({
          id,
          type: "comment",
          parent: Math.floor(id / 1000) * 1000,
          text: `AcmeFlow feedback ${id}`,
        });
      });
      vi.stubGlobal("fetch", fetcher);
      const result = await collect(input("live"), {
        ...options(),
        maxThreads: 2,
        maxItems: 24,
        concurrency,
      });
      expect(result.records).toHaveLength(24);
      expect(
        result.records.filter((record) => record.threadId === "hn:1000"),
      ).toHaveLength(12);
      expect(
        result.records.filter((record) => record.threadId === "hn:2000"),
      ).toHaveLength(12);
      expect(result.records.map((record) => record.id)).toEqual(
        Array.from({ length: 12 }, (_, i) => [
          `hn:${1001 + i}`,
          `hn:${2001 + i}`,
        ]).flat(),
      );
      expect(
        result.records.every(
          (record) =>
            record.provenance === "live" && record.source === "hackernews",
        ),
      ).toBe(true);
      expect(requested).toHaveLength(26);
      expect(new Set(requested).size).toBe(requested.length);
      expect(result.failures).toEqual([]);
    },
  );
  it("shares a full pending queue across all threads while preserving early reply order", async () => {
    const roots = [1000, 2000, 3000, 4000];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: URL) => {
        if (value.origin === "https://hn.algolia.com")
          return json({ hits: roots.map((id) => ({ objectID: String(id) })) });
        const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
        return id % 1000 === 0
          ? json({
              id,
              type: "story",
              kids: Array.from({ length: 150 }, (_, i) => id + i + 1),
            })
          : json({ id, type: "comment", text: `AcmeFlow feedback ${id}` });
      }),
    );
    const result = await collect(input("live"), {
      ...options(),
      maxThreads: 4,
      maxItems: 12,
    });
    expect(result.records.map((record) => record.id)).toEqual(
      Array.from({ length: 3 }, (_, i) =>
        roots.map((id) => `hn:${id + i + 1}`),
      ).flat(),
    );
    expect(
      result.attempts.find((attempt) => attempt.query === "Collection limit")
        ?.message,
    ).toContain("pending queue");
  });
  it("keeps breadth-first order inside each thread and fetches shared IDs once", async () => {
    const items: Record<number, unknown> = {
      100: { id: 100, type: "story", kids: [101, 102] },
      200: { id: 200, type: "story", kids: [201, 202] },
      101: { id: 101, type: "comment", text: "First", kids: [103, 102] },
      102: { id: 102, type: "comment", text: "Second", kids: [103] },
      103: { id: 103, type: "comment", text: "Nested", kids: [101] },
      201: { id: 201, type: "comment", text: "Other first" },
      202: { id: 202, type: "comment", text: "Other second" },
    };
    const requested: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: URL) => {
        if (value.origin === "https://hn.algolia.com")
          return json({ hits: [{ objectID: "100" }, { objectID: "200" }] });
        const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
        requested.push(id);
        return json(items[id]);
      }),
    );
    const result = await collect(input("live"), {
      ...options(),
      maxThreads: 2,
      maxItems: 6,
    });
    expect(result.records.map((record) => record.id)).toEqual([
      "hn:101",
      "hn:201",
      "hn:102",
      "hn:202",
      "hn:103",
    ]);
    expect(new Set(requested).size).toBe(requested.length);
  });
  it("reassigns turns from sparse, dead and empty threads to available feedback", async () => {
    const requested: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: URL) => {
        if (value.origin === "https://hn.algolia.com")
          return json({
            hits: [100, 200, 300, 400].map((id) => ({ objectID: String(id) })),
          });
        const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
        requested.push(id);
        if (id === 100) return json({ id, type: "story", dead: true });
        if (id === 200) return json({ id, type: "story" });
        if (id === 300)
          return json({
            id,
            type: "story",
            kids: Array.from({ length: 20 }, (_, i) => 301 + i),
          });
        if (id === 400) return json({ id, type: "story", kids: [401] });
        return json({ id, type: "comment", text: `AcmeFlow feedback ${id}` });
      }),
    );
    const result = await collect(input("live"), {
      ...options(),
      maxThreads: 4,
      maxItems: 8,
    });
    expect(result.records).toHaveLength(8);
    expect(
      result.records.filter((record) => record.threadId === "hn:300"),
    ).toHaveLength(7);
    expect(
      result.records.filter((record) => record.threadId === "hn:400"),
    ).toHaveLength(1);
    expect(requested).not.toContain(101);
    expect(requested).toHaveLength(12);
    expect(result.failures).toEqual([]);
  });
  it.each(["deleted", "dead"])(
    "traverses valid descendants while omitting a %s parent's text",
    async (flag) => {
      const requested: number[] = [];
      const originals: Record<number, object> = {
        100: {
          id: 100,
          type: "story",
          title: "AcmeFlow feedback",
          kids: [101],
        },
        101: {
          id: 101,
          type: "comment",
          text: "REMOVED ORIGINAL MUST NOT BE RETAINED",
          [flag]: true,
          kids: [102],
        },
        102: {
          id: 102,
          type: "comment",
          parent: 101,
          text: "AcmeFlow freezes every morning.",
          kids: [101],
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (value: URL) => {
          if (value.origin === "https://hn.algolia.com")
            return json({ hits: [{ objectID: "100" }] });
          expect(value.origin).toBe("https://hacker-news.firebaseio.com");
          const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
          requested.push(id);
          return json(originals[id]);
        }),
      );
      const result = await collect(input("live"), {
        ...options(),
        maxItems: 1,
        maxThreads: 1,
      });
      expect(requested).toEqual([100, 101, 102]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        id: "hn:102",
        parentId: "hn:101",
        threadId: "hn:100",
        threadTitle: "AcmeFlow feedback",
      });
      expect(JSON.stringify(result)).not.toContain("REMOVED ORIGINAL");
      expect(result.failures).toEqual([]);
    },
  );
  it("does not traverse IDs from a mismatched source item", async () => {
    const requested: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: URL) => {
        if (value.origin === "https://hn.algolia.com")
          return json({ hits: [{ objectID: "100" }] });
        requested.push(Number(value.pathname.match(/(\d+)\.json/)?.[1]));
        return json({ id: 999, type: "story", deleted: true, kids: [101] });
      }),
    );
    const result = await collect(input("live"), options());
    expect(requested).toEqual([100]);
    expect(result.records).toEqual([]);
  });
  it("does not spend all requests on a thread full of deleted replies", async () => {
    let itemRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: URL) => {
        if (value.origin === "https://hn.algolia.com")
          return json({ hits: [{ objectID: "1000" }, { objectID: "2000" }] });
        const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
        itemRequests++;
        if (id % 1000 === 0)
          return json({
            id,
            type: "story",
            kids: Array.from({ length: 100 }, (_, i) => id + i + 1),
          });
        return json({
          id,
          type: "comment",
          text: `AcmeFlow feedback ${id}`,
          deleted: id < 2000,
        });
      }),
    );
    const result = await collect(input("live"), {
      ...options(),
      maxThreads: 2,
      maxItems: 6,
    });
    expect(result.records).toHaveLength(6);
    expect(
      result.records.every((record) => record.threadId === "hn:2000"),
    ).toBe(true);
    expect(itemRequests).toBe(14);
  });
  it("stops at the request cap when every reply is unusable", async () => {
    let itemRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: URL) => {
        if (value.origin === "https://hn.algolia.com")
          return json({ hits: [{ objectID: "1000" }, { objectID: "2000" }] });
        const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
        itemRequests++;
        return id % 1000 === 0
          ? json({
              id,
              type: "story",
              kids: Array.from({ length: 100 }, (_, i) => id + i + 1),
            })
          : json({ id, type: "comment", deleted: true });
      }),
    );
    const result = await collect(input("live"), {
      ...options(),
      maxThreads: 2,
      maxItems: 3,
    });
    expect(result.records).toEqual([]);
    expect(itemRequests).toBe(25);
    expect(
      result.attempts.find((attempt) => attempt.query === "Collection limit"),
    ).toBeDefined();
  });
  it("discovers threads and records original text, context and dates", async () => {
    const fetcher = vi.fn(async (value: URL) => {
      if (value.origin === "https://hn.algolia.com")
        return json({ hits: [{ objectID: "100" }] });
      if (value.pathname.endsWith("/100.json"))
        return json({
          id: 100,
          type: "story",
          title: "AcmeFlow &amp; teams",
          kids: [101, 102, 103],
        });
      if (value.pathname.endsWith("/101.json"))
        return json({
          id: 101,
          type: "comment",
          parent: 100,
          text: "AcmeFlow costs &#36;5.<p>Setup is <b>easy</b>.",
          time: 1720000000,
        });
      if (value.pathname.endsWith("/102.json"))
        return json({
          id: 102,
          type: "comment",
          parent: 100,
          text: "Do not retain this.",
          deleted: true,
        });
      return json({
        id: 103,
        type: "comment",
        parent: 101,
        text: "AcmeFlow is useful.",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await collect(input("live"), options());
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      text: "AcmeFlow costs $5.\nSetup is easy.",
      threadId: "hn:100",
      threadTitle: "AcmeFlow & teams",
      parentId: "hn:100",
      url: "https://news.ycombinator.com/item?id=101",
      source: "hackernews",
      provenance: "live",
    });
    expect(result.records[0]?.publishedAt).toBe(
      new Date(1720000000 * 1000).toISOString(),
    );
    expect(result.records[1]?.publishedAt).toBeNull();
    expect(result.records.some((record) => record.id === "hn:102")).toBe(false);
    expect(
      result.attempts.filter((attempt) => attempt.query.includes("AcmeFlow")),
    ).toHaveLength(3);
  });
  it("keeps concurrency, item count and all request origins bounded", async () => {
    let active = 0,
      maxActive = 0;
    const fetcher = vi.fn(async (value: URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect([
        "https://hn.algolia.com",
        "https://hacker-news.firebaseio.com",
      ]).toContain(value.origin);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      if (value.origin === "https://hn.algolia.com")
        return json({ hits: [{ objectID: "100" }, { objectID: "200" }] });
      const id = Number(value.pathname.match(/(\d+)\.json/)?.[1]);
      return json({
        id,
        type: id % 100 === 0 ? "story" : "comment",
        text: `AcmeFlow item ${id}`,
        title: "AcmeFlow",
        kids: Array.from({ length: 20 }, (_, i) => id + 1 + i),
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await collect(
      { ...input("live"), product: "https://127.0.0.1/admin" },
      { ...options(), maxThreads: 2, maxItems: 3, concurrency: 99 },
    );
    expect(result.records).toHaveLength(3);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(6);
    expect(
      result.attempts.some((attempt) => attempt.query === "Collection limit"),
    ).toBe(true);
  });
  it("reports discovery failures without fabricating evidence or leaking bodies", async () => {
    const fetcher = vi.fn(async () =>
      json({ private: "NEVER ECHO THIS" }, 403),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await collect(input("live"), options());
    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("NEVER ECHO THIS");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not retry a rate limit earlier than Retry-After", async () => {
    const fetcher = vi.fn(async () => json({}, 429, { "retry-after": "60" }));
    vi.stubGlobal("fetch", fetcher);
    const result = await collect(input("live"), options());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.failures.every((failure) => failure.includes("429"))).toBe(
      true,
    );
  });
  it("retries a transient response only once", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return calls % 2
        ? json({}, 503, { "retry-after": "0" })
        : json({ hits: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await collect(input("live"), options());
    expect(result.failures).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("rejects oversized responses and malformed discovery data", async () => {
    const fetcher = vi.fn(async () =>
      json({ hits: [{ objectID: "http://localhost" }] }, 200, {
        "content-length": "1000001",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await collect(input("live"), options());
    expect(result.records).toEqual([]);
    expect(
      result.failures.every((failure) => failure.includes("size limit")),
    ).toBe(true);
  });
});
