/** Deterministic UI checks: real local API/Elasticsearch, synthetic records, no paid provider calls. */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { EvidencePacket } from "../src/shared/contracts.js";

async function preventPaidWork(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route(
    /\/api\/voice\/(?:session|token)(?:\?.*)?$/,
    async (route) => {
      blocked.push("conversation credential request");
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            "Provider sessions are blocked in this synthetic browser test.",
        }),
      });
    },
  );
  await page.routeWebSocket(/elevenlabs\.io/i, (socket) => {
    blocked.push("provider WebSocket");
    socket.close({
      code: 1000,
      reason: "No paid providers in deterministic browser tests.",
    });
  });
  await page.route("**/api/tools/start_research", async (route) => {
    if (route.request().postDataJSON()?.mode !== "fixture") {
      blocked.push("non-synthetic research request");
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Only synthetic research is allowed in this browser test.",
        }),
      });
    } else await route.continue();
  });
  return blocked;
}

function packets(page: Page) {
  let latest: EvidencePacket | undefined;
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/tools/query_feedback") && response.ok()) {
      try {
        latest = (await response.json()).packet;
      } catch {
        /* A deliberately cancelled response has no body. */
      }
    }
  });
  return () => latest;
}

async function startDemo(page: Page) {
  // Let the app establish its cookie and CSRF token before another session GET.
  await expect(
    page.getByRole("button", { name: "Try demo", exact: true }),
  ).toBeEnabled();
  // A hybrid server would perform billable embeddings even for a synthetic job.
  const session = await page.request.get("/api/session");
  expect(session.ok()).toBe(true);
  expect((await session.json()).providers.semantic.status).toBe("disabled");
  await page.getByRole("button", { name: "Try demo", exact: true }).click();
}

async function details(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Details", exact: true });
  if (!(await dialog.isVisible()))
    await page
      .getByRole("button", { name: "Details", exact: true })
      .first()
      .click();
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Filter by aspect")).toBeVisible();
}

