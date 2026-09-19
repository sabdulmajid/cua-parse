/** Mocked UI transport tests only. No Elastic, model, or voice provider calls. */
import { test, expect, type Page, type Route } from "@playwright/test";
import type {
  ElasticAnswer,
  ElasticQueryInput,
  SessionResponse,
} from "../src/shared/contracts.js";

const firstVideo = "video000001";
const secondVideo = "video000002";
const question = "What problems do people report about Teams?";
const baseScope = { excludedVideoIds: [], from: null, to: null };

function answer(input: ElasticQueryInput, text?: string): ElasticAnswer {
  const excluded = input.scope.excludedVideoIds.includes(firstVideo);
  const videoId = excluded ? secondVideo : firstVideo;
  return {
    requestId: input.requestId,
    question: input.question,
    scope: input.scope,
    index: "mocked-youtube-comments",
    answer:
      text ??
      (excluded
        ? "The remaining comments report missing notifications. [1]"
        : "The comments report slow calls and missing notifications. [1]"),
    metrics: {
      totalRecords: 120,
      scopedRecords: excluded ? 40 : 120,
      positive: excluded ? 10 : 20,
      negative: excluded ? 20 : 84,
      neutral: excluded ? 10 : 16,
      complaints: excluded ? 20 : 84,
      distinctVideos: excluded ? 2 : 3,
      firstPublished: "2026-01-01T00:00:00.000Z",
      lastPublished: "2026-09-01T00:00:00.000Z",
      videos: [
        ...(!excluded
          ? [
              {
                id: firstVideo,
                title: "Mock call discussion",
                count: 80,
                complaints: 64,
              },
            ]
          : []),
        {
          id: secondVideo,
          title: "Mock notification discussion",
          count: 30,
          complaints: 15,
        },
        {
          id: "video000003",
          title: "Mock setup discussion",
          count: 10,
          complaints: 5,
        },
      ],
      categories: [{ name: "Performance", count: excluded ? 20 : 84 }],
    },
    examples: [
      {
        id: excluded ? "mock-comment-two" : "mock-comment-one",
        text: excluded
          ? "Notifications do not arrive."
          : "Teams freezes during calls.",
        videoId,
        videoTitle: excluded
          ? "Mock notification discussion"
          : "Mock call discussion",
        url: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: "2026-05-01T00:00:00.000Z",
        sentiment: "negative",
        isComplaint: true,
        categories: ["Performance"],
        likeCount: 3,
      },
    ],
    toolCalls: [{ tool: "mocked_comments_search" }],
    limitations: ["Mocked test records. Counts do not describe all customers."],
    generatedAt: "2026-09-19T00:00:00.000Z",
  };
}

async function isolate(page: Page) {
  const blocked: string[] = [];
  let microphoneRequests = 0;
  await page.exposeFunction("recordElasticTestMicrophone", () => {
    microphoneRequests++;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => {
        void (
          window as unknown as {
            recordElasticTestMicrophone: () => Promise<void>;
          }
        ).recordElasticTestMicrophone();
        return Promise.reject(
          new DOMException(
            "Microphone blocked in mocked test",
            "NotAllowedError",
          ),
        );
      },
    });
  });
  await page.route("**/api/**", async (route) => {
    blocked.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 400,
      json: { error: "Unexpected API call blocked by mocked Elastic UI test." },
    });
  });
  await page.routeWebSocket(/.*/, (socket) => {
    blocked.push("provider WebSocket");
    socket.close({
      code: 1000,
      reason: "No provider sockets in mocked tests.",
    });
  });
  const session: SessionResponse = {
    csrfToken: "mocked-elastic-csrf-token",
    jobs: [],
    providers: {},
    voiceAvailable: false,
    elasticAgentAvailable: true,
  };
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: session }),
  );
  return () => {
    expect(blocked).toEqual([]);
    expect(microphoneRequests).toBe(0);
  };
}

