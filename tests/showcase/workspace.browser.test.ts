import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const row = (id: string, extra = {}) => ({
  external_id: id,
  product_id: "tool",
  organization_id: "one",
  source: "hackernews",
  content: `Feedback ${id}`,
  source_metadata: { product_name: "Review Tool", thread_id: id },
  ...extra,
});
const records = [
  row("a", {
    content: "Guest pricing is too high.",
    sentiment: "negative",
    is_complaint: true,
    issue_categories: ["pricing"],
    published_at: "2026-09-01T12:00:00Z",
    source_metadata: {
      product_name: "Review Tool",
      thread_id: "large",
      thread_title: "Guest plans",
    },
  }),
  row("b", {
    content: "Guest pricing is fair for daily reviewers.",
    sentiment: "positive",
    is_complaint: false,
    issue_categories: ["pricing"],
    published_at: "2026-09-02T12:00:00Z",
    source_metadata: {
      product_name: "Review Tool",
      thread_id: "large",
      thread_title: "Guest plans",
    },
  }),
  row("a", {
    source: "youtube",
    content: "Setup is confusing.",
    sentiment: "negative",
    is_complaint: true,
    issue_categories: ["onboarding"],
    published_at: "2026-09-03T12:00:00Z",
    url: "https://www.youtube.com/watch?v=example",
  }),
  row("d", {
    source: "lemmy",
    content: "The release is available. <img src=x onerror=alert(1)>",
    url: "https://example.org/post?key=FAKE_IMPORT_TOKEN",
    author: "private-author",
    author_hash: "private-hash",
  }),
];
async function importRows(page: Page, value: unknown, name = "feedback.json") {
  await page.getByRole("button", { name: "Import feedback" }).click();
  await page.getByLabel("Choose JSON or JSONL file").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    ),
  });
}
async function downloadText(page: Page) {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export brief" }).click();
  const download = await event;
  return readFile((await download.path())!, "utf8");
}
const scope = (page: Page) => page.locator(".ws-scope-caption");

test("the dashboard and brief use the same filtered evidence and thread exclusions", async ({
  page,
}) => {
  await page.goto(".");
  await importRows(page, records);
  await expect(scope(page)).toContainText("4 of 4");
  await expect(page.locator(".ws-metrics article").nth(1)).toContainText("2");
  await expect(page.locator(".ws-metrics article").nth(3)).toContainText("1");
  await page
    .getByRole("button", { name: "Pain points", exact: false })
    .first()
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: "pricing" }),
  ).toContainText("2");
  await page
    .getByRole("button", { name: "Review pricing", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "2 supporting records" }),
  ).toBeVisible();
  await expect(page.locator(".ws-evidence-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Read full record" }).first().click();
  await expect(
    page.getByRole("dialog", { name: "Original feedback" }),
  ).toContainText("Guest pricing");
  await page.getByRole("button", { name: "Exclude this thread" }).click();
  await expect(scope(page)).toContainText("2 of 4");
  const brief = await downloadText(page);
  expect(brief).toContain("Setup is confusing.");
  expect(brief).not.toContain("Guest pricing is");
  expect(brief).not.toContain("FAKE_IMPORT_TOKEN");
  expect(brief).not.toContain("private-author");
  await page.getByRole("button", { name: "Restore Guest plans" }).click();
  await expect(scope(page)).toContainText("4 of 4");
  await page.getByLabel("Filter by source").selectOption("youtube");
  await expect(scope(page)).toContainText("1 of 4");
  expect(await downloadText(page)).not.toContain("Guest pricing is");
});

test("Vox finds original evidence, handles no match, and clears stale answers", async ({
  page,
}) => {
  await page.goto(".");
  await importRows(page, records);
  await page.getByRole("button", { name: "Ask Vox" }).click();
  await page
    .getByRole("button", { name: "Show positive feedback", exact: true })
    .click();
  const answer = page.getByRole("region", { name: "Evidence search results" });
  await expect(answer).toContainText(
    "Guest pricing is fair for daily reviewers.",
  );
  await answer.getByRole("button").first().click();
  await expect(
    page.getByRole("dialog", { name: "Original feedback" }),
  ).toContainText("Guest pricing is fair for daily reviewers.");
  await page.getByRole("button", { name: "Close original feedback" }).click();
  await page.getByLabel("Search evidence with Vox").fill("pricing crashes");
  await page
    .getByRole("button", { name: "Search with Vox", exact: true })
    .click();
  await expect(answer.locator(".ws-vox-citations button")).toHaveCount(0);
  await expect(answer).toContainText(/no .*match/i);
  await page.getByRole("button", { name: "Close Vox" }).click();
  await page.getByLabel("Filter by source").selectOption("youtube");
  await page.getByRole("button", { name: "Ask Vox" }).click();
  await expect(answer).toHaveCount(0);
  await page.getByRole("button", { name: "Summarize the feedback" }).click();
  await expect(answer).toContainText("Setup is confusing.");
  await expect(answer).not.toContainText("Guest pricing");
});

test("imports report duplicate and rejected rows, preserve unknown labels, and render text safely", async ({
  page,
}) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(".");
  await importRows(page, [
    ...records,
    records[0],
    { content: "missing identity" },
  ]);
  await expect(page.locator(".ws-import-report")).toContainText(
    "4 accepted · 1 rejected · 1 duplicates",
  );
  await page.getByLabel("Filter by sentiment").selectOption("unknown");
  await expect(scope(page)).toContainText("1 of 4");
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await page.getByRole("button", { name: "Read full record" }).click();
  const original = page.getByRole("dialog", { name: "Original feedback" });
  await expect(original.locator("blockquote")).toHaveText(
    "The release is available. <img src=x onerror=alert(1)>",
  );
  await expect(
    original.getByRole("link", { name: "Open original source" }),
  ).toHaveCount(0);
  await expect(original).not.toContainText("private-author");
  await expect(original.locator("img")).toHaveCount(0);
  expect(dialogs).toEqual([]);
  await page.reload();
  await expect(page.getByLabel("Product")).toHaveValue("AcmeFlow");
  await expect(page.locator(".ws-import-report")).toHaveCount(0);
});

