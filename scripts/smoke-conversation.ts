import "dotenv/config";
/** Opt-in paid check: one prompt auto-answers, then explicit scope/export turns. */
import { chromium, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { EvidencePacket } from "../src/shared/contracts.js";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const calls: string[] = [];
let agentReplies = 0,
  microphones = 0,
  packet: EvidencePacket | undefined;
let bindSucceeded = false;
let humanPrompts = 0;
let userTurns = 0;
let readStarted = false;
let readReplyBaseline = 0;
let readStatusCalls = 0;
let readQueryCalls = 0;
let readQueryReturned = false;
let answeredAfterReadQuery = false;
const started = Date.now();
await page.addInitScript(() => {
  // A typed session must not request a microphone, even if permission would fail.
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: () => {
      window.dispatchEvent(new Event("unexpected-microphone"));
      return Promise.reject(
        new DOMException("Text smoke has no microphone", "NotAllowedError"),
      );
    },
  });
});
await page.exposeFunction("recordUnexpectedMicrophone", () => {
  microphones++;
});
await page.addInitScript(() =>
  window.addEventListener("unexpected-microphone", () => {
    void (
      window as unknown as { recordUnexpectedMicrophone: () => Promise<void> }
    ).recordUnexpectedMicrophone();
  }),
);
page.on("websocket", (socket) => {
  socket.on("framesent", ({ payload }) => {
    try {
      if (JSON.parse(String(payload)).type === "user_message") {
        userTurns++;
        // The workspace sends the second SDK message when research finishes.
        // Capture this here: a fast answer can arrive before a DOM assertion.
        if (userTurns === 2) {
          readStarted = true;
          readReplyBaseline = agentReplies;
        }
      }
    } catch {
      /* Never log protocol frames or connection URLs. */
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
          calls.push(name);
        if (readStarted && name === "get_research_status") readStatusCalls++;
        if (readStarted && name === "query_feedback") readQueryCalls++;
      }
      if (event.type === "agent_response") {
        agentReplies++;
        if (readStarted && readQueryReturned && readQueryCalls > 0)
          answeredAfterReadQuery = true;
      }
    } catch {
      /* non-JSON frames are irrelevant; never log credentials or raw events */
    }
  });
});
page.on("response", async (response) => {
  if (response.url().endsWith("/api/voice/bind") && response.ok())
    bindSucceeded = true;
  if (response.url().endsWith("/api/tools/query_feedback") && response.ok()) {
    try {
      packet = (await response.json()).packet;
      if (
        readStarted &&
        readQueryCalls > 0 &&
        response.request().headers()["x-conversation-id"]
      )
        readQueryReturned = true;
    } catch {
      /* A cancelled response has no readable body. */
    }
  }
});
async function send(message: string) {
  humanPrompts++;
  await page.getByLabel("Message", { exact: true }).fill(message);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
let status = "FAIL",
  phase = "connect-and-start";
try {
  await page.goto(process.env.APP_BASE_URL || "http://127.0.0.1:3000");
  await send(
    "Use the synthetic AcmeFlow demo. What feedback does the sample show about pricing? Start the research now.",
  );
  await expect.poll(() => bindSucceeded, { timeout: 30000 }).toBe(true);
  await expect
    .poll(() => calls.includes("start_research"), { timeout: 45000 })
    .toBe(true);
  await expect
    .poll(() => packet?.metrics.collectedRecords, { timeout: 60000 })
    .toBe(21);
  phase = "automatic-findings";
  await expect.poll(() => readStarted, { timeout: 30000 }).toBe(true);
  await expect
    .poll(() => readStatusCalls, { timeout: 45000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => readQueryCalls, { timeout: 45000 })
    .toBeGreaterThanOrEqual(1);
  await expect.poll(() => readQueryReturned, { timeout: 30000 }).toBe(true);
  await expect
    .poll(() => answeredAfterReadQuery, { timeout: 45000 })
    .toBe(true);
  expect(agentReplies).toBeGreaterThan(readReplyBaseline);
  expect(humanPrompts).toBe(1);
  expect(userTurns).toBe(2);
  expect(packet?.challenge).toBe(false);
  phase = "exclude-and-challenge";
  const previousQueries = calls.filter((x) => x === "query_feedback").length;
  await send(
    "Exclude the thread with ID fixture:angry, use the pricing aspect, and challenge the negative pricing conclusion with actual positive evidence.",
  );
  await expect
    .poll(() => calls.filter((x) => x === "query_feedback").length, {
      timeout: 45000,
    })
    .toBeGreaterThan(previousQueries);
  await expect
    .poll(() => packet?.filters.excludedThreadIds.includes("fixture:angry"), {
      timeout: 30000,
    })
    .toBe(true);
  await expect
    .poll(() => packet?.opposingEvidence.length, { timeout: 30000 })
    .toBe(3);
  expect(
    packet!.metrics.aspects.find((x) => x.aspect === "pricing")?.negative,
  ).toBe(1);
  phase = "agent-export";
  const downloadPromise = page.waitForEvent("download", { timeout: 45000 });
  await send(
    "Prepare the decision brief for download using this exact scope. Use the prepare_decision_brief tool.",
  );
  const download = await downloadPromise;
  await download.saveAs(".local/conversation-smoke-brief.md");
  expect(calls).toContain("prepare_decision_brief");
  expect(calls).toContain("get_research_status");
  expect(microphones).toBe(0);
  await page.screenshot({
    path: ".local/screenshots/conversation-desktop.png",
    fullPage: true,
  });
  status = "PASS";
  phase = "complete";
} catch {
  await page
    .screenshot({
      path: ".local/conversation-smoke-failure.png",
      fullPage: true,
    })
    .catch(() => {});
  writeFileSync(
    ".local/conversation-smoke-diagnostics.json",
    JSON.stringify(
      {
        phase,
        humanPrompts,
        userTurns,
        agentReplies,
        readStarted,
        readStatusCalls,
        readQueryCalls,
        readQueryReturned,
        answeredAfterReadQuery,
      },
      null,
      2,
    ),
  );
  // Playwright errors may include protocol URLs. Store only bounded, non-sensitive evidence.
  console.error(
    "Conversation smoke did not meet all assertions. Inspect the local UI and sanitized report.",
  );
  process.exitCode = 1;
} finally {
  const stop = page.getByRole("button", { name: /^Stop conversation$/ });
  if (await stop.count()) await stop.click().catch(() => {});
  await context.close();
  await browser.close();
  const report = {
    status,
    phase,
    observedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    transport: "Real ElevenLabs private WebSocket; React SDK; textOnly",
    evidence:
      "Explicitly synthetic AcmeFlow data; real HTTP tools and Elasticsearch",
    bindSucceeded,
    registeredClientToolCalls: calls,
    agentReplies,
    humanPrompts,
    outboundUserMessages: userTurns,
    automaticCompletion: {
      startedByWorkspaceMessage: readStarted,
      statusToolCalls: readStatusCalls,
      queryToolCalls: readQueryCalls,
      authenticatedQueryReturned: readQueryReturned,
      agentAnsweredAfterEvidence: answeredAfterReadQuery,
    },
    microphoneRequests: microphones,
    finalScope: packet
      ? {
          collected: packet.metrics.collectedRecords,
          relevant: packet.metrics.relevantRecords,
          filters: packet.filters,
          opposingEvidence: packet.opposingEvidence.map((e) => e.id),
        }
      : null,
    limitation:
      "Physical microphone, audio quality and live voice interruption were not tested by this text-only check.",
  };
  mkdirSync(".local", { recursive: true });
  writeFileSync(
    ".local/conversation-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
