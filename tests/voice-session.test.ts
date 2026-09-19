import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { voiceSession, VoiceProviderError } from "../src/server/voice.js";
vi.mock("../src/server/voice.js", async (load) => ({
  ...(await load<typeof import("../src/server/voice.js")>()),
  voiceSession: vi.fn(),
}));
const port = Number(process.env.VOICE_API_TEST_PORT || 3097);
const origin = `http://127.0.0.1:${port}`;
let service: ReturnType<typeof createApp>, server: Server, dir: string;
type Session = { cookie: string; csrf: string };
let a: Session, b: Session;
async function session(cookie?: string) {
  const r = await fetch(origin + "/api/session", {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const body = await r.json();
  expect(r.status).toBe(200);
  return {
    cookie: r.headers.get("set-cookie")!.split(";")[0],
    csrf: body.csrfToken,
  };
}
async function post(
  s: Session,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(origin + route, {
    method: "POST",
    headers: {
      Cookie: s.cookie,
      "X-CSRF-Token": s.csrf,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cua-parse-voice-route-test-"));
  service = createApp(
    loadConfig({
      PORT: String(port),
      APP_BASE_URL: origin,
      CUA_LOCAL_DIR: dir,
      APP_SESSION_SECRET: "test-only-session-secret-no-provider-key",
      VOICE_MODE: "enabled",
      ELEVENLABS_API_KEY: "test-only-never-sent",
      ELEVENLABS_AGENT_ID: "test-agent",
    }),
  );
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
  if (dir) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(voiceSession).mockReset();
  vi.mocked(voiceSession).mockResolvedValue({
    signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?test=local-mock",
    conversationId: "conv-local-mock",
  });
});
describe("private conversation session route (mocked provider)", () => {
  it("validates text/voice mode before issuing credentials", async () => {
    expect(
      (await post(a, "/api/voice/session", { mode: "invalid" })).status,
    ).toBe(400);
    expect(voiceSession).not.toHaveBeenCalled();
    for (const mode of ["text", "voice"] as const) {
      const r = await post(a, "/api/voice/session", { mode });
      expect(r.status).toBe(200);
      expect(r.body.signedUrl).toMatch(/^wss:/);
      expect(r.body.leaseId).toBeTruthy();
      expect(voiceSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ ELEVENLABS_AGENT_ID: "test-agent" }),
        mode,
      );
    }
  });
  it("requires CSRF and an allowed origin before contacting ElevenLabs", async () => {
    expect(
      (
        await post(
          a,
          "/api/voice/session",
          { mode: "text" },
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          a,
          "/api/voice/session",
          { mode: "text" },
          { Origin: "https://invalid.example" },
        )
      ).status,
    ).toBe(403);
    expect(voiceSession).not.toHaveBeenCalled();
  });
  it("binds the returned provider conversation to its owner once", async () => {
    const r = await post(a, "/api/voice/session", { mode: "text" });
    const binding = {
      leaseId: r.body.leaseId,
      conversationId: "conv-local-mock",
    };
    expect((await post(b, "/api/voice/bind", binding)).status).toBe(403);
    expect(
      (
        await post(a, "/api/voice/bind", {
          ...binding,
          conversationId: "forged-conversation",
        })
      ).status,
    ).toBe(403);
    expect((await post(a, "/api/voice/bind", binding)).status).toBe(200);
    expect((await post(a, "/api/voice/bind", binding)).status).toBe(403);
  });
  it("returns an actionable safe provider error and suppresses unexpected error data", async () => {
    vi.mocked(voiceSession).mockRejectedValueOnce(
      new VoiceProviderError(
        "permission",
        "Enable Agents access on the local key.",
        403,
      ),
    );
    expect(await post(a, "/api/voice/session", { mode: "text" })).toEqual({
      status: 503,
      body: {
        category: "permission",
        error: "Enable Agents access on the local key.",
      },
    });
    vi.mocked(voiceSession).mockRejectedValueOnce(
      new Error("sensitive-provider-payload"),
    );
    const r = await post(a, "/api/voice/session", { mode: "text" });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("sensitive-provider-payload");
  });
  it("rejects malformed cookie signatures without a server error", async () => {
    await session("cua_session=invalid." + "é".repeat(64));
  });
});
