import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@elastic/elasticsearch";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { filtersSchema } from "../src/shared/contracts.js";
const analyze = process.argv.includes("--analyze");
const index = "cua-parse-live-smoke-" + randomUUID();
const dir = mkdtempSync(path.resolve(".local/live-smoke-"));
const base = "http://127.0.0.1:3101";
const c = loadConfig({
  PORT: "3101",
  APP_BASE_URL: base,
  APP_SESSION_SECRET: "live-smoke-local-session-secret-only",
  CUA_LOCAL_DIR: dir,
  ELASTICSEARCH_INDEX: index,
  ELASTICSEARCH_URL: process.env.ELASTICSEARCH_URL || "http://127.0.0.1:9200",
  MAX_THREADS: "2",
  MAX_ITEMS: "4",
  COLLECTION_CONCURRENCY: "1",
  JOB_TIMEOUT_MS: "90000",
  ANALYSIS_MODE: analyze ? "openai" : "unlabeled",
  ...(analyze
    ? {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_ANALYSIS_MODEL: process.env.OPENAI_ANALYSIS_MODEL,
      }
    : {}),
  VOICE_MODE: "disabled",
});
const service = createApp(c);
const server = service.app.listen(c.PORT, "127.0.0.1");
try {
  const r = await fetch(base + "/api/session");
  const initial = await r.json();
  const headers = {
    "Content-Type": "application/json",
    Cookie: r.headers.get("set-cookie")!.split(";")[0],
    "X-CSRF-Token": initial.csrfToken,
  };
  const call = async (tool: string, body: unknown) => {
    const response = await fetch(base + "/api/tools/" + tool, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const { job } = await call("start_research", {
    product: "Dropbox",
    question: "What feedback do people share about Dropbox pricing?",
    mode: "live",
    idempotencyKey: "bounded-live-smoke",
  });
  let state;
  const end = Date.now() + 95000;
  while (Date.now() < end) {
    state = (await call("get_research_status", { researchId: job.id })).job;
    if (["ready", "failed", "cancelled"].includes(state.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (state?.state !== "ready")
    throw new Error("Live research did not become ready");
  const { packet } = await call("query_feedback", {
    researchId: job.id,
    question: "Dropbox pricing",
    filters: filtersSchema.parse({}),
    requestId: randomUUID(),
    challenge: false,
  });
  const report = {
    status:
      packet.evidence.length > 0 && (!analyze || state.analyzed > 0)
        ? "PASS"
        : "FAIL",
    observedAt: new Date().toISOString(),
    mode: `live-source / ${analyze ? "real-OpenAI-analysis" : "unlabeled-analysis"} / real-Elasticsearch / HTTP-tools`,
    analyzed: state.analyzed,
    failures: state.failures.length,
    collected: state.collected,
    indexed: state.indexed,
    threads: packet.metrics.distinctThreads,
    relevant: packet.metrics.relevantRecords,
    examples: packet.evidence.length,
    provenance: packet.provenance,
    originalLinks: packet.evidence.map((x: { url: string }) => x.url),
    limitation: analyze
      ? "No live embeddings or ElevenLabs conversation ran in this source smoke."
      : "No OpenAI analysis, embeddings or ElevenLabs conversation ran.",
  };
  writeFileSync(
    analyze
      ? ".local/live-analysis-smoke.json"
      : ".local/live-source-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
} catch {
  console.error(
    "FAIL: bounded live-source integration. Check provider/source availability.",
  );
  process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await service.close();
  const es = new Client({ node: c.ELASTICSEARCH_URL });
  if (await es.indices.exists({ index })) await es.indices.delete({ index });
  await es.close();
  rmSync(dir, { recursive: true, force: true });
}
