import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import {
  safeVoiceError,
  voiceSession,
  VoiceProviderError,
} from "../src/server/voice.js";
import type { Config } from "../src/server/config.js";
import { agentConfiguration, tools } from "../scripts/voice-config.js";
import { verifyAgentConfiguration } from "../scripts/setup-voice.js";

const mocks = vi.hoisted(() => ({ getSignedUrl: vi.fn() }));
vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: vi.fn(function () {
    return {
      conversationalAi: { conversations: { getSignedUrl: mocks.getSignedUrl } },
    };
  }),
}));
const config = {
  VOICE_MODE: "enabled",
  ELEVENLABS_API_KEY: "test-placeholder-key",
  ELEVENLABS_AGENT_ID: "agent_test_placeholder",
} as Config;
const signedUrl =
  "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test_placeholder&conversation_id=conv_test_placeholder&conversation_signature=test-placeholder";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSignedUrl.mockResolvedValue({ signedUrl });
});

describe("private ElevenLabs session issuance", () => {
  it.each(["text", "voice"] as const)(
    "uses a single-use signed WebSocket URL for %s",
    async (mode) => {
      const result = await voiceSession(config, mode);
      expect(result).toEqual({
        signedUrl,
        conversationId: "conv_test_placeholder",
      });
      expect(mocks.getSignedUrl).toHaveBeenCalledWith(
        { agentId: config.ELEVENLABS_AGENT_ID, includeConversationId: true },
        { timeoutInSeconds: 15, maxRetries: 0 },
      );
      expect(result).not.toHaveProperty("token");
      expect(result).not.toHaveProperty("apiKey");
    },
  );
  it("blocks missing configuration before calling a provider", async () => {
    await expect(
      voiceSession({ ...config, VOICE_MODE: "disabled" }, "text"),
    ).rejects.toMatchObject({ category: "configuration" });
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });
  it("handles providers that do not expose a conversation ID in the URL", async () => {
    mocks.getSignedUrl.mockResolvedValue({
      signedUrl:
        "wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=test-placeholder",
    });
    expect(await voiceSession(config, "text")).not.toHaveProperty(
      "conversationId",
    );
  });
  it("rejects an unexpected endpoint without exposing its URL", async () => {
    mocks.getSignedUrl.mockResolvedValue({
      signedUrl: "wss://attacker.example/secret-test-value",
    });
    await expect(voiceSession(config, "text")).rejects.toMatchObject({
      category: "provider",
      message: "ElevenLabs returned an invalid conversation endpoint.",
    });
  });
  it("returns only fixed safe error details when authentication fails", async () => {
    mocks.getSignedUrl.mockRejectedValue({
      statusCode: 401,
      message: "secret-test-value",
      body: {
        detail: { status: "invalid_api_key", message: "secret-test-value" },
      },
    });
    try {
      await voiceSession(config, "text");
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceProviderError);
      expect(error).toMatchObject({
        category: "authentication",
        statusCode: 401,
      });
      expect(String(error)).not.toContain("secret-test-value");
      expect(JSON.stringify(error)).not.toContain("secret-test-value");
    }
  });
  it.each([
    [403, "", "permission"],
    [401, "missing_permissions", "permission"],
    [402, "", "quota"],
    [400, "quota_exceeded", "quota"],
    [429, "", "rate_limit"],
    [422, "", "configuration"],
    [503, "", "provider"],
  ])(
    "classifies HTTP %s and safe provider code",
    (statusCode, code, category) => {
      const error = safeVoiceError({
        statusCode,
        body: { detail: { status: code, message: "private raw body" } },
      });
      expect(error.category).toBe(category);
      expect(error.message).not.toContain("private raw body");
    },
  );
});

describe("project agent configuration", () => {
  const ids = tools.map((_t, i) => `tool_test_${i}`);
  const request = agentConfiguration(
    { ELEVENLABS_MODEL_ID: "eleven_flash_v2" },
    ids,
  );
  const toolResponses = tools.map((tool, i) => ({
    ...tool,
    id: ids[i],
  })) as ElevenLabs.ToolResponseModel[];
  const agent = {
    ...request,
    agentId: "agent_test_placeholder",
  } as ElevenLabs.GetAgentResponseModel;
  it("permits only the required text-only override and enables response/client-tool events", () => {
    expect(request.platformSettings?.auth?.enableAuth).toBe(true);
    expect(request.platformSettings?.overrides).toEqual({
      conversationConfigOverride: { conversation: { textOnly: true } },
    });
    expect(request.conversationConfig.conversation?.clientEvents).toEqual(
      expect.arrayContaining(["agent_response", "client_tool_call"]),
    );
    expect(() =>
      verifyAgentConfiguration(agent, toolResponses, ids),
    ).not.toThrow();
  });
  it("requires all four client tools to wait for the result", () => {
    expect(tools).toHaveLength(4);
    const broken = structuredClone(toolResponses);
    if (broken[0].toolConfig.type === "client")
      broken[0].toolConfig.expectsResponse = false;
    expect(() => verifyAgentConfiguration(agent, broken, ids)).toThrow(
      "does not wait",
    );
  });
  it("rejects an agent that denies runtime text-only overrides", () => {
    const broken = structuredClone(agent);
    broken.platformSettings!.overrides = {};
    expect(() => verifyAgentConfiguration(broken, toolResponses, ids)).toThrow(
      "allow text-only",
    );
  });
  it("extracts product/question, defaults live, and does not invent findings", () => {
    const prompt = request.conversationConfig.agent?.prompt?.prompt;
    expect(prompt).toContain("Extract product=Linear");
    expect(prompt).toContain("Use live by default");
    expect(prompt).toContain("query_feedback before stating");
  });
});
