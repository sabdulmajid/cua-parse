import { describe, expect, it } from "vitest";
import {
  analyze,
  balancedEvidence,
  brief,
  defaultFilters,
  ImportError,
  IMPORT_LIMITS,
  normalizedDate,
  parseImport,
  products,
  safeSourceUrl,
  scopeRecords,
  searchEvidence,
} from "../src/workspace/model.js";
import { sampleDataset, sampleDatasets } from "../src/workspace/sample.js";

function normalized(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: "tenant-a",
    product_id: "product-a",
    external_id: "native-1",
    source: "hackernews",
    content: "A full original comment. This is not a slow product.",
    url: "https://news.ycombinator.com/item?id=123",
    published_at: "2026-09-20T10:00:00Z",
    source_metadata: {
      product_name: "Example",
      thread_id: "thread-a",
      thread_title: "A source thread",
      api_key: "removed-private-metadata",
    },
    ...overrides,
  };
}
function raw(overrides: Record<string, unknown> = {}) {
  return {
    id: "hackernews_native-1",
    source: "hackernews",
    product: "Example",
    text: "A full original comment. This is not a slow product.",
    thread_id: "thread-a",
    thread_title: "A source thread",
    created_at: "2026-09-20T10:00:00Z",
    ...overrides,
  };
}
const dataset = (...rows: unknown[]) => parseImport(JSON.stringify(rows));

