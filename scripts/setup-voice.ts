import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { safeVoiceError, VoiceProviderError } from "../src/server/voice.js";
import {
  AGENT_OWNER,
  agentConfiguration,
  tools,
  prompt,
} from "./voice-config.js";

type SavedAgent = {
  owner: typeof AGENT_OWNER;
  agentId?: string;
  toolIds: string[];
  pendingCreation?: string;
  verifiedAt?: string;
};
const options = { timeoutInSeconds: 20, maxRetries: 0 };

export function verifyAgentConfiguration(
  agent: ElevenLabs.GetAgentResponseModel,
  toolResponses: ElevenLabs.ToolResponseModel[],
  toolIds: string[],
): void {
  const platform = agent.platformSettings;
  const conversation = agent.conversationConfig.conversation;
  const p = agent.conversationConfig.agent?.prompt;
  if (
    !platform?.auth?.enableAuth ||
    !platform.overrides?.conversationConfigOverride?.conversation?.textOnly ||
    conversation?.textOnly ||
    !conversation?.clientEvents?.includes("agent_response") ||
    !conversation.clientEvents.includes("client_tool_call")
  ) {
    throw new VoiceProviderError(
      "configuration",
      "The project agent must be private and allow text-only overrides, agent responses, and client tools.",
    );
  }
  if (
    p?.prompt !== prompt ||
    p.llm !== "gpt-4.1-mini" ||
    p.toolIds?.length !== tools.length ||
    !toolIds.every((id) => p.toolIds?.includes(id))
  ) {
    throw new VoiceProviderError(
      "configuration",
      "The project agent prompt or registered tools differ from this application.",
    );
  }
  for (const expected of tools) {
    const actual = toolResponses.find(
      (t) =>
        t.toolConfig.type === "client" &&
        t.toolConfig.name === expected.toolConfig.name,
    )?.toolConfig;
    if (
      actual?.type !== "client" ||
      !actual.expectsResponse ||
      actual.responseTimeoutSecs !== expected.toolConfig.responseTimeoutSecs
    ) {
      throw new VoiceProviderError(
        "configuration",
        "A project tool is missing or does not wait for its response.",
      );
    }
    const expectedProperties =
      expected.toolConfig.type === "client"
        ? (expected.toolConfig.parameters?.properties ?? {})
        : {};
    const actualProperties = actual.parameters?.properties ?? {};
    if (
      Object.entries(expectedProperties).some(
        ([name, value]) => actualProperties[name]?.type !== value.type,
      )
    ) {
      throw new VoiceProviderError(
        "configuration",
        "A project tool parameter schema differs from this application.",
      );
    }
  }
}

