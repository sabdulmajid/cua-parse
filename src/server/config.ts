import "dotenv/config";
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
const schema = z.object({
  VITE_PORT: z.coerce.number().int().min(1024).max(65535).default(5173),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  APP_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  APP_SESSION_SECRET: z.string().default(""),
  ELASTICSEARCH_URL: z.string().url().default("http://127.0.0.1:9200"),
  ELASTICSEARCH_API_KEY: z.string().optional(),
  ELASTICSEARCH_INDEX: z
    .string()
    .regex(/^cua-parse-[a-z0-9-]+$/)
    .default("cua-parse-evidence-v1"),
  ELASTIC_CLOUD_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  ELASTIC_CLOUD_KIBANA_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  ELASTIC_CLOUD_API_KEY: z.string().optional(),
  ELASTIC_CLOUD_INDEX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,150}$/)
    .default("youtube-product-comments"),
  ANALYSIS_MODE: z.enum(["openai", "unlabeled"]).default("unlabeled"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ANALYSIS_MODEL: z.string().default("gpt-4.1-mini"),
  RETRIEVAL_MODE: z.enum(["bm25", "hybrid"]).default("bm25"),
  OPENAI_EMBEDDING_MODEL: z
    .enum(["text-embedding-3-small"])
    .default("text-embedding-3-small"),
  OPENAI_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .min(256)
    .max(1536)
    .default(1536),
  VOICE_MODE: z.enum(["enabled", "disabled"]).default("disabled"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.enum(["eleven_flash_v2"]).default("eleven_flash_v2"),
  DATA_MODE: z.enum(["all", "fixture", "live", "import"]).default("all"),
  MAX_THREADS: z.coerce.number().int().min(1).max(10).default(10),
  MAX_ITEMS: z.coerce.number().int().min(1).max(150).default(150),
  COLLECTION_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  JOB_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(180000),
});
export type Config = z.infer<typeof schema> & { localDir: string };
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      "Invalid configuration variables: " +
        parsed.error.issues.map((x) => x.path.join(".")).join(", "),
    );
  const c = parsed.data;
  const appUrl = new URL(c.APP_BASE_URL);
  if (
    !["127.0.0.1", "localhost"].includes(appUrl.hostname) ||
    appUrl.protocol !== "http:" ||
    appUrl.username ||
    appUrl.password ||
    appUrl.search ||
    appUrl.hash ||
    appUrl.pathname !== "/"
  )
    throw new Error(
      "APP_BASE_URL must be a local HTTP origin. Public deployment is not enabled.",
    );
  const es = new URL(c.ELASTICSEARCH_URL);
  if (es.username || es.password || !["http:", "https:"].includes(es.protocol))
    throw new Error("Use ELASTICSEARCH_API_KEY for credentials.");
  if (
    es.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(es.hostname)
  )
    throw new Error("Remote Elasticsearch requires HTTPS.");
  for (const value of [c.ELASTIC_CLOUD_URL, c.ELASTIC_CLOUD_KIBANA_URL]) {
    if (!value) continue;
    const remote = new URL(value);
    if (
      remote.protocol !== "https:" ||
      remote.username ||
      remote.password ||
      remote.search ||
      remote.hash ||
      remote.pathname !== "/"
    )
      throw new Error(
        "Elastic Cloud URLs must be HTTPS origins without credentials.",
      );
  }
  if (c.ANALYSIS_MODE === "openai" && !c.OPENAI_API_KEY)
    throw new Error("ANALYSIS_MODE=openai requires OPENAI_API_KEY.");
  if (c.RETRIEVAL_MODE === "hybrid" && !c.OPENAI_API_KEY)
    throw new Error("RETRIEVAL_MODE=hybrid requires OPENAI_API_KEY.");
  const localDir = path.resolve(env.CUA_LOCAL_DIR || ".local");
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  if (!c.APP_SESSION_SECRET) {
    const p = path.join(localDir, "session-secret");
    if (!existsSync(p))
      writeFileSync(p, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    c.APP_SESSION_SECRET = readFileSync(p, "utf8").trim();
  }
  if (c.APP_SESSION_SECRET.length < 32)
    throw new Error("APP_SESSION_SECRET needs at least 32 characters.");
  if (!c.ELEVENLABS_AGENT_ID) {
    try {
      c.ELEVENLABS_AGENT_ID = JSON.parse(
        readFileSync(path.join(localDir, "voice-agent.json"), "utf8"),
      ).agentId;
    } catch {
      /* no configured agent */
    }
  }
  return { ...c, localDir };
}
