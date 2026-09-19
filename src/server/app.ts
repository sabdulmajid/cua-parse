import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { LocalStore } from "./storage.js";
import { EvidenceStore } from "./elastic.js";
import { ElasticCloud, ElasticCloudError } from "./elastic-cloud.js";
import { JobRunner } from "./jobs.js";
import {
  elasticQuerySchema,
  startSchema,
  querySchema,
  type ProviderStatus,
} from "../shared/contracts.js";
import { makeBrief } from "./brief.js";
import { voiceSession, VoiceProviderError } from "./voice.js";
export function createApp(config: Config) {
  const db = new LocalStore(path.join(config.localDir, "app.db"));
  const evidence = new EvidenceStore({
    url: config.ELASTICSEARCH_URL,
    apiKey: config.ELASTICSEARCH_API_KEY || undefined,
    index: config.ELASTICSEARCH_INDEX,
    ...(config.RETRIEVAL_MODE === "hybrid"
      ? {
          embedding: {
            apiKey: config.OPENAI_API_KEY!,
            model: config.OPENAI_EMBEDDING_MODEL,
            dimensions: config.OPENAI_EMBEDDING_DIMENSIONS,
          },
        }
      : {}),
  });
  const providers: Record<string, ProviderStatus> = {
    elasticsearch: {
      status: "configured-but-unverified",
      detail: "Run setup or start research to check the cluster.",
    },
    openai: {
      status: config.OPENAI_API_KEY ? "configured-but-unverified" : "missing",
      detail:
        config.ANALYSIS_MODE === "openai"
          ? "Structured analysis enabled."
          : "Live/import text is stored without model labels. Fixture labels are synthetic.",
    },
    elevenlabs: {
      status:
        config.VOICE_MODE === "disabled"
          ? "disabled"
          : config.ELEVENLABS_API_KEY && config.ELEVENLABS_AGENT_ID
            ? "configured-but-unverified"
            : "missing",
      detail:
        "Private agent configured. Text and voice connect in the browser.",
    },
    hackernews: {
      status: "configured-but-unverified",
      detail:
        "Bounded public API discovery. HN users are not verified customers.",
    },
    browserbase: { status: "disabled", detail: "P1 adapter not enabled." },
    reddit: { status: "disabled", detail: "Requires approved API access." },
    semantic: {
      status:
        config.RETRIEVAL_MODE === "hybrid"
          ? "configured-but-unverified"
          : "disabled",
      detail:
        config.RETRIEVAL_MODE === "hybrid"
          ? "OpenAI vectors plus keyword retrieval."
          : "BM25 keyword retrieval; no semantic claim.",
    },
  };
  const cloud =
    config.ELASTIC_CLOUD_URL &&
    config.ELASTIC_CLOUD_KIBANA_URL &&
    config.ELASTIC_CLOUD_API_KEY
      ? new ElasticCloud({
          url: config.ELASTIC_CLOUD_URL,
          kibanaUrl: config.ELASTIC_CLOUD_KIBANA_URL,
          apiKey: config.ELASTIC_CLOUD_API_KEY,
          index: config.ELASTIC_CLOUD_INDEX,
        })
      : null;
  providers.elasticAgent = {
    status: cloud ? "configured-but-unverified" : "disabled",
    detail: cloud
      ? "Uploaded YouTube comments with Elastic Agent Builder."
      : "Elastic Cloud source is not configured.",
  };
  const runner = new JobRunner(db, evidence, config, providers);
  const app = express();
  app.disable("x-powered-by");
  const origins = new Set([
    config.APP_BASE_URL,
    `http://127.0.0.1:${config.VITE_PORT}`,
    `http://localhost:${config.VITE_PORT}`,
    `http://localhost:${config.PORT}`,
  ]);
  const hosts = new Set([...origins].map((x) => new URL(x).host));
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
    });
    if (!hosts.has(req.headers.host || "")) {
      res.status(403).json({ error: "Invalid host." });
      return;
    }
    if (req.headers.origin && !origins.has(req.headers.origin)) {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "3mb" }));
  const mac = (id: string) =>
    createHmac("sha256", config.APP_SESSION_SECRET).update(id).digest("hex");
  app.use("/api", (req, res, next) => {
    const signed = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("cua_session="))
      ?.slice(12);
    let id: string | undefined;
    if (signed) {
      const [candidate, sig] = signed.split(".");
      const expected = mac(candidate || "");
      if (
        !!sig &&
        /^[a-f0-9]{64}$/.test(sig) &&
        timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      )
        id = candidate;
    }
    const session = db.session(id);
    res.locals.session = session;
    if (session.id !== id)
      res.cookie("cua_session", `${session.id}.${mac(session.id)}`, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 86400000,
        path: "/",
      });
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.get("X-CSRF-Token") !== session.csrf) {
        res.status(403).json({ error: "Invalid session request token." });
        return;
      }
      const cid = req.get("X-Conversation-Id");
      if (cid && !db.ownsConversation(session.id, cid)) {
        res
          .status(403)
          .json({ error: "Conversation does not belong to this session." });
        return;
      }
    }
    next();
  });
  const windows = new Map<string, { count: number; reset: number }>();
  app.use("/api", (req, res, next) => {
    const id = res.locals.session.id as string;
    let w = windows.get(id);
    if (!w || w.reset < Date.now()) {
      w = { count: 0, reset: Date.now() + 60000 };
      windows.set(id, w);
    }
    if (++w.count > 240) {
      res.status(429).json({ error: "Too many requests. Wait one minute." });
      return;
    }
    if (windows.size > 5000)
      for (const [key, value] of windows)
        if (value.reset < Date.now()) windows.delete(key);
    next();
  });
  app.get("/api/session", (_req, res) =>
    res.json({
      csrfToken: res.locals.session.csrf,
      elasticAgentAvailable: !!cloud,
      providers,
      jobs: db.listJobs(res.locals.session.id),
      voiceAvailable:
        config.VOICE_MODE === "enabled" &&
        !!config.ELEVENLABS_API_KEY &&
        !!config.ELEVENLABS_AGENT_ID,
    }),
  );
  // One active request per local session; a single private corpus is configured by the owner.
  const cloudActive = new Set<string>();
  const cloudRequests = new Map<
    string,
    {
      fingerprint: string;
      result: import("../shared/contracts.js").ElasticAnswer;
      expires: number;
    }
  >();
  let cloudWindow = { count: 0, reset: Date.now() + 3600000 };
  app.post("/api/elastic/query", async (req, res) => {
    const input = elasticQuerySchema.parse(req.body);
    if (
      input.scope.from &&
      input.scope.to &&
      Date.parse(input.scope.from) > Date.parse(input.scope.to)
    ) {
      res.status(400).json({ error: "Start date must precede end date." });
      return;
    }
    for (const key of ["from", "to"] as const) {
      const value = input.scope[key];
      if (value) input.scope[key] = new Date(value).toISOString();
    }
    if (!cloud) {
      res.status(503).json({ error: "Elastic Cloud is not configured." });
      return;
    }
    const session = res.locals.session.id as string;
    const key = session + ":" + input.requestId;
    const fingerprint = JSON.stringify(input);
    const saved = cloudRequests.get(key);
    if (saved && saved.expires > Date.now()) {
      if (saved.fingerprint !== fingerprint) {
        res.status(409).json({
          error: "This request ID was already used for a different question.",
        });
        return;
      }
      res.json(saved.result);
      return;
    }
    if (cloudActive.has(session) || cloudActive.size >= 2) {
      res.status(409).json({
        error: "Elastic is still answering. Wait for the current question.",
      });
      return;
    }
    if (cloudWindow.reset < Date.now())
      cloudWindow = { count: 0, reset: Date.now() + 3600000 };
    if (cloudWindow.count >= 30) {
      res.status(429).json({
        error:
          "The local limit of 30 Elastic questions per hour has been reached.",
      });
      return;
    }
    cloudWindow.count++;
    cloudActive.add(session);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 155000);
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const result = await cloud.query(input, controller.signal);
      providers.elasticAgent = {
        status: "verified",
        detail:
          "Elastic queries and Agent Builder answered from the uploaded corpus.",
      };
      for (const [id, entry] of cloudRequests)
        if (entry.expires < Date.now()) cloudRequests.delete(id);
      if (cloudRequests.size >= 100)
        cloudRequests.delete(cloudRequests.keys().next().value!);
      cloudRequests.set(key, {
        fingerprint,
        result,
        expires: Date.now() + 1800000,
      });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      const detail =
        error instanceof ElasticCloudError
          ? error.message
          : "Elastic could not complete this question. Try again shortly.";
      providers.elasticAgent = { status: "failed", detail };
      if (!res.destroyed) res.status(503).json({ error: detail });
    } finally {
      clearTimeout(timer);
      cloudActive.delete(session);
    }
  });
  app.get("/api/health", async (_req, res) => {
    try {
      await evidence.init();
      providers.elasticsearch = {
        status: "verified",
        detail: "Cluster and index mapping verified.",
      };
    } catch {
      providers.elasticsearch = {
        status: "failed",
        detail:
          "Elasticsearch unavailable or index mapping incompatible. Run npm run setup.",
      };
    }
    res.json({ ok: providers.elasticsearch.status === "verified", providers });
  });
  const idSchema = z.object({ researchId: z.string().uuid() }).strict();
  const getOwned = (session: string, id: string) => {
    const job = db.findJob(session, id);
    if (!job)
      throw Object.assign(new Error("Research was not found."), {
        status: 404,
      });
    return job;
  };
  app.post("/api/tools/start_research", (req, res) => {
    const input = startSchema.parse(req.body);
    if (config.DATA_MODE !== "all" && input.mode !== config.DATA_MODE)
      throw Object.assign(new Error("This data mode is disabled."), {
        status: 400,
      });
    if (input.mode !== "import" && input.records)
      throw Object.assign(
        new Error("Records are accepted only in import mode."),
        { status: 400 },
      );
    if (input.mode === "import" && !input.records)
      throw Object.assign(new Error("Import records are required."), {
        status: 400,
      });
    if (input.mode === "fixture" && input.product.toLowerCase() !== "acmeflow")
      throw Object.assign(
        new Error(
          "The synthetic fixture models AcmeFlow. Choose live or import for another product.",
        ),
        { status: 400 },
      );
    res.status(202).json({ job: runner.submit(res.locals.session.id, input) });
  });
  app.post("/api/tools/get_research_status", (req, res) =>
    res.json({
      job: getOwned(res.locals.session.id, idSchema.parse(req.body).researchId),
    }),
  );
  for (const name of ["query_feedback", "prepare_decision_brief"])
    app.post("/api/tools/" + name, async (req, res) => {
      const input = querySchema.parse(req.body);
      if (
        input.filters.from &&
        input.filters.to &&
        Date.parse(input.filters.from) > Date.parse(input.filters.to)
      )
        throw Object.assign(new Error("Start date must precede end date."), {
          status: 400,
        });
      const session = res.locals.session.id as string;
      const job = getOwned(session, input.researchId);
      if (job.state !== "ready")
        throw Object.assign(new Error("Research is not ready."), {
          status: 409,
        });
      const sequence = db.nextQuery(session, job.id);
      const packet = await evidence.query(session, job, input);
      if (!db.savePacket(session, packet, sequence)) {
        res
          .status(409)
          .json({ error: "A newer scope request replaced this result." });
        return;
      }
      if (name === "prepare_decision_brief") {
        const brief = makeBrief(packet, job.product);
        db.saveBrief(session, brief);
        res.json({ brief });
      } else res.json({ packet });
    });
  app.post("/api/research/:id/cancel", (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    getOwned(res.locals.session.id, id);
    res.json({ job: runner.cancel(res.locals.session.id, id) });
  });
  app.post("/api/voice/session", async (req, res) => {
    const { mode } = z
      .object({ mode: z.enum(["text", "voice"]) })
      .strict()
      .parse(req.body);
    try {
      const result = await voiceSession(config, mode);
      providers.elevenlabs = {
        status: "configured-but-unverified",
        detail:
          "Private session authorized. Conversation turns run in the browser.",
      };
      res.json({
        signedUrl: result.signedUrl,
        leaseId: db.lease(res.locals.session.id, result.conversationId),
      });
    } catch (error) {
      const safe = error instanceof VoiceProviderError ? error : null;
      const detail =
        safe?.message || "The agent connection failed. Try again shortly.";
      providers.elevenlabs = {
        status: config.ELEVENLABS_API_KEY ? "failed" : "missing",
        detail,
      };
      res
        .status(503)
        .json({ error: detail, category: safe?.category || "connection" });
    }
  });
  app.post("/api/voice/bind", (req, res) => {
    const input = z
      .object({
        leaseId: z.string().uuid(),
        conversationId: z.string().min(1).max(160),
      })
      .strict()
      .parse(req.body);
    if (!db.bind(res.locals.session.id, input.leaseId, input.conversationId)) {
      res
        .status(403)
        .json({ error: "Voice session lease is invalid or expired." });
      return;
    }
    res.json({ ok: true });
  });
  if (existsSync(path.resolve("dist/index.html"))) {
    app.use(express.static("dist"));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.resolve("dist/index.html")),
    );
  }
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error:
            "Invalid request fields: " +
            err.issues.map((x) => x.path.join(".")).join(", "),
        });
        return;
      }
      const status = (err as { status?: number })?.status;
      res.status(status && status >= 400 && status < 500 ? status : 500).json({
        error:
          status && status < 500
            ? (err as Error).message
            : "Operation failed. Check research status and provider setup.",
      });
    },
  );
  return {
    app,
    db,
    evidence,
    runner,
    providers,
    close: async () => {
      await runner.stop();
      await cloud?.close();
      await evidence.close();
      db.close();
    },
  };
}