test("raw collector JSONL preserves product separation and date scope", async ({
  page,
}) => {
  await page.goto(".");
  await importRows(
    page,
    [
      {
        id: "hackernews_1",
        source: "hackernews",
        product: "Alpha",
        text: "Earlier record",
        created_at: "2026-09-01T23:59:59Z",
      },
      {
        id: "hackernews_2",
        source: "hackernews",
        product: "Alpha",
        text: "Later record",
        created_at: "2026-09-02T00:00:00Z",
      },
      {
        id: "lemmy_1",
        source: "lemmy",
        product: "Alpha",
        text: "Undated record",
      },
      {
        id: "hackernews_1",
        source: "hackernews",
        product: "Beta",
        text: "Other product",
      },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n"),
    "collector.jsonl",
  );
  await expect(scope(page)).toContainText("3 of 3");
  await page.getByText("All dates", { exact: true }).click();
  await page.getByLabel("From date").fill("2026-09-02");
  await page.getByLabel("To date").fill("2026-09-01");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(page.getByRole("alert")).toContainText("From date must");
  await page.getByLabel("To date").fill("2026-09-02");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(scope(page)).toContainText("1 of 3");
  const brief = await downloadText(page);
  expect(brief).toContain("Later record");
  expect(brief).not.toContain("Earlier record");
  expect(brief).not.toContain("Undated record");
  await page.getByLabel("Product").selectOption("Beta");
  await expect(scope(page)).toContainText("1 of 1");
  expect(await downloadText(page)).toContain("Other product");
});

test("same-named organizations remain separate and issue source counts use all records", async ({
  page,
}) => {
  await page.goto(".");
  await importRows(page, [
    ...["hackernews", "youtube", "lemmy", "reddit", "steam", "__proto__"].map(
      (source, index) =>
        row(String(index), { source, issue_categories: ["pricing"] }),
    ),
    row("0", { organization_id: "two", content: "Other organization" }),
  ]);
  await expect(page.getByLabel("Product").locator("option")).toHaveCount(2);
  await expect(scope(page)).toContainText("6 of 6");
  await page.getByRole("button", { name: "Pain points" }).first().click();
  const issue = page.getByRole("row").filter({ hasText: "pricing" });
  await expect(issue.getByRole("cell").nth(2)).toHaveText("6");
  await page.getByRole("button", { name: "Review pricing" }).click();
  await expect(page.locator(".ws-evidence-card")).toHaveCount(6);
  await page.getByLabel("Product").selectOption({ index: 1 });
  await expect(scope(page)).toContainText("1 of 1");
});

test("invalid and oversized imports leave the loaded data intact", async ({
  page,
}) => {
  await page.goto(".");
  await importRows(page, "{broken json");
  await expect(page.getByRole("alert")).toContainText(/no valid|no records/i);
  await page.getByLabel("Choose JSON or JSONL file").setInputFiles({
    name: "too-large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, " "),
  });
  await expect(page.getByRole("alert")).toContainText("no larger than 5 MiB");
  await page.getByRole("button", { name: "Close bring your feedback" }).click();
  await expect(scope(page)).toContainText("13 of 13");
  await importRows(page, records);
  await expect(scope(page)).toContainText("4 of 4");
});

test("mobile navigation, dialog focus, and pagination remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(".");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await importRows(
    page,
    Array.from({ length: 25 }, (_, index) => row(String(index))),
  );
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.locator(".ws-evidence-card")).toHaveCount(20);
  await page.getByRole("button", { name: "Next records" }).click();
  await expect(page.locator(".ws-evidence-card")).toHaveCount(5);
  const opener = page.getByRole("button", { name: "Read full record" }).first();
  await opener.click();
  await expect(
    page.getByRole("dialog", { name: "Original feedback" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("published workspace blocks service calls and plays its captioned walkthrough", async ({
  page,
}) => {
  const requests: { url: string; method: string }[] = [];
  page.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  const response = await page.goto(".");
  expect(response?.headers()["content-security-policy"]).toContain(
    "connect-src 'none'",
  );
  await expect(
    page.getByRole("link", { name: "Connected research" }),
  ).toHaveCount(0);
  await importRows(page, records);
  await page.getByRole("button", { name: "Ask Vox" }).click();
  await page.getByRole("button", { name: "Summarize the feedback" }).click();
  await page.getByRole("button", { name: "Close Vox" }).click();
  await page.getByRole("button", { name: "Walkthrough", exact: true }).click();
  const video = page.locator("video");
  await expect(video.locator('track[kind="captions"]')).toHaveAttribute(
    "src",
    /captions\.vtt$/,
  );
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.videoWidth),
  ).toBeGreaterThan(0);
  await expect
    .poll(() =>
      video
        .locator("track")
        .evaluate((track: HTMLTrackElement) => track.readyState),
    )
    .toBe(2);
  expect(
    await video.evaluate(
      (element: HTMLVideoElement) => element.textTracks[0]?.cues?.length ?? 0,
    ),
  ).toBeGreaterThan(0);
  const origin = new URL(page.url()).origin;
  expect(
    requests.filter(
      (request) =>
        new URL(request.url).origin !== origin ||
        request.method !== "GET" ||
        new URL(request.url).pathname.startsWith("/api/"),
    ),
  ).toEqual([]);
});