export async function setupVoice(): Promise<void> {
  const config = loadConfig();
  if (!config.ELEVENLABS_API_KEY)
    throw new VoiceProviderError(
      "configuration",
      "Set a rotated ELEVENLABS_API_KEY in the local environment. Do not paste it into chat.",
    );
  const file = path.join(config.localDir, "voice-agent.json");
  const saved: SavedAgent = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as SavedAgent)
    : { owner: AGENT_OWNER, toolIds: [] };
  if (
    saved.owner !== AGENT_OWNER ||
    !Array.isArray(saved.toolIds) ||
    saved.toolIds.some((id) => typeof id !== "string") ||
    saved.toolIds.length > tools.length
  ) {
    throw new VoiceProviderError(
      "configuration",
      "The saved resource file does not identify this project's owned agent/tools. No cloud resource was changed.",
    );
  }
  if (
    config.ELEVENLABS_AGENT_ID &&
    config.ELEVENLABS_AGENT_ID !== saved.agentId
  ) {
    throw new VoiceProviderError(
      "configuration",
      "The configured agent is not owned by this project. No unrelated agent was changed.",
    );
  }
  if (saved.pendingCreation)
    throw new VoiceProviderError(
      "configuration",
      "A previous resource creation has an uncertain result. Inspect the dedicated project resources before retrying; no duplicate was created.",
    );
  const save = () => {
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  };
  const createOnce = async <T>(
    kind: string,
    create: () => Promise<T>,
  ): Promise<T> => {
    saved.pendingCreation = kind;
    save();
    try {
      const value = await create();
      delete saved.pendingCreation;
      return value;
    } catch (error) {
      const safe = safeVoiceError(error);
      // Only setup validation messages are inspected. Never print headers, full
      // provider errors, URLs, or credentials. No research data is sent here.
      if (safe.statusCode === 400 || safe.statusCode === 422) {
        const body = (error as { body?: { detail?: unknown } }).body;
        const detail = body?.detail;
        const message =
          typeof detail === "string"
            ? detail
            : detail &&
                typeof detail === "object" &&
                "message" in detail &&
                typeof detail.message === "string"
              ? detail.message
              : "";
        if (message) {
          let hint = message;
          for (const [name, value] of Object.entries(config))
            if (
              /key|secret|token/i.test(name) &&
              typeof value === "string" &&
              value
            )
              hint = hint.split(value).join("[redacted]");
          hint = hint.replace(/(?:wss?|https?):\/\/[^\s]+/gi, "[redacted URL]");
          console.error(`Provider configuration hint: ${hint.slice(0, 300)}`);
        }
      }
      if (
        safe.statusCode &&
        safe.statusCode >= 400 &&
        safe.statusCode < 500 &&
        safe.statusCode !== 408
      ) {
        delete saved.pendingCreation;
        save();
      }
      throw safe;
    }
  };
  const client = new ElevenLabsClient({ apiKey: config.ELEVENLABS_API_KEY });
  for (let i = 0; i < tools.length; i++) {
    const id = saved.toolIds[i];
    if (id) {
      const existing = await client.conversationalAi.tools.get(id, {}, options);
      if (
        existing.toolConfig.type !== "client" ||
        existing.toolConfig.name !== tools[i].toolConfig.name
      )
        throw new VoiceProviderError(
          "configuration",
          "A saved tool is not the expected project tool. No unrelated tool was changed.",
        );
      await client.conversationalAi.tools.update(id, tools[i], options);
    } else {
      const created = await createOnce(`tool:${tools[i].toolConfig.name}`, () =>
        client.conversationalAi.tools.create(tools[i], options),
      );
      saved.toolIds.push(created.id);
      save();
    }
  }
  const desired = agentConfiguration(config, saved.toolIds);
  if (saved.agentId) {
    const existing = await client.conversationalAi.agents.get(
      saved.agentId,
      {},
      options,
    );
    if (!existing.tags?.includes(AGENT_OWNER))
      throw new VoiceProviderError(
        "configuration",
        "The saved agent lacks this project's ownership tag. No unrelated agent was changed.",
      );
    await client.conversationalAi.agents.update(
      saved.agentId,
      desired,
      options,
    );
  } else {
    const created = await createOnce("agent", () =>
      client.conversationalAi.agents.create(desired, options),
    );
    saved.agentId = created.agentId;
    save();
  }
  const agent = await client.conversationalAi.agents.get(
    saved.agentId,
    {},
    options,
  );
  const toolResponses = await Promise.all(
    saved.toolIds.map((id) =>
      client.conversationalAi.tools.get(id, {}, options),
    ),
  );
  verifyAgentConfiguration(agent, toolResponses, saved.toolIds);
  saved.verifiedAt = new Date().toISOString();
  save();
  const receipt = {
    checkedAt: saved.verifiedAt,
    provider: "ElevenLabs",
    sdkVersion: "2.68.0",
    privateAgent: agent.platformSettings?.auth?.enableAuth === true,
    authentication: "single-use signed WebSocket URL",
    textOnlyOverrideAllowed:
      agent.platformSettings?.overrides?.conversationConfigOverride
        ?.conversation?.textOnly === true,
    voiceModeDefault: agent.conversationConfig.conversation?.textOnly === false,
    responseEvents: agent.conversationConfig.conversation?.clientEvents?.filter(
      (event) => ["agent_response", "client_tool_call"].includes(event),
    ),
    toolCount: toolResponses.length,
    tools: toolResponses.map((tool) => ({
      name:
        tool.toolConfig.type === "client" ? tool.toolConfig.name : "unexpected",
      type: tool.toolConfig.type,
      waitsForResponse:
        tool.toolConfig.type === "client" &&
        tool.toolConfig.expectsResponse === true,
      timeoutSeconds:
        tool.toolConfig.type === "client"
          ? tool.toolConfig.responseTimeoutSecs
          : null,
    })),
    limits: {
      concurrentConversations:
        agent.platformSettings?.callLimits?.agentConcurrencyLimit,
      dailyConversations: agent.platformSettings?.callLimits?.dailyLimit,
      burstingEnabled: agent.platformSettings?.callLimits?.burstingEnabled,
      conversationSeconds:
        agent.conversationConfig.conversation?.maxDurationSeconds,
    },
    language: agent.conversationConfig.agent?.language,
    llm: agent.conversationConfig.agent?.prompt?.llm,
    ttsModel: agent.conversationConfig.tts?.modelId,
    defaultVoiceConfigured: Boolean(agent.conversationConfig.tts?.voiceId),
    audioRecordingEnabled: agent.platformSettings?.privacy?.recordVoice,
    retentionDays: agent.platformSettings?.privacy?.retentionDays,
    conversationToolTurn: "NOT RUN by setup; verify in the app",
  };
  writeFileSync(
    path.join(config.localDir, "voice-setup-check.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "PASS: Dedicated private agent and four response-waiting client tools configured and read back. Text and voice use signed WebSocket sessions. Project resource IDs are saved locally. A real conversation tool turn is still required.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  setupVoice().catch((error) => {
    const safe = safeVoiceError(error);
    console.error(
      `Voice setup failed [${safe.category}${safe.statusCode ? `; HTTP ${safe.statusCode}` : ""}]: ${safe.message}`,
    );
    process.exitCode = 1;
  });
}
