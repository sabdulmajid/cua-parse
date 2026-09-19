/** Records the real fixture UI. No cloud, model, or voice credentials are used. */
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Client } from "@elastic/elasticsearch";
import { format } from "prettier";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { FIXTURE_VERSION } from "../fixtures/acmeflow.js";
import type {
  EvidencePacket,
  EvidenceRecord,
} from "../src/shared/contracts.js";

const root = process.cwd();
const assets = path.join(root, "showcase/assets");
const local = path.join(root, ".local/showcase");
const output = path.join(root, "showcase/data/demo.json");
const origin = "http://127.0.0.1:3300";
const index = `cua-parse-showcase-${randomUUID()}`;
const width = 1440,
  height = 900;
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const dataOnly = process.argv.includes("--data-only");
const fast = process.argv.includes("--fast");
const pace = fast ? 0.08 : 1;
if (!existsSync(path.join(root, "dist/index.html")))
  throw new Error("Run npm run build first.");
for (const dir of [assets, local, path.dirname(output)])
  mkdirSync(dir, { recursive: true });
const service = createApp(
  loadConfig({
    PORT: "3300",
    APP_BASE_URL: origin,
    VITE_PORT: "5330",
    CUA_LOCAL_DIR: path.join(local, "server"),
    ELASTICSEARCH_URL: "http://127.0.0.1:9200",
    ELASTICSEARCH_INDEX: index,
    DATA_MODE: "fixture",
    ANALYSIS_MODE: "unlabeled",
    RETRIEVAL_MODE: "bm25",
    VOICE_MODE: "disabled",
  }),
);
const cleanupClient = new Client({
  node: "http://127.0.0.1:9200",
  maxRetries: 0,
});
let server: Server | undefined,
  browser: Browser | undefined,
  context: BrowserContext | undefined;
let latest: EvidencePacket | undefined;
const captures: Partial<
  Record<"overview" | "pricing" | "excluded" | "challenge", EvidencePacket>
> = {};
const captions: Array<{ start: number; end: number; text: string }> = [];
const blocked: string[] = [],
  failures: string[] = [];
