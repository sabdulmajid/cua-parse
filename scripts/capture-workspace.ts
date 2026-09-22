/** Record the actual browser-only workspace with its declared synthetic sample. */
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Video,
} from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const origin = "http://127.0.0.1:3311";
const local = path.resolve(".local/workspace-recording");
const assets = path.resolve("showcase/assets");
mkdirSync(local, { recursive: true });
const server = spawn(process.execPath, ["scripts/serve-showcase.mjs"], {
  env: { PATH: process.env.PATH, SHOWCASE_PORT: "3311" },
  stdio: "ignore",
});
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page;
let video: Video;
const captions: { start: number; end: number; text: string }[] = [];
let started = 0;
async function hold(text: string, duration: number) {
  const start = Date.now() - started;
  await page.waitForTimeout(duration);
  captions.push({ start, end: Date.now() - started, text });
}
try {
  browser = await chromium.launch({
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: local, size: { width: 1440, height: 1000 } },
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  video = page.video()!;
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${origin}/cua-parse/`)).ok;
      } catch {
        return false;
      }
    })
    .toBe(true);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  started = Date.now();
  await page.goto(`${origin}/cua-parse/`);
  await expect(
    page.getByRole("heading", { name: "What the feedback says" }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(local, "poster.png") });
  await hold(
    "Overheard turns loaded feedback into issues you can inspect. This is a clearly labeled synthetic sample.",
    6500,
  );
  await page.getByRole("button", { name: "Pain points" }).first().click();
  await hold(
    "Choose a repeated issue label. The counts come from the full selected scope.",
    4500,
  );
  await page
    .getByRole("button", { name: "Review pricing", exact: true })
    .click();
  await hold(
    "Read the supporting records, including positive and mixed feedback.",
    5000,
  );
  await page.getByRole("button", { name: "Read full record" }).first().click();
  await expect(
    page.getByRole("dialog", { name: "Original feedback" }),
  ).toBeVisible();
  await hold(
    "Open the full original text. Keep the source context and the supplied labels visible.",
    5000,
  );
  await page.getByRole("button", { name: "Close original feedback" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByRole("button", { name: "Exclude largest thread" })
    .scrollIntoViewIfNeeded();
  await hold(
    "One discussion contributes four records. Test how much it affects the result.",
    4000,
  );
  await page.getByRole("button", { name: "Exclude largest thread" }).click();
  await expect(page.locator(".ws-scope-caption")).toContainText("9 of 13");
  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(
    "Exclude that thread. Counts, issues, search, and exported evidence now use the remaining nine records.",
    5500,
  );
  await page.getByRole("button", { name: "Ask Vox" }).click();
  await page.getByRole("button", { name: "Show positive feedback" }).click();
  await expect(
    page.getByRole("region", { name: "Evidence search results" }),
  ).toBeVisible();
  await hold(
    "Ask Vox for positive feedback in the current scope. This browser search returns original records without a model call.",
    6500,
  );
  await page.getByRole("button", { name: "Close Vox" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export brief" }).click();
  await (await download).saveAs(path.join(local, "sample-brief.md"));
  await hold(
    "Export the matching scope, counts, and source quotations as a Markdown brief.",
    3500,
  );
  await page.getByRole("button", { name: "Import feedback" }).click();
  await hold(
    "Bring your team's OverHeard JSON or JSONL export. Files stay in this tab. No account or API key is required.",
    6500,
  );
  await page.getByRole("button", { name: "Close bring your feedback" }).click();
  await page.getByLabel("Product").selectOption("OrbitQuest");
  await expect(page.locator(".ws-scope-caption")).toContainText("9 of 9");
  await hold(
    "Switch products without mixing their evidence. Explore the live workspace with your own export.",
    4500,
  );
} finally {
  try {
    await context?.close();
  } finally {
    try {
      await browser?.close();
    } finally {
      server.kill();
    }
  }
}
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
execFileSync(
  ffmpeg,
  [
    "-y",
    "-i",
    await video.path(),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "29",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    path.join(assets, "walkthrough.mp4"),
  ],
  { stdio: "ignore" },
);
execFileSync(
  ffmpeg,
  [
    "-y",
    "-i",
    path.join(local, "poster.png"),
    "-quality",
    "85",
    path.join(assets, "poster.webp"),
  ],
  { stdio: "ignore" },
);
execFileSync(
  ffmpeg,
  [
    "-y",
    "-ss",
    "2",
    "-t",
    "17",
    "-i",
    path.join(assets, "walkthrough.mp4"),
    "-filter_complex",
    "fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer",
    "-loop",
    "0",
    path.join(assets, "preview.gif"),
  ],
  { stdio: "ignore" },
);
const timestamp = (ms: number) => new Date(ms).toISOString().slice(11, 23);
writeFileSync(
  path.join(assets, "captions.vtt"),
  "WEBVTT\n\n" +
    captions
      .map(
        (cue, index) =>
          `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`,
      )
      .join("\n"),
);
console.log(
  "Recorded the actual browser workspace. Media is in showcase/assets; raw recording stays in ignored .local/.",
);
