import { afterEach, describe, expect, it } from "vitest";
import { request, type APIRequestContext } from "@playwright/test";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { SessionResponse } from "../src/shared/contracts.js";

const servers: Array<{
  server: Server;
  service: ReturnType<typeof createApp>;
  dir: string;
}> = [];
const clients: APIRequestContext[] = [];
async function app(label: string) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local test port");
  const origin = `http://127.0.0.1:${address.port}`;
  const secret = `test-only-${label}-session-secret-with-sufficient-length`;
  const dir = mkdtempSync(path.join(tmpdir(), "cua-parse-session-isolation-"));
  const service = createApp(
    loadConfig({
      PORT: String(address.port),
      APP_BASE_URL: origin,
      APP_SESSION_SECRET: secret,
      CUA_LOCAL_DIR: dir,
      VOICE_MODE: "disabled",
    }),
  );
  server.on("request", service.app);
  servers.push({ server, service, dir });
  return { origin, secret, service };
}
async function client(legacy?: string) {
  // Playwright's cookie store follows browser domain/path rules, including
  // cookies shared across ports. No browser binary or provider call is needed.
  const context = await request.newContext(
    legacy
      ? {
          storageState: {
            cookies: [
              {
                name: "cua_session",
                value: legacy,
                domain: "127.0.0.1",
                path: "/",
                expires: -1,
                httpOnly: true,
                secure: false,
                sameSite: "Strict",
              },
            ],
            origins: [],
          },
        }
      : {},
  );
  clients.push(context);
  return context;
}
function signed(id: string, secret: string) {
  return `${id}.${createHmac("sha256", secret).update(id).digest("hex")}`;
}
function insertJob(
  service: ReturnType<typeof createApp>,
  csrf: string,
  key: string,
) {
  const session = service.db.db
    .prepare("SELECT id FROM sessions WHERE csrf=?")
    .get(csrf) as { id: string };
  return service.db.insertJob(session.id, {
    product: "AcmeFlow",
    question: "What does this synthetic sample say?",
    mode: "fixture",
    idempotencyKey: key,
  }).job;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((context) => context.dispose()));
  for (const { server, service, dir } of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("independent app origins in one browser cookie store", () => {
  it("keeps both sessions, owned jobs, and CSRF tokens usable across two ports", async () => {
    const a = await app("a"),
      b = await app("b");
    const jar = await client();
    const first = (await (
      await jar.get(a.origin + "/api/session")
    ).json()) as SessionResponse;
    const aJob = insertJob(a.service, first.csrfToken, "first-session-job");
    const second = (await (
      await jar.get(b.origin + "/api/session")
    ).json()) as SessionResponse;
    const bJob = insertJob(b.service, second.csrfToken, "second-session-job");
    const cookies = (await jar.storageState()).cookies;
    expect(cookies).toHaveLength(2);
    expect(new Set(cookies.map((cookie) => cookie.name)).size).toBe(2);
    expect(
      cookies.every(
        (cookie) =>
          cookie.name.startsWith("cua_session_") &&
          cookie.httpOnly &&
          cookie.sameSite === "Strict",
      ),
    ).toBe(true);
    for (const [current, expected, job] of [
      [a, first, aJob],
      [b, second, bJob],
      [a, first, aJob],
    ] as const) {
      const session = (await (
        await jar.get(current.origin + "/api/session")
      ).json()) as SessionResponse;
      expect(session.csrfToken).toBe(expected.csrfToken);
      expect(session.jobs.map((item) => item.id)).toEqual([job.id]);
      const status = await jar.post(
        current.origin + "/api/tools/get_research_status",
        {
          headers: { "X-CSRF-Token": expected.csrfToken },
          data: { researchId: job.id },
        },
      );
      expect(status.status()).toBe(200);
      expect((await status.json()).job.id).toBe(job.id);
    }
    const foreign = await jar.post(
      b.origin + "/api/tools/get_research_status",
      {
        headers: { "X-CSRF-Token": second.csrfToken },
        data: { researchId: aJob.id },
      },
    );
    expect(foreign.status()).toBe(404);
  });

  it("migrates a valid legacy session without clearing its shared cookie", async () => {
    const current = await app("legacy");
    const session = current.service.db.session();
    const job = insertJob(current.service, session.csrf, "legacy-owned-job");
    const value = signed(session.id, current.secret);
    const jar = await client(value);
    const response = await jar.get(current.origin + "/api/session");
    const migrated = (await response.json()) as SessionResponse;
    expect(migrated.csrfToken).toBe(session.csrf);
    expect(migrated.jobs.map((item) => item.id)).toEqual([job.id]);
    const cookies = (await jar.storageState()).cookies;
    expect(cookies.find((cookie) => cookie.name === "cua_session")?.value).toBe(
      value,
    );
    expect(
      cookies.find((cookie) => cookie.name.startsWith("cua_session_"))?.value,
    ).toBe(value);
    expect(
      (await (await jar.get(current.origin + "/api/session")).json()).csrfToken,
    ).toBe(session.csrf);
  });

  it("does not migrate a legacy cookie signed by a different app", async () => {
    const current = await app("target");
    const legacy = current.service.db.session();
    const jar = await client(
      signed(legacy.id, "test-only-another-app-secret-with-sufficient-length"),
    );
    const result = await (
      await jar.get(current.origin + "/api/session")
    ).json();
    expect(result.csrfToken).not.toBe(legacy.csrf);
    expect(
      (await jar.storageState()).cookies.some(
        (cookie) => cookie.name === "cua_session",
      ),
    ).toBe(true);
  });

  it("does not fall back to legacy when a namespaced cookie is present but invalid", async () => {
    const current = await app("precedence");
    const legacy = current.service.db.session();
    const jar = await client();
    await jar.get(current.origin + "/api/session");
    const cookie = (await jar.storageState()).cookies[0];
    const result = await (
      await jar.get(current.origin + "/api/session", {
        headers: {
          Cookie: `${cookie.name}=invalid; cua_session=${signed(legacy.id, current.secret)}`,
        },
      })
    ).json();
    expect(result.csrfToken).not.toBe(legacy.csrf);
  });
});