async function chooseElastic(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("Research source", { exact: true })).toHaveValue(
    "live",
  );
  await page
    .getByLabel("Research source", { exact: true })
    .selectOption("elastic");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  const button = page.getByRole("button", {
    name: "Send message",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.click();
}

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function settleDisplay(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function fulfillDelayed(route: Route, response: ElasticAnswer) {
  try {
    await route.fulfill({ json: response });
  } catch (error) {
    if (!route.request().failure()) throw error;
  }
}

test("mocked Elastic text answer shows counts and sources; exclude/reset preserve the submitted question", async ({
  page,
}) => {
  const assertIsolated = await isolate(page);
  const requests: ElasticQueryInput[] = [];
  const gate = deferred();
  await page.route("**/api/elastic/query", async (route) => {
    const input = route.request().postDataJSON() as ElasticQueryInput;
    requests.push(input);
    expect(route.request().headers()["x-csrf-token"]).toBe(
      "mocked-elastic-csrf-token",
    );
    if (requests.length === 1) await gate.promise;
    await route.fulfill({ json: answer(input) });
  });
  try {
    await chooseElastic(page);
    await send(page, question);
    await expect(
      page.getByText("Elastic is checking the comments…", { exact: true }),
    ).toBeVisible();
    gate.release();
    await expect(
      page.getByRole("heading", { name: "What the comments say", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".elastic-answer")).toContainText(
      "The comments report slow calls and missing notifications.",
    );
    await expect(
      page.getByText("120 comments in scope", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("3 videos", { exact: true })).toBeVisible();
    await expect(
      page.getByText("84 labeled complaints", { exact: true }),
    ).toBeVisible();
    const sources = page.locator(".elastic-source-quotes");
    const sourceCard = page.locator("#elastic-source-1");
    await expect(sourceCard).toBeHidden();
    await page
      .locator(".elastic-answer .conclusion")
      .getByRole("link", { name: "Source 1", exact: true })
      .click();
    await expect(sourceCard).toBeVisible();
    await expect(sourceCard).toBeFocused();
    await expect(sourceCard.locator("blockquote")).toHaveText(
      "Teams freezes during calls.",
    );
    await expect(
      sources.getByRole("link", { name: "View video", exact: true }),
    ).toHaveAttribute("href", `https://www.youtube.com/watch?v=${firstVideo}`);
    await page.getByText("Evidence details", { exact: true }).click();
    await expect(page.locator(".elastic-details")).toContainText(
      "They have not been independently verified.",
    );
    await page
      .getByLabel("Message", { exact: true })
      .fill("Unsent draft must not change the active scope question.");
    await page
      .getByRole("button", { name: "Exclude largest video", exact: true })
      .click();
    await expect(
      page.getByText("40 comments in scope", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".elastic-answer")).toContainText(
      "The remaining comments report missing notifications.",
    );
    await page
      .locator(".elastic-answer .conclusion")
      .getByRole("link", { name: "Source 1", exact: true })
      .click();
    await expect(sourceCard).toBeVisible();
    await expect(sourceCard.locator("blockquote")).toHaveText(
      "Notifications do not arrive.",
    );
    await expect(
      sources.getByRole("link", { name: "View video", exact: true }),
    ).toHaveAttribute("href", `https://www.youtube.com/watch?v=${secondVideo}`);
    expect(requests[1]).toMatchObject({
      question,
      scope: { ...baseScope, excludedVideoIds: [firstVideo] },
    });
    await page
      .getByRole("button", { name: "Reset scope", exact: true })
      .click();
    await expect(
      page.getByText("120 comments in scope", { exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({ question, scope: baseScope });
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(3);
    await page.reload();
    await expect(
      page.getByLabel("Research source", { exact: true }),
    ).toHaveValue("elastic");
    assertIsolated();
  } finally {
    gate.release();
  }
});

test("a cancelled mocked Elastic response cannot replace the next answer", async ({
  page,
}) => {
  const assertIsolated = await isolate(page);
  const gate = deferred();
  const requests: ElasticQueryInput[] = [];
  let delivered = false;
  await page.route("**/api/elastic/query", async (route) => {
    const input = route.request().postDataJSON() as ElasticQueryInput;
    requests.push(input);
    if (requests.length === 1) {
      await gate.promise;
      try {
        await fulfillDelayed(route, answer(input, "STALE CANCELLED ANSWER"));
      } finally {
        delivered = true;
      }
    } else
      await route.fulfill({
        json: answer(input, "Current answer: notifications are missing."),
      });
  });
  try {
    await chooseElastic(page);
    await send(page, question);
    await expect.poll(() => requests.length).toBe(1);
    await page
      .getByRole("button", { name: "Cancel request", exact: true })
      .click();
    await send(page, "What do people report about notifications?");
    await expect(page.locator(".elastic-answer")).toContainText(
      "Current answer: notifications are missing.",
    );
    gate.release();
    await expect.poll(() => delivered).toBe(true);
    await settleDisplay(page);
    await expect(
      page.getByText("STALE CANCELLED ANSWER", { exact: false }),
    ).toHaveCount(0);
    await expect(page.locator(".elastic-answer")).toContainText(
      "Current answer: notifications are missing.",
    );
    expect(requests).toHaveLength(2);
    assertIsolated();
  } finally {
    gate.release();
  }
});

test("a late mocked Elastic response cannot switch the selected source back from Live", async ({
  page,
}) => {
  const assertIsolated = await isolate(page);
  const gate = deferred();
  let requested = false;
  let delivered = false;
  await page.route("**/api/elastic/query", async (route) => {
    requested = true;
    const input = route.request().postDataJSON() as ElasticQueryInput;
    await gate.promise;
    try {
      await fulfillDelayed(route, answer(input, "STALE SOURCE ANSWER"));
    } finally {
      delivered = true;
    }
  });
  try {
    await chooseElastic(page);
    await send(page, question);
    await expect.poll(() => requested).toBe(true);
    await page
      .getByLabel("Research source", { exact: true })
      .selectOption("live");
    gate.release();
    await expect.poll(() => delivered).toBe(true);
    await settleDisplay(page);
    await expect(
      page.getByLabel("Research source", { exact: true }),
    ).toHaveValue("live");
    await expect(page.locator(".elastic-answer")).toHaveCount(0);
    await expect(
      page.getByText("STALE SOURCE ANSWER", { exact: false }),
    ).toHaveCount(0);
    assertIsolated();
  } finally {
    gate.release();
  }
});

test("a mocked Elastic error can retry the same question without voice credentials", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const assertIsolated = await isolate(page);
  const requests: ElasticQueryInput[] = [];
  await page.route("**/api/elastic/query", async (route) => {
    const input = route.request().postDataJSON() as ElasticQueryInput;
    requests.push(input);
    if (requests.length === 1)
      await route.fulfill({
        status: 503,
        json: { error: "Mock Elastic temporary failure." },
      });
    else await route.fulfill({ json: answer(input) });
  });
  await chooseElastic(page);
  await send(page, question);
  await expect(page.getByRole("alert")).toContainText(
    "Mock Elastic temporary failure.",
  );
  await page
    .getByRole("button", { name: "Retry question", exact: true })
    .click();
  await expect(page.locator(".elastic-answer")).toContainText(
    "The comments report slow calls and missing notifications.",
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ question, scope: baseScope });
  expect(requests[1].requestId).not.toBe(requests[0].requestId);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  assertIsolated();
});

test("persisted Elastic mode exposes a failed session request and recovers without losing the draft", async ({
  page,
}) => {
  const assertIsolated = await isolate(page);
  await page.addInitScript(() => {
    sessionStorage.setItem("cua-research-source", "elastic");
  });
  let sessionRequests = 0;
  await page.route("**/api/session", async (route) => {
    sessionRequests++;
    if (sessionRequests === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "Mock session service is temporarily unavailable." },
      });
    } else await route.fallback();
  });
  const requests: ElasticQueryInput[] = [];
  await page.route("**/api/elastic/query", async (route) => {
    const input = route.request().postDataJSON() as ElasticQueryInput;
    requests.push(input);
    expect(route.request().headers()["x-csrf-token"]).toBe(
      "mocked-elastic-csrf-token",
    );
    await route.fulfill({ json: answer(input) });
  });

  await page.goto("/");
  await expect(page.getByLabel("Research source", { exact: true })).toHaveValue(
    "elastic",
  );
  await expect(page.getByRole("alert")).toHaveText(
    "Mock session service is temporarily unavailable.",
  );
  await page.getByLabel("Message", { exact: true }).fill(question);
  const sendButton = page.getByRole("button", {
    name: "Send message",
    exact: true,
  });
  await expect(sendButton).toBeDisabled();
  await expect(
    page.getByText("Elastic Agent is not configured.", { exact: false }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(0);

  await page
    .getByRole("button", { name: "Retry server connection", exact: true })
    .click();
  await expect(sendButton).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry server connection", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    question,
  );
  await sendButton.click();
  await expect(page.locator(".elastic-answer")).toContainText(
    "The comments report slow calls and missing notifications.",
  );
  expect(sessionRequests).toBe(2);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ question, scope: baseScope });
  assertIsolated();
});
