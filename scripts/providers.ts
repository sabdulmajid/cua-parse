import { loadConfig } from "../src/server/config.js";
import { EvidenceStore } from "../src/server/elastic.js";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { ProviderStatus } from "../src/shared/contracts.js";
const c = loadConfig();
const evidence = new EvidenceStore({
  url: c.ELASTICSEARCH_URL,
  apiKey: c.ELASTICSEARCH_API_KEY || undefined,
  index: c.ELASTICSEARCH_INDEX,
  ...(c.RETRIEVAL_MODE === "hybrid"
    ? {
        embedding: {
          apiKey: c.OPENAI_API_KEY!,
          model: c.OPENAI_EMBEDDING_MODEL,
          dimensions: c.OPENAI_EMBEDDING_DIMENSIONS,
        },
      }
    : {}),
});
const providers: Record<string, ProviderStatus> = {
  elasticsearch: await evidence.probe(),
  elevenlabs: {
    status: c.VOICE_MODE === "disabled" ? "disabled" : "missing",
    detail: "A real conversation tool turn is required for verification.",
  },
  openai: {
    status: c.OPENAI_API_KEY ? "configured-but-unverified" : "missing",
    detail: `Analysis mode: ${c.ANALYSIS_MODE}. No model request made by this check.`,
  },
  hackernews: {
    status: "configured-but-unverified",
    detail:
      "Public API configured. Start a bounded live research job to verify.",
  },
  browserbase: { status: "disabled", detail: "Not implemented in P0." },
  reddit: { status: "disabled", detail: "Approved API access required." },
};
if (c.ELEVENLABS_API_KEY && c.ELEVENLABS_AGENT_ID) {
  try {
    const client = new ElevenLabsClient({ apiKey: c.ELEVENLABS_API_KEY });
    await client.conversationalAi.agents.get(
      c.ELEVENLABS_AGENT_ID,
      {},
      { timeoutInSeconds: 10, maxRetries: 0 },
    );
    providers.elevenlabs = {
      status: "configured-but-unverified",
      detail:
        "Agent API read passed. A real conversation tool turn is still required.",
    };
  } catch {
    providers.elevenlabs = {
      status: "failed",
      detail: "Agent API read failed. Check rotated key and agent ID.",
    };
  }
}
console.log(JSON.stringify(providers, null, 2));
await evidence.close();
