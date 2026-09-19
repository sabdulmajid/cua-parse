import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Client } from "@elastic/elasticsearch";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import {
  filtersSchema,
  type ResearchJob,
  type EvidencePacket,
} from "../src/shared/contracts.js";
import facts from "../fixtures/acmeflow.expected.json";
const port = Number(process.env.API_TEST_PORT || 3099);
const origin = `http://127.0.0.1:${port}`;
const index = "cua-parse-api-test-" + randomUUID();
let service: ReturnType<typeof createApp>, server: Server, dir: string;
type Session = { cookie: string; csrf: string };
let a: Session, b: Session;
let jobA: ResearchJob, jobB: ResearchJob;
async function session() {
  const r = await fetch(origin + "/api/session");
  const j = await r.json();
  return {
    cookie: r.headers.get("set-cookie")!.split(";")[0],
    csrf: j.csrfToken,
  };
}
async function call(
  s: Session,
  name: string,
  body: unknown,
  extra: Record<string, string> = {},
) {
  const r = await fetch(origin + name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: s.cookie,
      "X-CSRF-Token": s.csrf,
      ...extra,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const start = (key: string) => ({
  product: "AcmeFlow",
  question: "What about pricing and onboarding?",
  mode: "fixture",
  idempotencyKey: key,
});
async function ready(s: Session, id: string) {
  for (let i = 0; i < 150; i++) {
    const r = await call(s, "/api/tools/get_research_status", {
      researchId: id,
    });
    if (["ready", "failed", "cancelled"].includes(r.body.job.state))
      return r.body.job as ResearchJob;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Job did not reach terminal state");
}
const query = (id: string, changes: object = {}) => ({
  researchId: id,
  question: "pricing",
  filters: filtersSchema.parse({ aspect: "pricing" }),
  requestId: randomUUID(),
  ...changes,
});
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cua-parse-api-test-"));
  const config = loadConfig({
    PORT: String(port),
    APP_BASE_URL: origin,
    APP_SESSION_SECRET: "integration-only-secret-not-a-provider-key",
    CUA_LOCAL_DIR: dir,
    ELASTICSEARCH_URL: process.env.ELASTICSEARCH_URL || "http://127.0.0.1:9200",
    ELASTICSEARCH_INDEX: index,
  });
  service = createApp(config);
  await service.evidence.init();
  server = await new Promise<Server>((resolve) => {
    const s = service.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  a = await session();
  b = await session();
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (service) await service.close();
  const es = new Client({
    node: process.env.ELASTICSEARCH_URL || "http://127.0.0.1:9200",
  });
  if (await es.indices.exists({ index })) await es.indices.delete({ index });
  await es.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
describe("real HTTP tools + worker + SQLite + Elasticsearch", () => {
  it("runs two simultaneous isolated research jobs to completion", async () => {
    const [one, two] = await Promise.all([
      call(a, "/api/tools/start_research", start("integration-a")),
      call(b, "/api/tools/start_research", start("integration-b")),
    ]);
    expect(one.status).toBe(202);
    expect(two.status).toBe(202);
    [jobA, jobB] = await Promise.all([
      ready(a, one.body.job.id),
      ready(b, two.body.job.id),
    ]);
    expect(jobA.state).toBe("ready");
    expect(jobB.state).toBe("ready");
    expect(jobA.indexed).toBe(facts.uniqueRecords);
    expect(jobA.duplicates).toBe(facts.duplicates);
    expect(jobA.id).not.toBe(jobB.id);
    expect(
      (await call(b, "/api/tools/query_feedback", query(jobA.id))).status,
    ).toBe(404);
  });
  it("executes real tool route, changes counts on exclusion, retrieves actual counterevidence", async () => {
    const first = await call(a, "/api/tools/query_feedback", query(jobA.id));
    expect(first.status).toBe(200);
    const p = first.body.packet as EvidencePacket;
    expect(p.metrics.relevantRecords).toBe(facts.pricing.mentions);
    expect(
      p.metrics.aspects.find((x) => x.aspect === "pricing")?.negative,
    ).toBe(facts.pricing.negative);
    const scope = filtersSchema.parse({
      aspect: "pricing",
      excludedThreadIds: ["fixture:angry"],
    });
    const second = await call(
      a,
      "/api/tools/query_feedback",
      query(jobA.id, { filters: scope, challenge: true }),
    );
    expect(second.status).toBe(200);
    const q = second.body.packet as EvidencePacket;
    expect(q.scopeVersion).not.toBe(p.scopeVersion);
    expect(
      q.metrics.aspects.find((x) => x.aspect === "pricing")?.negative,
    ).toBe(1);
    expect(q.opposingEvidence.length).toBeGreaterThan(0);
    expect(
      q.opposingEvidence.every(
        (e) =>
          e.threadId !== "fixture:angry" &&
          e.aspects.some(
            (v) => v.aspect === "pricing" && v.sentiment === "positive",
          ),
      ),
    ).toBe(true);
  });
  it("exports the same scoped evidence with no external action", async () => {
    const r = await call(
      a,
      "/api/tools/prepare_decision_brief",
      query(jobA.id, {
        filters: filtersSchema.parse({ excludedThreadIds: ["fixture:angry"] }),
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.brief.markdown).toContain("synthetic");
    expect(r.body.brief.markdown).toContain("fixture:angry");
    expect(r.body.brief.markdown).toContain("No external ticket was created");
    expect(r.body.brief.scopeVersion).toBeTruthy();
  });
  it("rejects CSRF, bad Origin, foreign conversation, invalid dates, oversized uploads", async () => {
    expect(
      (
        await call(
          a,
          "/api/tools/get_research_status",
          { researchId: jobA.id },
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          a,
          "/api/tools/get_research_status",
          { researchId: jobA.id },
          { Origin: "https://attacker.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(a, "/api/tools/query_feedback", query(jobA.id), {
          "X-Conversation-Id": "foreign",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          a,
          "/api/tools/query_feedback",
          query(jobA.id, {
            filters: {
              from: "2026-10-01T00:00:00.000Z",
              to: "2026-01-01T00:00:00.000Z",
            },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(a, "/api/tools/start_research", {
          data: "x".repeat(3_200_000),
        })
      ).status,
    ).toBe(413);
  });
  it("keeps duplicate submissions idempotent and voice absence explicit", async () => {
    const r = await call(
      a,
      "/api/tools/start_research",
      start("integration-a"),
    );
    expect(r.body.job.id).toBe(jobA.id);
    const v = await call(a, "/api/voice/session", { mode: "text" });
    expect(v.status).toBe(503);
    expect(v.body).not.toHaveProperty("signedUrl");
  });
  it("supports empty collection and cancellation without stuck jobs", async () => {
    const empty = await call(a, "/api/tools/start_research", {
      ...start("integration-empty"),
      mode: "import",
      records: [],
    });
    const result = await ready(a, empty.body.job.id);
    expect(result.state).toBe("ready");
    const r = await call(a, "/api/tools/query_feedback", query(result.id));
    expect(r.body.packet.metrics.collectedRecords).toBe(0);
    const next = await call(
      a,
      "/api/tools/start_research",
      start("integration-cancel"),
    );
    const cancelled = await call(
      a,
      `/api/research/${next.body.job.id}/cancel`,
      {},
    );
    expect(cancelled.body.job.state).toBe("cancelled");
  });
});
