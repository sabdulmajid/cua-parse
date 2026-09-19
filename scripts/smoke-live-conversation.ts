/** Opt-in paid acceptance: one typed prompt + automatic completion, <=4 live HN records. */
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { Client } from "@elastic/elasticsearch";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { Server } from "node:http";
import { loadConfig, type Config } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import type { EvidencePacket, ResearchJob } from "../src/shared/contracts.js";

const started = Date.now();
const deadline = started + 110_000;
const index = `cua-parse-live-conversation-smoke-${randomUUID()}`;
const reportPath = path.resolve(".local/live-conversation-smoke.json");
let config: Config | undefined;
let localDir: string | undefined;
let service: ReturnType<typeof createApp> | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let packet: EvidencePacket | undefined;
let job: ResearchJob | undefined;
let phase = "configuration";
let status: "PASS" | "FAIL" = "FAIL";
let failureCategory: string | null = null;
let timedOut = false;
let bound = false;
let microphones = 0;
let userTurns = 0;
let startRequests = 0;
let agentReplies = 0;
let readStarted = false;
let readReplyBaseline = 0;
let readStatusCalls = 0;
let readQueryCalls = 0;
let readQueryReturned = false;
let answeredAfterReadQuery = false;
let cleanupPassed = true;
const tools: string[] = [];
const steps: string[] = [];
const httpFailures: Array<{ operation: string; status: number }> = [];
const caps = {
  maxThreads: 2,
  maxRecords: 4,
  maxHumanPrompts: 1,
  maxUserTurns: 2,
  maxResearchJobs: 1,
  workDeadlineSeconds: 110,
  totalDeadlineSeconds: 120,
};
const remaining = (limit = 30_000) =>
  Math.max(1, Math.min(limit, deadline - Date.now()));
const timer = setTimeout(() => {
  timedOut = true;
  void browser?.close().catch(() => {});
  void service?.runner.stop().catch(() => {});
}, 110_000);

