import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import demo from "../../showcase/data/demo.json" with { type: "json" };
async function openSample(page: Page) {
  await page.goto("./");
  await expect(page.locator("#sample-content")).toBeVisible();
}

test("guided question reaches source inspection, changed scope, opposing evidence and the matching brief", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await openSample(page);
  await expect(
    page.getByText("Interactive sample · synthetic AcmeFlow data"),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.locator("#show-findings").click();
  await expect(page.locator("#sample-metrics")).toContainText("18");
  await page.locator("#inspect-sources").click();
  await expect(page.locator("#source-dialog")).toBeVisible();
  await expect(
    page.locator("#source-dialog blockquote").first(),
  ).not.toBeEmpty();
  await page.keyboard.press("Escape");
  await expect(page.locator("#inspect-sources")).toBeFocused();
  await page.locator("#next-step").click();
  await expect(page.locator("#sample-metrics .metric strong")).toHaveText([
    "13",
    "9",
    "3",
  ]);
  await page.locator("#next-step").click();
  await expect(page.locator("#sample-metrics .metric strong")).toHaveText([
    "5",
    "1",
    "3",
  ]);
  await page.locator("#inspect-sources").click();
  await expect(page.locator("#source-dialog-content")).not.toContainText(
    "fixture:angry",
  );
  await page.keyboard.press("Escape");
  await page.locator("#next-step").click();
  await expect(page.locator("#answer-title")).toHaveText(
    "What points the other way?",
  );
  await expect(page.locator("#findings")).toContainText("pricing is fair");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#next-step").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("acmeflow-decision-brief.md");
  expect(readFileSync((await download.path())!, "utf8")).toBe(
    demo.briefs.challenge,
  );
  expect(
    requests.every(
      (url) =>
        url.startsWith(new URL(page.url()).origin) || url.startsWith("blob:"),
    ),
  ).toBe(true);
  expect(
    requests.some((url) => new URL(url).pathname.startsWith("/api/")),
  ).toBe(false);
});

test("visitors can restore the original scope and restart the tour", async ({
  page,
}) => {
  await openSample(page);
  await page.locator("#show-findings").click();
  await page.locator('[data-step="excluded"]').click();
  await expect(page.locator("#sample-metrics .metric strong")).toHaveText([
    "5",
    "1",
    "3",
  ]);
  await page.locator('[data-step="pricing"]').click();
  await expect(page.locator("#sample-metrics .metric strong")).toHaveText([
    "13",
    "9",
    "3",
  ]);
  await page.locator("#restart").click();
  await expect(page.locator("#sample-intro")).toBeVisible();
  await expect(page.locator("#show-findings")).toBeFocused();
  await page.locator("#show-findings").click();
  await expect(page.locator('[data-step="overview"]')).toHaveAttribute(
    "aria-current",
    "step",
  );
});

test("a failed sample download is visible and can recover", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/data/demo.json", (route) =>
    ++attempts === 1
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.continue(),
  );
  await page.goto("./");
  await expect(page.locator("#sample-error")).toBeVisible();
  await page.locator("#retry-sample").click();
  await expect(page.locator("#sample-content")).toBeVisible();
  await expect(page.locator("#sample-error")).toBeHidden();
});

test("the public client rejects a non-synthetic source", async ({ page }) => {
  const invalid = structuredClone(demo);
  invalid.states.overview.evidence[0].provenance = "imported";
  await page.route("**/data/demo.json", (route) =>
    route.fulfill({ json: invalid }),
  );
  await page.goto("./");
  await expect(page.locator("#sample-error")).toBeVisible();
  await expect(page.locator("#sample-content")).toBeHidden();
});

test("keyboard navigation and the compact layout keep actions available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.locator("#show-findings").click();
  await expect(page.locator("#answer-title")).toBeFocused();
  await page.locator(".citation").first().click();
  await expect(page.locator("#source-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".citation").first()).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.locator('[data-step="challenge"]').click();
  await expect(page.locator("#next-step")).toHaveText("Export brief↓");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("the recorded app video and its captions are usable", async ({ page }) => {
  await openSample(page);
  const video = page.locator("video");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video.locator("track")).toHaveAttribute("kind", "captions");
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  const media = await video.evaluate((element: HTMLVideoElement) => ({
    duration: element.duration,
    width: element.videoWidth,
    error: element.error?.code,
  }));
  expect(media.duration).toBeGreaterThan(40);
  expect(media.duration).toBeLessThan(90);
  expect(media.width).toBeGreaterThanOrEqual(1280);
  expect(media.error).toBeUndefined();
  const captions = await page.request.get(
    new URL("assets/captions.vtt", page.url()).href,
  );
  expect(captions.ok()).toBe(true);
  expect(await captions.text()).toContain("WEBVTT");
  await video.evaluate((element: HTMLVideoElement) => element.pause());
});