let began = 0;
function assertFixture(packet: EvidencePacket) {
  if (
    JSON.stringify(packet.provenance) !== '["synthetic"]' ||
    packet.retrievalMode !== "bm25"
  )
    throw new Error("Only synthetic BM25 packets can enter the public demo.");
  for (const record of [...packet.evidence, ...packet.opposingEvidence]) {
    if (
      record.source !== "fixture" ||
      record.provenance !== "synthetic" ||
      record.url !== null ||
      !record.id.startsWith("fixture:")
    )
      throw new Error(
        "A non-fixture original was rejected from the public export.",
      );
    for (const aspect of record.aspects)
      if (!record.text.includes(aspect.quote))
        throw new Error("A quotation did not match its original record.");
  }
}
function publicRecord(record: EvidenceRecord) {
  const {
    sessionId: _session,
    researchId: _research,
    embedding: _embedding,
    ...safe
  } = record;
  return safe;
}
function publicPacket(packet: EvidencePacket) {
  assertFixture(packet);
  const {
    researchId: _research,
    requestId: _request,
    generatedAt: _time,
    ...safe
  } = packet;
  const scope = createHash("sha256")
    .update(
      JSON.stringify({ fixture: FIXTURE_VERSION, filters: packet.filters }),
    )
    .digest("hex")
    .slice(0, 24);
  return {
    ...safe,
    scopeVersion: scope,
    findings: packet.findings.map((finding, i) => ({
      ...finding,
      id: `${scope}-source-${i}`,
    })),
    evidence: packet.evidence.map(publicRecord),
    opposingEvidence: packet.opposingEvidence.map(publicRecord),
  };
}
async function pause(page: Page, text: string, seconds: number) {
  const start = (Date.now() - began) / 1000;
  await page.waitForTimeout(seconds * 1000 * pace);
  captions.push({ start, end: (Date.now() - began) / 1000, text });
}
async function focus(page: Page, selector: string) {
  await page
    .locator(selector)
    .first()
    .evaluate((element) =>
      element.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  await page.waitForTimeout(550 * pace);
}
async function details(page: Page) {
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Details", exact: true }),
  ).toBeVisible();
}
function stamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
function encode(args: string[]) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "pipe",
  });
}
async function publish(originalBrief: string) {
  const states = Object.fromEntries(
    Object.entries(captures).map(([key, packet]) => [
      key,
      publicPacket(packet),
    ]),
  );
  const brief = originalBrief
    .replace(/^Generated:.*\n/m, "")
    .replaceAll(
      captures.challenge!.scopeVersion,
      states.challenge.scopeVersion,
    );
  const exported = {
    schemaVersion: 1,
    synthetic: true,
    product: "AcmeFlow",
    question: captures.overview!.question,
    dominantThreadId: "fixture:angry",
    states,
    briefs: { challenge: brief },
    provenance: {
      fixtureVersion: FIXTURE_VERSION,
      method:
        "Captured from the real built app and its local API using SQLite and Elasticsearch 8.19.x.",
      labels:
        "Hand-authored synthetic fixture labels; no customer or model claim.",
      publicSourceUrls: false,
      paidProviderCalls: 0,
      transformations: [
        "Removed runtime session, research, request and generated-time fields.",
        "Replaced runtime scope/finding IDs with deterministic presentation IDs derived from fixture version and filters.",
        "Preserved API metrics, source IDs, quotations, findings text, filters, and limitations.",
      ],
    },
  };
  const publicJson = await format(JSON.stringify(exported), { parser: "json" });
  if (
    /"(?:sessionId|researchId|requestId|csrfToken|embedding|generatedAt)"/.test(
      publicJson,
    )
  )
    throw new Error("Runtime state was not stripped.");
  writeFileSync(output, publicJson);
  return states;
}
try {
  await service.evidence.init();
  server = await new Promise<Server>((resolve, reject) => {
    const active = service.app.listen(3300, "127.0.0.1", () => resolve(active));
    active.once("error", reject);
  });
  if (dataOnly) {
    const initial = await fetch(origin + "/api/session");
    const session = (await initial.json()) as { csrfToken: string };
    const cookie = initial.headers.get("set-cookie")!.split(";")[0];
    const call = async (name: string, body: unknown) => {
      const response = await fetch(origin + "/api/tools/" + name, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": session.csrfToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error("The fixture export API request failed.");
      return response.json();
    };
    const question =
      "What do people dislike about AcmeFlow, especially its pricing and onboarding?";
    const { job } = await call("start_research", {
      product: "AcmeFlow",
      question,
      mode: "fixture",
      idempotencyKey: randomUUID(),
    });
    await expect
      .poll(
        async () =>
          (await call("get_research_status", { researchId: job.id })).job.state,
        { timeout: 20_000 },
      )
      .toBe("ready");
    let input = {
      researchId: job.id,
      question,
      filters: {
        excludedThreadIds: [] as string[],
        aspect: null as string | null,
        source: null,
        from: null,
        to: null,
      },
      challenge: false,
      challengeSentiment: "negative",
      requestId: randomUUID(),
    };
    captures.overview = (await call("query_feedback", input)).packet;
    input = {
      ...input,
      filters: { ...input.filters, aspect: "pricing" },
      requestId: randomUUID(),
    };
    captures.pricing = (await call("query_feedback", input)).packet;
    input = {
      ...input,
      filters: { ...input.filters, excludedThreadIds: ["fixture:angry"] },
      requestId: randomUUID(),
    };
    captures.excluded = (await call("query_feedback", input)).packet;
    input = { ...input, challenge: true, requestId: randomUUID() };
    captures.challenge = (await call("query_feedback", input)).packet;
    const { brief } = await call("prepare_decision_brief", input);
    const states = await publish(brief.markdown);
    console.log(
      JSON.stringify({
        synthetic: true,
        states: Object.keys(states),
        paidProviderCalls: 0,
        exportPath: "showcase/data/demo.json",
        recorded: false,
      }),
    );
  } else {
    browser = await chromium.launch({
      channel: process.env.CI ? undefined : "chrome",
      headless: true,
    });
    context = await browser.newContext({
      baseURL: origin,
      viewport: { width, height },
      recordVideo: { dir: path.join(local, "video"), size: { width, height } },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        /\/api\/(voice|elastic)\//.test(url.pathname) ||
        (url.pathname.endsWith("/start_research") &&
          request.postDataJSON()?.mode !== "fixture")
      ) {
        blocked.push("Unexpected non-fixture request");
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    began = Date.now();
    page.on("pageerror", () => failures.push("Browser script error"));
    page.on("response", async (response) => {
      if (response.url().endsWith("/api/tools/query_feedback") && response.ok())
        latest = (await response.json()).packet;
    });
    await page.goto(origin, { waitUntil: "networkidle" });
    await expect(
      page.getByRole("button", { name: "Try demo", exact: true }),
    ).toBeEnabled();
    await page.getByLabel("Research source").selectOption("fixture");
    await pause(
      page,
      "Real CUA Parse app. AcmeFlow is an invented fixture; conversation providers are off.",
      4,
    );
    await page.getByRole("button", { name: "Try demo", exact: true }).click();
    await expect.poll(() => latest?.metrics.relevantRecords).toBe(18);
    captures.overview = structuredClone(latest!);
    assertFixture(latest!);
    await focus(page, ".findings-card");
    await pause(
      page,
      "1. Research the sample: 21 distinct records, with 18 relevant product matches.",
      6,
    );
    await page
      .locator(".findings-card")
      .screenshot({ path: path.join(local, "poster.png") });
    await page
      .locator(".answer-findings")
      .getByRole("button", { name: "Source 1", exact: true })
      .first()
      .click();
    await pause(
      page,
      "Open a citation to inspect its exact synthetic source text.",
      4,
    );
    await details(page);
    await page.getByLabel("Filter by aspect").selectOption("pricing");
    await expect.poll(() => latest?.filters.aspect).toBe("pricing");
    captures.pricing = structuredClone(latest!);
    const pricing = latest!.metrics.aspects.find(
      (item) => item.aspect === "pricing",
    )!;
    expect(pricing).toMatchObject({
      mentions: 13,
      negative: 9,
      positive: 3,
      neutral: 1,
    });
    await page.getByText("Sample & themes", { exact: true }).click();
    await page
      .locator(".table-scroll")
      .evaluate((element) =>
        element.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    await page.waitForTimeout(550 * pace);
    await pause(
      page,
      "2. Focus on pricing: 13 mentions, including 9 negative and 3 positive labels.",
      6,
    );
    await page.getByText("Threads & concentration", { exact: true }).click();
    const dominant = page.locator(".thread-row").filter({
      hasText: "AcmeFlow pricing change: a concentrated complaint thread",
    });
    await dominant.scrollIntoViewIfNeeded();
    await pause(
      page,
      "Eight records come from one concentrated complaint thread.",
      4,
    );
    await dominant.getByRole("button", { name: /Exclude/ }).click();
    await expect
      .poll(() => latest?.filters.excludedThreadIds.includes("fixture:angry"))
      .toBe(true);
    captures.excluded = structuredClone(latest!);
    expect(
      latest!.metrics.aspects.find((item) => item.aspect === "pricing"),
    ).toMatchObject({ mentions: 5, negative: 1, positive: 3, neutral: 1 });
    await page
      .getByRole("button", { name: "Close details", exact: true })
      .click();
    await focus(page, ".findings-card");
    await pause(
      page,
      "3. Exclude that thread. The remaining pricing scope has 5 records, with only 1 negative label.",
      6,
    );
    await page
      .getByRole("button", { name: "Challenge conclusion", exact: true })
      .click();
    await expect.poll(() => latest?.challenge).toBe(true);
    captures.challenge = structuredClone(latest!);
    expect(latest!.opposingEvidence.map((item) => item.id).sort()).toEqual([
      "fixture:praise-1",
      "fixture:praise-2",
      "fixture:praise-3",
    ]);
    await focus(page, ".findings-card");
    await pause(
      page,
      "4. Challenge the negative conclusion. Three positive pricing records remain in this same scope.",
      6,
    );
    if (!(await page.locator(".evidence-disclosure").getAttribute("open"))) {
      // Presence, rather than the empty open attribute value, identifies an open details element.
      const open = await page
        .locator(".evidence-disclosure")
        .evaluate((element) => (element as HTMLDetailsElement).open);
      if (!open) await page.locator(".evidence-disclosure > summary").click();
    }
    await focus(page, ".evidence-disclosure");
    await pause(
      page,
      "The opposing quotations are original fixture text, not an invented counterargument.",
      6,
    );
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export brief", exact: true })
      .click();
    const download = await downloadPromise;
    const file = await download.path();
    if (!file) throw new Error("The real brief did not download.");
    const originalBrief = readFileSync(file, "utf8");
    expect(originalBrief).toContain(captures.challenge.scopeVersion);
    expect(originalBrief).toContain("fixture:angry");
    expect(originalBrief).toContain(
      "Synthetic evidence; no original public URL.",
    );
    await focus(page, ".finding-actions");
    await pause(
      page,
      "5. Export the brief with this scope, its citations, and its sample limits. No external ticket is created.",
      5,
    );
    await focus(page, ".findings-card");
    await pause(
      page,
      "Evidence you can inspect. Conclusions you can challenge. This walkthrough uses synthetic data only.",
      5,
    );
    if (blocked.length || failures.length)
      throw new Error(
        "The recording encountered an unexpected request or browser error.",
      );
    const states = await publish(originalBrief);
    const video = page.video();
    await context.close();
    context = undefined;
    if (!video) throw new Error("The browser did not record a video.");
    const rawVideo = await video.path();
    writeFileSync(
      path.join(assets, "captions.vtt"),
      "WEBVTT\n\n" +
        captions
          .map(
            (cue, i) =>
              `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`,
          )
          .join("\n"),
    );
    encode([
      "-i",
      rawVideo,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      path.join(assets, "walkthrough.mp4"),
    ]);
    encode([
      "-i",
      path.join(local, "poster.png"),
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      "90",
      path.join(assets, "poster.webp"),
    ]);
    // A short excerpt of actual research and citation inspection; never generated UI.
    encode([
      "-ss",
      String(captions[1].start),
      "-t",
      String(10 * pace),
      "-i",
      rawVideo,
      "-filter_complex",
      "fps=8,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
      "-loop",
      "0",
      path.join(assets, "preview.gif"),
    ]);
    const duration = Number(
      execFileSync(
        ffprobe,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          path.join(assets, "walkthrough.mp4"),
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    console.log(
      JSON.stringify({
        synthetic: true,
        durationSeconds: duration,
        states: Object.keys(states),
        paidProviderCalls: 0,
        exportPath: "showcase/data/demo.json",
        videoPath: "showcase/assets/walkthrough.mp4",
      }),
    );
  }
} finally {
  await context?.close();
  await browser?.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await service.close();
  try {
    await cleanupClient.indices.delete({ index });
  } catch {
    /* Only this run's disposable index is eligible for cleanup. */
  }
  await cleanupClient.close();
}