describe("workspace imports", () => {
  it("accepts normalized JSON wrappers and raw CLI JSONL without inventing labels", () => {
    const imported = parseImport(
      JSON.stringify({
        records: [
          normalized({ author: "discard me", author_hash: "discard too" }),
        ],
      }),
    );
    expect(imported.records[0]).toMatchObject({
      product: "Example",
      sentiment: "unknown",
      relevant: null,
      isComplaint: null,
      issues: [],
      provenance: "imported",
    });
    expect(JSON.stringify(imported)).not.toContain("discard");
    expect(JSON.stringify(imported)).not.toContain("removed-private-metadata");
    expect(imported.records[0].text).toBe(normalized().content);
    const cli = parseImport(
      [raw(), raw({ id: "hackernews_native-2" })]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    expect(cli.records).toHaveLength(2);
    expect(
      cli.records.every(
        (record) =>
          record.sentiment === "unknown" && record.isComplaint === null,
      ),
    ).toBe(true);
    expect(
      parseImport(JSON.stringify({ documents: [raw()] })).records,
    ).toHaveLength(1);
  });
  it("preserves exact content, source names, and supplied labels", () => {
    const text = "  It is NOT broken.\nThe new setup works.  ";
    const imported = dataset(
      normalized({
        source: "special-source",
        content: text,
        sentiment: "POSITIVE",
        relevant: false,
        is_complaint: false,
        issue_categories: ["setup", "setup"],
      }),
    );
    expect(imported.records[0]).toMatchObject({
      source: "special-source",
      text,
      sentiment: "positive",
      relevant: false,
      isComplaint: false,
      issues: ["setup"],
    });
  });
  it("deduplicates identity, never identical text across sources, tenants or products", () => {
    const imported = dataset(
      normalized(),
      normalized({ content: "Replacement must not win." }),
      normalized({ external_id: "native-2" }),
      normalized({ source: "youtube" }),
      normalized({ organization_id: "tenant-b" }),
      normalized({ product_id: "product-b" }),
    );
    expect(imported.importReport).toMatchObject({
      inputRows: 6,
      acceptedRows: 5,
      rejectedRows: 0,
      duplicateRows: 1,
    });
    expect(new Set(imported.records.map((record) => record.id)).size).toBe(5);
    expect(products(imported)).toHaveLength(3);
    const tenantA = imported.records.find(
      (record) =>
        record.tenant === "tenant-a" && record.productId === "product-a",
    )!;
    expect(
      scopeRecords(imported, defaultFilters(tenantA.product)),
    ).toHaveLength(3);
    expect(
      scopeRecords(imported, defaultFilters(tenantA.product)).every(
        (record) =>
          record.tenant === "tenant-a" && record.productId === "product-a",
      ),
    ).toBe(true);
    expect(imported.records[0].text).toBe(normalized().content);
  });
  it("uses one canonical product label per identity and prevents adversarial display collisions", () => {
    const rows = [
      normalized({
        external_id: "a1",
        source_metadata: { product_name: "Foo" },
      }),
      normalized({
        external_id: "a2",
        source_metadata: { product_name: "Renamed Foo" },
      }),
      normalized({
        organization_id: "tenant-b",
        source_metadata: { product_name: "Foo" },
      }),
      normalized({
        product_id: "literal-name",
        source_metadata: { product_name: "Foo (tenant-a / product-a)" },
      }),
      normalized({
        product_id: "second-literal",
        source_metadata: { product_name: "Foo (tenant-a / product-a) [2]" },
      }),
    ];
    const imported = dataset(...rows);
    expect(products(imported)).toHaveLength(4);
    const first = imported.records[0];
    expect(first.product).toBe("Foo (tenant-a / product-a) [3]");
    expect(imported.records[1].product).toBe(first.product);
    expect(
      scopeRecords(imported, defaultFilters(first.product)).map(
        (record) => record.nativeId,
      ),
    ).toEqual(["a1", "a2"]);
    const reversed = dataset(...[...rows].reverse());
    expect(products(reversed)).toEqual(products(imported));
    for (const product of products(imported))
      expect(
        new Set(
          scopeRecords(imported, defaultFilters(product)).map((record) =>
            JSON.stringify([record.tenant, record.productId]),
          ),
        ).size,
      ).toBe(1);
  });
  it("reports bad rows and rejects all-invalid or malformed files with counts", () => {
    const imported = parseImport(
      `${JSON.stringify(raw())}\n{bad json}\n${JSON.stringify(raw({ id: "valid-2", text: "" }))}`,
    );
    expect(imported.importReport).toMatchObject({
      inputRows: 3,
      acceptedRows: 1,
      rejectedRows: 2,
    });
    expect(imported.importReport?.warnings).toHaveLength(2);
    for (const input of ["", "{}", "null", "{broken}", "[]"])
      expect(() => parseImport(input)).toThrow(ImportError);
    try {
      parseImport("{bad}\nnull");
    } catch (error) {
      expect(error).toMatchObject({
        report: { inputRows: 2, acceptedRows: 0, rejectedRows: 2 },
      });
    }
  });
  it("enforces byte, row and content limits before retaining data", () => {
    expect(() => parseImport("x".repeat(IMPORT_LIMITS.bytes + 1))).toThrow(
      "5 MiB",
    );
    expect(() =>
      parseImport(JSON.stringify(Array.from({ length: 5001 }, () => null))),
    ).toThrow("5,000");
    expect(() => dataset(normalized({ content: "a".repeat(20001) }))).toThrow(
      "invalid content",
    );
    expect(
      dataset(normalized({ content: "a".repeat(20000) })).records[0].text
        .length,
    ).toBe(20000);
    expect(() => dataset(normalized({ sentiment: "excellent" }))).toThrow(
      "invalid sentiment",
    );
    expect(() => dataset(normalized({ relevant: "true" }))).toThrow(
      "invalid relevance",
    );
    expect(() => dataset(normalized({ issue_categories: "pricing" }))).toThrow(
      "invalid issue",
    );
  });
  it("removes credential and private links without discarding original content", () => {
    const bad = [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:password@example.com/x",
      "http://localhost/x",
      "http://127.1/x",
      "http://2130706433/x",
      "http://10.0.0.3/x",
      "https://172.20.1.1/x",
      "https://192.168.2.3/x",
      "http://169.254.169.254/x",
      "http://[::1]/x",
      "http://[::ffff:127.0.0.1]/x",
      "http://dev.local/x",
      "https://public.example/?api_key=not-for-export",
      "https://example.com/?token=not-for-export",
      "https://www.googleapis.com/youtube/v3/comments?key=synthetic-test-key&id=example",
      "https://example.com/?access_key=synthetic-test-key",
      "https://example.com/?access-key-id=synthetic-test-key",
    ];
    for (const url of bad) expect(safeSourceUrl(url), url).toBeNull();
    expect(safeSourceUrl("https://example.com/?keyword=pricing")).toBe(
      "https://example.com/?keyword=pricing",
    );
    const imported = dataset(normalized({ url: bad[2] }));
    expect(imported.records[0].url).toBeNull();
    expect(imported.importReport?.warnings).toContain(
      "1 unsafe or invalid source URLs removed. Their text remains available.",
    );
    expect(
      safeSourceUrl("https://www.youtube.com/watch?v=video&lc=comment"),
    ).toBe("https://www.youtube.com/watch?v=video&lc=comment");
  });
  it("normalizes only valid explicit publication dates", () => {
    expect(normalizedDate("2026-02-30")).toBeNull();
    expect(normalizedDate("2026-09-20T10:00:00")).toBeNull();
    expect(normalizedDate("2026-09-20T12:00:00+02:00")).toBe(
      "2026-09-20T10:00:00.000Z",
    );
    expect(() => dataset(normalized({ published_at: "2026-02-30" }))).toThrow(
      "publication date",
    );
  });
});

describe("one workspace scope", () => {
  it("keeps samples explicit, synthetic, distinct and free of real links", () => {
    expect(products(sampleDataset)).toEqual(["AcmeFlow", "OrbitQuest"]);
    expect(sampleDatasets).toHaveLength(2);
    expect(
      sampleDataset.records.every(
        (record) => record.provenance === "synthetic" && record.url === null,
      ),
    ).toBe(true);
    expect(
      new Set(
        scopeRecords(sampleDataset, defaultFilters("AcmeFlow")).map(
          (record) => record.source,
        ),
      ),
    ).toEqual(new Set(["hackernews", "youtube", "lemmy"]));
    expect(
      new Set(
        scopeRecords(sampleDataset, defaultFilters("OrbitQuest")).map(
          (record) => record.source,
        ),
      ),
    ).toEqual(new Set(["hackernews", "steam"]));
  });
  it("applies product, sources, sentiment, dates, text and thread exclusions together", () => {
    const imported = dataset(
      normalized({
        external_id: "one",
        sentiment: "negative",
        issue_categories: ["speed"],
        is_complaint: true,
      }),
      normalized({
        external_id: "two",
        source: "youtube",
        published_at: "2026-09-20T23:59:59.999Z",
      }),
      normalized({
        external_id: "three",
        published_at: "2026-09-21T00:00:00Z",
      }),
      normalized({ external_id: "four", published_at: null }),
    );
    const filter = {
      ...defaultFilters("Example"),
      from: "2026-09-20",
      to: "2026-09-20",
    };
    expect(scopeRecords(imported, filter)).toHaveLength(2);
    expect(
      scopeRecords(imported, { ...filter, sources: ["youtube"] }).map(
        (record) => record.nativeId,
      ),
    ).toEqual(["two"]);
    expect(
      scopeRecords(imported, { ...filter, sentiment: "negative" }).map(
        (record) => record.nativeId,
      ),
    ).toEqual(["one"]);
    expect(
      scopeRecords(imported, { ...filter, query: "NOT slow" }),
    ).toHaveLength(2);
    expect(
      scopeRecords(imported, { ...filter, query: "unmatched" }),
    ).toHaveLength(0);
    expect(
      scopeRecords(imported, {
        ...filter,
        excludedThreadIds: [imported.records[0].threadId],
      }).map((record) => record.nativeId),
    ).toEqual(["two"]);
    expect(
      scopeRecords(imported, { ...filter, from: "2026-09-22" }),
    ).toHaveLength(0);
    expect(
      scopeRecords(imported, { ...filter, to: "2026-02-30" }),
    ).toHaveLength(0);
    expect(scopeRecords(imported, defaultFilters())).toHaveLength(0);
  });
  it("counts the whole scope and ranks only supplied issues on eligible records", () => {
    const imported = dataset(
      normalized({
        external_id: "one",
        sentiment: "negative",
        issue_categories: ["pricing"],
        is_complaint: true,
        relevant: true,
      }),
      normalized({
        external_id: "two",
        sentiment: "positive",
        issue_categories: ["pricing"],
        relevant: null,
      }),
      normalized({
        external_id: "three",
        sentiment: "negative",
        issue_categories: ["wrong product"],
        relevant: false,
      }),
      normalized({
        external_id: "four",
        content: "expensive slow horrible and broken",
      }),
    );
    const analysis = analyze(imported, defaultFilters("Example"));
    expect(analysis.metrics).toMatchObject({
      scopedRecords: 4,
      negative: 2,
      positive: 1,
      complaints: 1,
      unlabeled: 1,
      irrelevant: 1,
    });
    expect(analysis.issues).toHaveLength(1);
    expect(analysis.issues[0]).toMatchObject({ name: "pricing", count: 2 });
    expect(analysis.issues[0].share).toBeCloseTo(200 / 3);
    expect(
      searchEvidence(analysis, "Overview").citations.every(
        (record) => record.relevant !== false,
      ),
    ).toBe(true);
    expect(analysis.limitations.join(" ")).toContain("not verified");
  });
  it("balances evidence by source without cross-platform engagement ranking", () => {
    const imported = dataset(
      ...Array.from({ length: 8 }, (_, i) =>
        normalized({ external_id: String(i), engagement: { score: 900000 } }),
      ),
      normalized({
        external_id: "yt",
        source: "youtube",
        engagement: { score: 0 },
      }),
      normalized({
        external_id: "lem",
        source: "lemmy",
        engagement: { score: 1 },
      }),
    );
    expect(
      new Set(
        balancedEvidence(imported.records, 3).map((record) => record.source),
      ).size,
    ).toBe(3);
    expect(imported.records[0].nativeId).toBe("0");
  });
  it("answers overview, top issue, positive opposition, search and no evidence deterministically", () => {
    const scope = defaultFilters("AcmeFlow");
    const analysis = analyze(sampleDataset, scope);
    expect(searchEvidence(analysis, "Overview").kind).toBe("overview");
    const issue = searchEvidence(analysis, "What is the top issue?");
    expect(issue.kind).toBe("issue");
    expect(issue.text).toContain("pricing");
    const positive = searchEvidence(analysis, "Show positive pricing evidence");
    expect(positive.kind).toBe("positive");
    expect(
      positive.citations.every(
        (record) =>
          record.sentiment === "positive" && record.issues.includes("pricing"),
      ),
    ).toBe(true);
    const search = searchEvidence(analysis, "keyboard");
    expect(search.kind).toBe("search");
    expect(search.citations[0].text).toContain("keyboard");
    expect(searchEvidence(analysis, "nonexistentkeyword").kind).toBe("empty");
    expect(searchEvidence(analysis, "Overview")).toEqual(
      searchEvidence(analysis, "Overview"),
    );
    expect(search.text).toContain("Scope: AcmeFlow");
    expect(search.limitations.join(" ")).toContain("not an AI answer");
  });
  it("does not ignore extra question terms when an issue name matches", () => {
    const analysis = analyze(sampleDataset, defaultFilters("AcmeFlow"));
    const answer = searchEvidence(analysis, "pricing crashes");
    expect(answer.kind).toBe("empty");
    expect(answer.citations).toEqual([]);
    expect(
      searchEvidence(analysis, "pricing guest").citations.every((record) =>
        record.text.toLowerCase().includes("guest"),
      ),
    ).toBe(true);
  });
  it("uses the same current scope in rankings, answers and a brief even if given stale analysis", () => {
    const original = defaultFilters("AcmeFlow");
    const old = analyze(sampleDataset, original);
    const scope = { ...original, sources: ["lemmy"], query: "keyboard" };
    const current = analyze(sampleDataset, scope);
    expect(current.metrics.scopedRecords).toBe(1);
    expect(current.issues.map((issue) => issue.name)).toEqual([
      "mobile usability",
    ]);
    expect(
      searchEvidence(current, "Overview").citations.map((record) => record.id),
    ).toEqual(current.records.map((record) => record.id));
    const markdown = brief(sampleDataset, scope, old);
    expect(markdown).toContain("Records: 1 of 22");
    expect(markdown).toContain(current.records[0].text);
    expect(markdown).not.toContain("OrbitQuest forgot my checkpoint");
    expect(markdown).not.toContain("full seat for each occasional reviewer");
    expect(markdown).toContain("synthetic");
  });
  it("exports safe exact source sentences with context and negation", () => {
    const imported = dataset(
      normalized({
        content: "It is not broken.\nDo not omit this context.",
        sentiment: "positive",
      }),
    );
    const markdown = brief(imported, defaultFilters("Example"));
    expect(markdown).toContain(
      "> It is not broken.\n> Do not omit this context.",
    );
    expect(markdown).toContain(
      "[Open original](https://news.ycombinator.com/item?id=123)",
    );
    expect(markdown).not.toContain("removed-private-metadata");
  });
});
