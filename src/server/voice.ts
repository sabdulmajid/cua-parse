import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { Config } from "./config.js";

export type VoiceErrorCategory =
  | "configuration"
  | "authentication"
  | "permission"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "provider";
export class VoiceProviderError extends Error {
  constructor(
    public readonly category: VoiceErrorCategory,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
/** Never pass a provider body, URL, request headers, or error.message to clients/logs. */
export function safeVoiceError(error: unknown): VoiceProviderError {
  if (error instanceof VoiceProviderError) return error;
  const raw = object(error);
  const body = object(raw.body);
  const detail = object(body.detail);
  const status =
    typeof raw.statusCode === "number" ? raw.statusCode : undefined;
  const code =
    typeof detail.status === "string"
      ? detail.status
      : typeof detail.code === "string"
        ? detail.code
        : "";
  if (
    [
      "quota_exceeded",
      "insufficient_credits",
      "payment_required",
      "subscription_required",
    ].includes(code) ||
    status === 402
  ) {
    return new VoiceProviderError(
      "quota",
      "ElevenLabs quota or subscription access is insufficient. Check the account limits; no plan change was made.",
      status,
    );
  }
  if (
    [
      "missing_permissions",
      "missing_permission",
      "insufficient_permissions",
    ].includes(code) ||
    status === 403
  ) {
    return new VoiceProviderError(
      "permission",
      "The ElevenLabs key lacks access to this agent or Agents tools. Enable the required Agents read/write permissions on the local key.",
      status,
    );
  }
  if (
    status === 401 ||
    ["invalid_api_key", "invalid_authorization_header"].includes(code)
  ) {
    return new VoiceProviderError(
      "authentication",
      "ElevenLabs rejected the API key. Configure a valid rotated ELEVENLABS_API_KEY locally.",
      status,
    );
  }
  if (status === 429)
    return new VoiceProviderError(
      "rate_limit",
      "ElevenLabs rate or concurrency limit reached. Wait before reconnecting.",
      status,
    );
  if (
    raw.name === "ElevenLabsTimeoutError" ||
    raw.name === "AbortError" ||
    raw.name === "TimeoutError"
  ) {
    return new VoiceProviderError(
      "timeout",
      "The ElevenLabs request timed out. No automatic resource-creation retry was made.",
      status,
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return new VoiceProviderError(
      "configuration",
      "ElevenLabs rejected the agent configuration or resource ID. Run npm run setup:voice and check the dedicated project agent.",
      status,
    );
  }
  return new VoiceProviderError(
    "provider",
    "The ElevenLabs request failed. Check provider availability and local configuration.",
    status,
  );
}

export async function voiceSession(
  config: Config,
  mode: "text" | "voice",
): Promise<{ signedUrl: string; conversationId?: string }> {
  if (
    config.VOICE_MODE !== "enabled" ||
    !config.ELEVENLABS_API_KEY ||
    !config.ELEVENLABS_AGENT_ID
  ) {
    throw new VoiceProviderError(
      "configuration",
      "Conversation is not configured. Set ELEVENLABS_API_KEY, run npm run setup:voice, and enable VOICE_MODE locally.",
    );
  }
  if (mode !== "text" && mode !== "voice")
    throw new VoiceProviderError(
      "configuration",
      "Choose text or voice conversation mode.",
    );
  try {
    const client = new ElevenLabsClient({ apiKey: config.ELEVENLABS_API_KEY });
    // Both modes use private WebSocket sessions. The allowed textOnly override
    // selects audio behavior in the browser, never a different authentication type.
    const result = await client.conversationalAi.conversations.getSignedUrl(
      { agentId: config.ELEVENLABS_AGENT_ID, includeConversationId: true },
      { timeoutInSeconds: 15, maxRetries: 0 },
    );
    const signed = new URL(result.signedUrl);
    if (
      signed.protocol !== "wss:" ||
      !(
        signed.hostname === "api.elevenlabs.io" ||
        signed.hostname.endsWith(".elevenlabs.io")
      ) ||
      signed.username ||
      signed.password ||
      signed.port ||
      signed.pathname !== "/v1/convai/conversation"
    ) {
      throw new VoiceProviderError(
        "provider",
        "ElevenLabs returned an invalid conversation endpoint.",
      );
    }
    const conversationId = signed.searchParams.get("conversation_id");
    if (conversationId && !/^[a-zA-Z0-9_-]{1,160}$/.test(conversationId))
      throw new VoiceProviderError(
        "provider",
        "ElevenLabs returned invalid conversation metadata.",
      );
    return {
      signedUrl: result.signedUrl,
      ...(conversationId ? { conversationId } : {}),
    };
  } catch (error) {
    throw safeVoiceError(error);
  }
}