test("synthetic demo → Details → pricing → exclusion → challenge → cited export", async ({
  page,
}) => {
  const blocked = await preventPaidWork(page);
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  const latest = packets(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Try demo", exact: true }),
  ).toBeEnabled();
  await startDemo(page);
  await expect.poll(() => latest()?.metrics.relevantRecords).toBe(18);
  expect(latest()?.metrics.collectedRecords).toBe(21);
  expect(latest()?.provenance).toEqual(["synthetic"]);
  expect(latest()?.challenge).toBe(false);
  const overview = page.getByRole("region", {
    name: "What the sample says about AcmeFlow",
    exact: true,
  });
  const overviewFindings = overview.locator(".answer-findings > li");
  await expect(overviewFindings).toHaveCount(latest()!.findings.length);
  expect(latest()!.findings.length).toBeGreaterThan(0);
  for (const [index, finding] of latest()!.findings.entries())
    await expect(overviewFindings.nth(index).locator("p")).toHaveText(
      finding.text,
    );
  const firstCitation = latest()!.findings[0].evidenceIds[0];
  await overviewFindings
    .first()
    .getByRole("button", { name: "Source 1", exact: true })
    .click();
  await expect(page.locator(`[id="evidence-${firstCitation}"]`)).toBeVisible();
  await details(page);
  await page.getByLabel("Filter by aspect").selectOption("pricing");
  await expect.poll(() => latest()?.filters.aspect).toBe("pricing");
  expect(
    latest()?.metrics.aspects.find((aspect) => aspect.aspect === "pricing"),
  ).toMatchObject({ mentions: 13, negative: 9, positive: 3, neutral: 1 });
  const firstScope = latest()!.scopeVersion;
  const angryThread = latest()!.metrics.threads.find(
    (thread) => thread.threadId === "fixture:angry",
  )!;
  await page.getByText("Threads & concentration", { exact: true }).click();
  const row = page
    .locator(".thread-row")
    .filter({ hasText: angryThread.title });
  await row.getByRole("button", { name: /Exclude/ }).click();
  await expect
    .poll(() => latest()?.filters.excludedThreadIds.includes("fixture:angry"))
    .toBe(true);
  expect(latest()!.scopeVersion).not.toBe(firstScope);
  expect(
    latest()?.metrics.aspects.find((aspect) => aspect.aspect === "pricing"),
  ).toMatchObject({ mentions: 5, negative: 1, positive: 3, neutral: 1 });
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Challenge conclusion", exact: true })
    .click();
  await expect.poll(() => latest()?.challenge).toBe(true);
  await expect(
    page.getByRole("heading", {
      name: "What points the other way?",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    latest()!
      .opposingEvidence.map((record) => record.id)
      .sort(),
  ).toEqual(["fixture:praise-1", "fixture:praise-2", "fixture:praise-3"]);
  expect(
    latest()!.opposingEvidence.every(
      (record) => record.threadId !== "fixture:angry",
    ),
  ).toBe(true);
  await details(page);
  await page
    .getByLabel("Conclusion sentiment to challenge")
    .selectOption("positive");
  await expect
    .poll(() =>
      latest()?.opposingEvidence.some((record) =>
        record.aspects.some(
          (aspect) =>
            aspect.aspect === "pricing" && aspect.sentiment === "negative",
        ),
      ),
    )
    .toBe(true);
  await page
    .getByLabel("Conclusion sentiment to challenge")
    .selectOption("negative");
  await expect.poll(() => latest()?.opposingEvidence.length).toBe(3);
  await page.getByText("Sample & themes", { exact: true }).click();
  const citationIds = [
    ...new Set(latest()!.findings.flatMap((finding) => finding.evidenceIds)),
  ];
  expect(citationIds.length).toBeGreaterThan(0);
  await page
    .getByRole("dialog", { name: "Details", exact: true })
    .getByRole("button", { name: citationIds[0], exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Details", exact: true }),
  ).toBeHidden();
  for (const id of citationIds)
    await expect(page.locator(`[id="evidence-${id}"]`)).toBeVisible();
  const challengeFindings = page
    .getByRole("region", { name: "What points the other way?", exact: true })
    .locator(".answer-findings > li");
  await expect(challengeFindings).toHaveCount(latest()!.findings.length);
  for (const [index, finding] of latest()!.findings.entries()) {
    await expect(challengeFindings.nth(index).locator("p")).toHaveText(
      finding.text,
    );
    expect(
      finding.evidenceIds.every((id) =>
        latest()!.opposingEvidence.some((record) => record.id === id),
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: ".local/screenshots/challenge-desktop.png",
    fullPage: true,
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export brief", exact: true }).click();
  const download = await downloadPromise;
  const file = await download.path();
  expect(file).toBeTruthy();
  const markdown = readFileSync(file!, "utf8");
  expect(markdown).toContain(latest()!.scopeVersion);
  expect(markdown).toContain("fixture:praise-1");
  expect(markdown).toContain("fixture:angry");
  expect(markdown).toContain("No external ticket was created");
  expect(blocked).toEqual([]);
  expect(failures).toEqual([]);
});

test("mobile start stays within the screen and cannot read another session research", async ({
  page,
  browser,
  baseURL,
}) => {
  const ownerBlocked = await preventPaidWork(page);
  const latest = packets(page);
  await page.goto("/");
  await startDemo(page);
  await expect.poll(() => latest()?.researchId).toBeTruthy();
  const researchId = latest()!.researchId;
  const mobile = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  try {
    const foreign = await mobile.newPage();
    const foreignBlocked = await preventPaidWork(foreign);
    await foreign.goto("/");
    await expect(
      foreign.getByRole("button", { name: "Try demo", exact: true }),
    ).toBeVisible();
    const response = await mobile.request.get("/api/session");
    const session = await response.json();
    expect(session.jobs).toEqual([]);
    const denied = await mobile.request.post("/api/tools/get_research_status", {
      headers: { "X-CSRF-Token": session.csrfToken },
      data: { researchId },
    });
    expect(denied.status()).toBe(404);
    expect(
      await foreign.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await foreign.screenshot({
      path: ".local/screenshots/start-mobile.png",
      fullPage: true,
    });
    expect(ownerBlocked).toEqual([]);
    expect(foreignBlocked).toEqual([]);
  } finally {
    await mobile.close();
  }
});

test("a delayed old response cannot replace new research or add stale findings", async ({
  page,
}) => {
  const blocked = await preventPaidWork(page);
  const marker = "STALE RESEARCH RESPONSE MUST NOT APPEAR";
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstResearch = "";
  let held = false;
  let delivered = false;
  let current: EvidencePacket | undefined;
  await page.route("**/api/tools/query_feedback", async (route) => {
    if (!firstResearch) {
      firstResearch = route.request().postDataJSON().researchId;
      const response = await route.fetch();
      const body = await response.json();
      held = true;
      await gate;
      try {
        await route.fulfill({
          response,
          json: {
            ...body,
            packet: {
              ...body.packet,
              question: marker,
              spokenSummary: marker,
              findings: [
                {
                  id: "stale-marker",
                  aspect: "pricing",
                  text: marker,
                  evidenceIds: [],
                },
              ],
            },
          },
        });
      } catch (error) {
        if (!route.request().failure()) throw error;
      } finally {
        delivered = true;
      }
    } else await route.continue();
  });
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/tools/query_feedback") && response.ok()) {
      try {
        const packet = (await response.json()).packet as EvidencePacket;
        if (packet.researchId !== firstResearch) current = packet;
      } catch {
        /* Cancelled response. */
      }
    }
  });
  try {
    await page.goto("/");
    await startDemo(page);
    await expect.poll(() => held).toBe(true);
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await startDemo(page);
    await expect.poll(() => current?.researchId).toBeTruthy();
    expect(current!.researchId).not.toBe(firstResearch);
    await details(page);
    const newResearch = current!.researchId;
    release();
    await expect.poll(() => delivered).toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByText(marker, { exact: false })).toHaveCount(0);
    expect(current?.researchId).toBe(newResearch);
    expect(current?.metrics.relevantRecords).toBe(18);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(blocked).toEqual([]);
  } finally {
    release();
  }
});

test("microphone denial occurs before credentials and leaves the independent demo usable", async ({
  page,
}) => {
  const blocked = await preventPaidWork(page);
  const latest = packets(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        throw new DOMException(
          "Denied for deterministic browser test",
          "NotAllowedError",
        );
      },
    });
  });
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, voiceAvailable: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Talk", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Microphone access was denied",
  );
  expect(blocked).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Try demo", exact: true }),
  ).toBeEnabled();
  await startDemo(page);
  await expect.poll(() => latest()?.metrics.relevantRecords).toBe(18);
  expect(blocked).toEqual([]);
});