try {
  const base = loadConfig();
  if (
    !base.OPENAI_API_KEY ||
    !base.ELEVENLABS_API_KEY ||
    !base.ELEVENLABS_AGENT_ID ||
    base.VOICE_MODE !== "enabled"
  )
    throw new Error("missing_configuration");
  if (base.RETRIEVAL_MODE !== "bm25")
    throw new Error("requires_bm25_to_bound_cost");
  mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  localDir = mkdtempSync(
    path.join(path.dirname(reportPath), "live-conversation-smoke-"),
  );
  config = {
    ...base,
    localDir,
    PORT: 3102,
    APP_BASE_URL: "http://127.0.0.1:3102",
    APP_SESSION_SECRET: randomBytes(32).toString("hex"),
    ELASTICSEARCH_INDEX: index,
    MAX_THREADS: 2,
    MAX_ITEMS: 4,
    COLLECTION_CONCURRENCY: 1,
    JOB_TIMEOUT_MS: 90_000,
    ANALYSIS_MODE: "openai",
    DATA_MODE: "live",
  };
  service = createApp(config);
  const activeService = service;
  const activeConfig = config;
  phase = "isolated-server";
  await new Promise<void>((resolve, reject) => {
    server = activeService.app.listen(activeConfig.PORT, "127.0.0.1", () =>
      resolve(),
    );
    server.once("error", reject);
  });
  steps.push("isolated-local-service-started");
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    timeout: remaining(15_000),
  });
  context = await browser.newContext({ baseURL: config.APP_BASE_URL });
  const page = await context.newPage();
  page.setDefaultTimeout(remaining(10_000));
  await page.exposeFunction("recordUnexpectedMicrophone", () => {
    microphones++;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => {
        void (
          window as unknown as {
            recordUnexpectedMicrophone: () => Promise<void>;
          }
        ).recordUnexpectedMicrophone();
        return Promise.reject(
          new DOMException(
            "No microphone in this text acceptance check",
            "NotAllowedError",
          ),
        );
      },
    });
  });
  await page.route("**/api/tools/start_research", async (route) => {
    startRequests++;
    const input = route.request().postDataJSON();
    if (
      startRequests > 1 ||
      input.mode !== "live" ||
      String(input.product).toLowerCase() !== "dropbox"
    ) {
      failureCategory = "research_request_exceeded_authorized_scope";
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            "The live smoke check permits one bounded Dropbox research job.",
        }),
      });
      return;
    }
    await route.continue();
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        if (JSON.parse(String(payload)).type === "user_message") {
          userTurns++;
          // This is the workspace completion message, not a second typed prompt.
          if (userTurns === 2) {
            readStarted = true;
            readReplyBaseline = agentReplies;
          }
        }
      } catch {
        /* Never log protocol frames. */
      }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const event = JSON.parse(String(payload));
        if (event.type === "client_tool_call") {
          const name = String(event.client_tool_call?.tool_name ?? "");
          if (
            [
              "start_research",
              "get_research_status",
              "query_feedback",
              "prepare_decision_brief",
            ].includes(name)
          )
            tools.push(name);
          if (readStarted && name === "get_research_status") readStatusCalls++;
          if (readStarted && name === "query_feedback") readQueryCalls++;
        }
        if (event.type === "agent_response") {
          agentReplies++;
          if (readStarted && readQueryReturned && readQueryCalls > 0)
            answeredAfterReadQuery = true;
        }
      } catch {
        /* Ignore non-JSON frames. Never retain raw events or connection URLs. */
      }
    });
  });
  page.on("response", async (response) => {
    const pathname = new URL(response.url()).pathname;
    if (!pathname.startsWith("/api/")) return;
    if (!response.ok())
      httpFailures.push({ operation: pathname, status: response.status() });
    if (pathname === "/api/voice/bind" && response.ok()) bound = true;
    try {
      if (
        (pathname === "/api/tools/start_research" ||
          pathname === "/api/tools/get_research_status") &&
        response.ok()
      )
        job = (await response.json()).job;
      if (pathname === "/api/tools/query_feedback" && response.ok()) {
        packet = (await response.json()).packet;
        if (
          readStarted &&
          readQueryCalls > 0 &&
          response.request().headers()["x-conversation-id"]
        )
          readQueryReturned = true;
      }
    } catch {
      /* A cancelled response has no readable body. */
    }
  });
  phase = "connect-and-start";
  await page.goto(config.APP_BASE_URL, { timeout: remaining(15_000) });
  await page
    .getByLabel("Message", { exact: true })
    .fill(
      "Research Dropbox using live public discussions. What feedback is available about pricing?",
    );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => bound, { timeout: remaining() }).toBe(true);
  steps.push("real-private-text-conversation-bound");
  await expect
    .poll(() => tools.includes("start_research"), { timeout: remaining() })
    .toBe(true);
  steps.push("registered-start-research-tool-invoked");
  phase = "collect-analyze-index";
  await expect
    .poll(() => packet?.metrics.collectedRecords, {
      timeout: remaining(70_000),
    })
    .toBe(4);
  await expect
    .poll(() => job?.state, { timeout: remaining(10_000) })
    .toBe("ready");
  expect(job?.collected).toBe(4);
  expect(job?.indexed).toBe(4);
  expect(job?.mode).toBe("live");
  expect(packet!.provenance).toEqual(["live"]);
  expect(packet!.metrics.distinctThreads).toBeLessThanOrEqual(2);
  expect(packet!.metrics.relevantRecords).toBeGreaterThanOrEqual(1);
  expect(
    packet!.evidence.some(
      (record) =>
        record.provenance === "live" &&
        record.extractionStatus === "verified" &&
        record.relevant,
    ),
  ).toBe(true);
  expect(
    packet!.evidence.every((record) =>
      record.aspects.every((aspect) => record.text.includes(aspect.quote)),
    ),
  ).toBe(true);
  expect(activeService.providers.openai?.status).toBe("verified");
  expect(activeService.providers.elasticsearch?.status).toBe("verified");
  expect(activeService.providers.hackernews?.status).toBe("verified");
  steps.push("four-live-records-collected-model-validated-and-indexed");
  phase = "automatic-findings";
  await expect.poll(() => readStarted, { timeout: remaining() }).toBe(true);
  await expect
    .poll(() => readStatusCalls, { timeout: remaining() })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => readQueryCalls, { timeout: remaining() })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => readQueryReturned, { timeout: remaining() })
    .toBe(true);
  await expect
    .poll(() => answeredAfterReadQuery, { timeout: remaining() })
    .toBe(true);
  expect(agentReplies).toBeGreaterThan(readReplyBaseline);
  expect(packet?.challenge).toBe(false);
  expect(userTurns).toBe(2);
  expect(startRequests).toBe(1);
  expect(microphones).toBe(0);
  expect(httpFailures).toEqual([]);
  expect(failureCategory).toBeNull();
  steps.push(
    "one-typed-prompt-triggered-automatic-completion-message",
    "automatic-findings-invoked-real-status-and-query-tools",
    "new-agent-answer-received-after-evidence-result",
  );
  status = "PASS";
  phase = "complete";
} catch (error) {
  const approved = new Set([
    "missing_configuration",
    "requires_bm25_to_bound_cost",
  ]);
  failureCategory =
    failureCategory ??
    (timedOut
      ? "work_deadline_exceeded"
      : error instanceof Error && approved.has(error.message)
        ? error.message
        : `acceptance_failed_during_${phase}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  const cleanupDeadline = Date.now() + 10_000;
  async function cleanupStep(action: () => Promise<unknown>) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("cleanup_timeout")),
            Math.max(1, cleanupDeadline - Date.now()),
          );
        }),
      ]);
    } catch {
      cleanupPassed = false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  if (context) await cleanupStep(() => context!.close());
  if (browser) await cleanupStep(() => browser!.close());
  if (service) await cleanupStep(() => service!.close());
  if (server?.listening) {
    server.closeIdleConnections();
    await cleanupStep(
      () =>
        new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        ),
    );
  }
  if (config) {
    const cleanupClient = new Client({
      node: config.ELASTICSEARCH_URL,
      ...(config.ELASTICSEARCH_API_KEY
        ? { auth: { apiKey: config.ELASTICSEARCH_API_KEY } }
        : {}),
      requestTimeout: 5_000,
      maxRetries: 0,
    });
    await cleanupStep(async () => {
      if (await cleanupClient.indices.exists({ index }))
        await cleanupClient.indices.delete({ index });
    });
    await cleanupStep(() => cleanupClient.close());
  }
  if (localDir) {
    try {
      rmSync(localDir, { recursive: true, force: true });
    } catch {
      cleanupPassed = false;
    }
  }
  if (!cleanupPassed) {
    status = "FAIL";
    failureCategory = failureCategory ?? "isolated_cleanup_failed";
    process.exitCode = 1;
  }
  const report = {
    status,
    phase,
    failureCategory,
    observedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    mode: "real-browser / private-ElevenLabs-text / live-HN / real-OpenAI / real-Elasticsearch",
    caps,
    steps,
    bindSucceeded: bound,
    registeredClientToolCalls: tools,
    agentReplies,
    userTurns,
    microphoneRequests: microphones,
    automaticCompletion: {
      startedByWorkspaceMessage: readStarted,
      statusToolCalls: readStatusCalls,
      queryToolCalls: readQueryCalls,
      authenticatedQueryReturned: readQueryReturned,
      agentAnsweredAfterEvidence: answeredAfterReadQuery,
    },
    evidence: packet
      ? {
          collected: job?.collected,
          indexed: job?.indexed,
          storedRecords: packet.metrics.collectedRecords,
          relevantRecords: packet.metrics.relevantRecords,
          threads: packet.metrics.distinctThreads,
          provenance: packet.provenance,
          verifiedExamples: packet.evidence.filter(
            (record) => record.extractionStatus === "verified",
          ).length,
          analysisVersions: [
            ...new Set(packet.evidence.map((record) => record.analysisVersion)),
          ],
          sourceQuoteSpansValid: packet.evidence.every((record) =>
            record.aspects.every((aspect) =>
              record.text.includes(aspect.quote),
            ),
          ),
          jobFailures: job?.failures.length,
        }
      : null,
    providerStatus: service
      ? {
          openai: service.providers.openai?.status,
          hackernews: service.providers.hackernews?.status,
          elasticsearch: service.providers.elasticsearch?.status,
        }
      : null,
    httpFailures,
    cleanupPassed,
    limitations: [
      "Text-only: no physical microphone, audio quality, or live interruption check.",
      "Four public discussion records are a bounded sample, not verified customers.",
      "BM25 retrieval; no live embeddings were requested.",
    ],
  };
  mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status,
      phase,
      failureCategory,
      elapsedSeconds: report.elapsedSeconds,
      collected: report.evidence?.collected,
      relevant: report.evidence?.relevantRecords,
      agentReplies,
      userTurns,
      microphones,
      cleanupPassed,
      saved: ".local/live-conversation-smoke.json",
    }),
  );
}
