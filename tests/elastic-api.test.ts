import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { ElasticAnswer } from "../src/shared/contracts.js";
const port = Number(process.env.ELASTIC_API_TEST_PORT || 3098);
const mocked = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }));
vi.mock("../src/server/elastic-cloud.js", () => ({
  ElasticCloud: class {
    query = mocked.query;
    close = mocked.close;
  },
  ElasticCloudError: class extends Error {},
}));
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
let service: ReturnType<typeof createApp>,
  server: Server,
  dir: string,
  origin: string;
type Session = { cookie: string; csrf: string };
const input = (id: string) => ({
  question: "What sucks about Microsoft Teams?",
  scope: { excludedVideoIds: [], from: null, to: null },
  requestId: id,
});
const answer: ElasticAnswer = {
  ...input("test-request"),
  index: "youtube-product-comments",
  answer: "A synthetic test answer.",
  metrics: {
    totalRecords: 240,
    scopedRecords: 240,
    positive: 150,
    negative: 52,
    neutral: 38,
    complaints: 52,
    distinctVideos: 4,
    firstPublished: null,
    lastPublished: null,
    videos: [],
    categories: [],
  },
  examples: [],
  toolCalls: [],
  limitations: ["Test fixture only."],
  generatedAt: "2026-09-19T00:00:00.000Z",
};
async function session(): Promise<Session> {
  const r = await fetch(origin + "/api/session");
  const data = await r.json();
  expect(data.elasticAgentAvailable).toBe(true);
  expect(JSON.stringify(data)).not.toContain("server-only-test-key");
  return {
    cookie: r.headers.get("set-cookie")!.split(";")[0],
    csrf: data.csrfToken,
  };
}
async function call(
  s: Session,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(origin + "/api/elastic/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: s.cookie,
      "X-CSRF-Token": s.csrf,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cua-parse-elastic-route-test-"));
  const config = loadConfig({
    APP_SESSION_SECRET: "elastic-test-secret-long-enough-0000",
    CUA_LOCAL_DIR: dir,
    ELASTIC_CLOUD_URL: "https://cluster.example.com",
    ELASTIC_CLOUD_KIBANA_URL: "https://kibana.example.com",
    ELASTIC_CLOUD_API_KEY: "server-only-test-key",
    ELASTIC_CLOUD_INDEX: "youtube-product-comments",
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
  });
  service = createApp(config);
  server = await new Promise<Server>((resolve) => {
    const s = service.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  origin = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  if (service) await service.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mocked.query.mockReset();
  mocked.query.mockImplementation(async (q) => ({ ...answer, ...q }));
});
describe("authenticated Elastic source API", () => {
  it("requires the current session CSRF and allowed origin before provider work", async () => {
    const s = await session();
    expect(
      (await call(s, input("bad-csrf-token"), { "X-CSRF-Token": "wrong" }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(s, input("bad-origin-request"), {
          Origin: "https://outside.example",
        })
      ).status,
    ).toBe(403);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("returns exact metrics and reuses only a matching session-owned request", async () => {
    const a = await session(),
      b = await session(),
      q = input("replay-request-1");
    expect((await call(a, q)).body.metrics.scopedRecords).toBe(240);
    expect((await call(a, q)).status).toBe(200);
    expect(mocked.query).toHaveBeenCalledTimes(1);
    expect(
      (await call(a, { ...q, question: "Different question" })).status,
    ).toBe(409);
    expect((await call(b, q)).status).toBe(200);
    expect(mocked.query).toHaveBeenCalledTimes(2);
  });
  it("rejects browser-supplied provider IDs, invalid filters and reversed dates", async () => {
    const s = await session(),
      q = input("invalid-body-request");
    for (const body of [
      { ...q, conversationId: "foreign" },
      { ...q, scope: { ...q.scope, excludedVideoIds: ["invalid/video"] } },
      {
        ...q,
        scope: {
          ...q.scope,
          from: "2026-01-01T00:00:00Z",
          to: "2025-01-01T00:00:00Z",
        },
      },
    ])
      expect((await call(s, body)).status).toBe(400);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("normalizes equivalent timestamps before ordering and replay checks", async () => {
    const s = await session();
    const q = {
      ...input("equivalent-date-request"),
      scope: {
        excludedVideoIds: [],
        from: "2025-01-01T00:00:00Z",
        to: "2025-01-01T00:00:00.000Z",
      },
    };
    const first = await call(s, q);
    expect(first.status).toBe(200);
    expect(first.body.scope.from).toBe("2025-01-01T00:00:00.000Z");
    expect(
      (await call(s, { ...q, scope: { ...q.scope, from: q.scope.to } })).status,
    ).toBe(200);
    expect(mocked.query).toHaveBeenCalledTimes(1);
  });
  it("serializes questions from the same session", async () => {
    const s = await session();
    let finish!: (value: ElasticAnswer) => void;
    mocked.query.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = call(s, input("first-active-request"));
    await vi.waitFor(() => expect(mocked.query).toHaveBeenCalledTimes(1));
    expect((await call(s, input("second-active-request"))).status).toBe(409);
    finish(answer);
    expect((await first).status).toBe(200);
  });
  it("aborts disconnected provider work and releases the session slot", async () => {
    const s = await session();
    let providerSignal: AbortSignal | undefined;
    mocked.query.mockImplementationOnce((_input, signal: AbortSignal) => {
      providerSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    });
    const controller = new AbortController();
    const pending = fetch(origin + "/api/elastic/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: s.cookie,
        "X-CSRF-Token": s.csrf,
      },
      body: JSON.stringify(input("aborted-request-1")),
      signal: controller.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
    expect((await call(s, input("after-abort-request"))).status).toBe(200);
  });
  it("never sends unexpected provider errors or credentials to the browser", async () => {
    mocked.query.mockRejectedValue(
      new Error("Authorization: ApiKey server-only-test-key"),
    );
    const r = await call(await session(), input("provider-error-request"));
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("server-only-test-key");
  });
  it("enforces the global request budget before more provider work", async () => {
    const s = await session();
    let blocked = false;
    for (let i = 0; i < 31; i++) {
      const calls = mocked.query.mock.calls.length;
      const response = await call(s, input("budget-request-" + i));
      if (response.status === 429) {
        expect(mocked.query).toHaveBeenCalledTimes(calls);
        blocked = true;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(blocked).toBe(true);
  });
});