test("repeated analysis warnings use one main notice and remain inspectable in Details", async ({
  page,
}) => {
  const blocked = await preventPaidWork(page);
  const latest = packets(page);
  // Explicit transport mock: real synthetic collection, with repeated failure
  // metadata injected only to verify presentation. No provider is called.
  const failures = Array.from(
    { length: 12 },
    (_, index) =>
      `Mock record ${index + 1}: structured analysis failed validation.`,
  );
  await page.route("**/api/tools/get_research_status", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        job:
          data.job.state === "ready"
            ? { ...data.job, partial: true, failures }
            : data.job,
      },
    });
  });
  await page.goto("/");
  await startDemo(page);
  await expect.poll(() => latest()?.metrics.relevantRecords).toBe(18);
  const notice = page.locator(".partial-sample-note");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText(
    "Partial sample: some collection or analysis steps did not complete.",
  );
  await expect(page.locator("main .failure-note")).toHaveCount(0);
  await expect(page.getByText(failures[0], { exact: true })).toBeHidden();
  await notice
    .getByRole("button", { name: "View details", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Details", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByText("Collection activity", { exact: true }).click();
  const failureRows = dialog.locator(".failure-note");
  await expect(failureRows).toHaveCount(12);
  await expect(failureRows.first()).toHaveText(failures[0]);
  await expect(failureRows.last()).toHaveText(failures[11]);
  await expect(failureRows.first()).toBeVisible();
  expect(blocked).toEqual([]);
});
