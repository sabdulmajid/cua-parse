/** Worker tests use mocked collection, analysis and Elasticsearch. SQLite is real and local. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import type { EvidenceStore } from "../src/server/elastic.js";
import { JobRunner } from "../src/server/jobs.js";
import { LocalStore } from "../src/server/storage.js";
import type {
  AnalysisOptions,
  CollectionOptions,
  EvidencePacket,
  EvidenceRecord,
  JobState,
  ProviderStatus,
  RawRecord,
  ResearchJob,
  StartInput,
} from "../src/shared/contracts.js";

const mocks = vi.hoisted(() => ({ collect: vi.fn(), analyze: vi.fn() }));
vi.mock("../src/server/collection.js", () => ({ collect: mocks.collect }));
vi.mock("../src/server/analysis.js", () => ({ analyze: mocks.analyze }));
vi.mock("../src/server/elastic.js", () => ({ EvidenceStore: class {} }));
const stores: LocalStore[] = [];
const runners: JobRunner[] = [];
const directories: string[] = [];
const testInput = (key = "mock-job-0001"): StartInput => ({
  product: "AcmeFlow",
  question: "What is the pricing feedback?",
  mode: "live",
  idempotencyKey: key,
});
const raw: RawRecord = {
  id: "hn:123",
  text: "AcmeFlow pricing is fair.",
  url: "https://news.ycombinator.com/item?id=123",
  threadId: "hn:100",
  threadTitle: "AcmeFlow feedback",
  parentId: null,
  publishedAt: null,
  collectedAt: "2026-09-19T12:00:00.000Z",
  source: "hackernews",
  provenance: "live",
};
const defaultConfig: Config = {
  PORT: 3000,
  VITE_PORT: 5173,
  APP_BASE_URL: "http://127.0.0.1:3000",
  APP_SESSION_SECRET: "test-session-secret-at-least-32-characters",
  ELASTICSEARCH_URL: "http://127.0.0.1:9200",
  ELASTICSEARCH_INDEX: "cua-parse-mock-worker",
  ELASTIC_CLOUD_INDEX: "youtube-product-comments",
  ANALYSIS_MODE: "unlabeled",
  OPENAI_ANALYSIS_MODEL: "mock-model",
  RETRIEVAL_MODE: "bm25",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  OPENAI_EMBEDDING_DIMENSIONS: 1536,
  VOICE_MODE: "disabled",
  ELEVENLABS_MODEL_ID: "eleven_flash_v2",
  DATA_MODE: "all",
  MAX_THREADS: 3,
  MAX_ITEMS: 5,
  COLLECTION_CONCURRENCY: 1,
  JOB_TIMEOUT_MS: 5_000,
  localDir: "/tmp/cua-parse-mock-worker",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function onAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}
function fixture(overrides: Partial<Config> = {}, existing?: LocalStore) {
  const db = existing ?? new LocalStore(":memory:");
  if (!stores.includes(db)) stores.push(db);
  const session = db.session().id;
  const evidence = {
    init: vi.fn(async (): Promise<void> => undefined),
    ingest: vi.fn(
      async (_records: EvidenceRecord[]): Promise<void> => undefined,
    ),
  };
  const providers: Record<string, ProviderStatus> = {
    elasticsearch: { status: "configured-but-unverified", detail: "mock test" },
    hackernews: { status: "configured-but-unverified", detail: "mock test" },
    openai: { status: "disabled", detail: "mock test" },
  };
  const runner = new JobRunner(
    db,
    evidence as unknown as EvidenceStore,
    { ...defaultConfig, ...overrides },
    providers,
  );
  runners.push(runner);
  return { db, session, evidence, providers, runner };
}
async function state(
  db: LocalStore,
  session: string,
  id: string,
  expected: JobState,
  timeout = 1000,
) {
  await vi.waitFor(
    () => expect(db.findJob(session, id)?.state).toBe(expected),
    { timeout, interval: 5 },
  );
  return db.findJob(session, id)!;
}
function modelRecord(
  context: { researchId: string; sessionId: string; snapshotVersion: number },
  record: RawRecord = raw,
): EvidenceRecord {
  return {
    ...record,
    ...context,
    contentHash: "mock-content-hash",
    relevant: true,
    productIdentity: "match",
    aspects: [
      { aspect: "pricing", sentiment: "positive", quote: "pricing is fair" },
    ],
    analysisVersion: "explicit-mock-label-v1",
    extractionStatus: "verified",
    contextualText: record.text,
  };
}
beforeEach(() => {
  mocks.collect.mockReset();
  mocks.analyze.mockReset();
  mocks.collect.mockResolvedValue({
    records: [raw],
    attempts: [],
    failures: [],
  });
  mocks.analyze.mockImplementation(
    async (
      records: RawRecord[],
      context: {
        researchId: string;
        sessionId: string;
        snapshotVersion: number;
      },
    ) => ({
      records: records.map((record) => modelRecord(context, record)),
      duplicates: 0,
      failures: [],
    }),
  );
});
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const db of stores.splice(0)) if (db.db.open) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("bounded worker with explicit provider mocks", () => {
  it("persists collecting, analyzing, indexing and ready with snapshot counts", async () => {
    const f = fixture();
    const saved: ResearchJob[] = [];
    const original = f.db.saveJob.bind(f.db);
    vi.spyOn(f.db, "saveJob").mockImplementation((job) => {
      original(job);
      saved.push(f.db.findJob(f.session, job.id)!);
    });
    const collected = deferred<{
      records: RawRecord[];
      attempts: [];
      failures: [];
    }>();
    mocks.collect.mockImplementation(
      async (_input: StartInput, opts: CollectionOptions) => {
        expect(opts).toMatchObject({
          maxThreads: 3,
          maxItems: 5,
          concurrency: 1,
        });
        return collected.promise;
      },
    );
    const job = f.runner.submit(f.session, testInput());
    expect(f.db.findJob(f.session, job.id)?.state).toBe("queued");
    await state(f.db, f.session, job.id, "collecting");
    collected.resolve({ records: [raw], attempts: [], failures: [] });
    const finished = await state(f.db, f.session, job.id, "ready");
    expect(
      saved
        .map((snapshot) => snapshot.state)
        .filter((value, index, all) => index === 0 || value !== all[index - 1]),
    ).toEqual(["collecting", "analyzing", "indexing", "ready"]);
    expect(finished).toMatchObject({
      collected: 1,
      analyzed: 1,
      indexed: 1,
      evidenceVersion: 1,
      partial: false,
    });
    expect(f.evidence.ingest).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          researchId: job.id,
          sessionId: f.session,
          snapshotVersion: 1,
        }),
      ],
      expect.any(AbortSignal),
    );
  });
  it("marks complete collection failure as failed without model or index calls", async () => {
    const f = fixture();
    mocks.collect.mockResolvedValue({
      records: [],
      attempts: [
        {
          query: "AcmeFlow",
          url: null,
          status: "failed",
          count: 0,
          message: "HTTP 403",
        },
      ],
      failures: ["HN source HTTP 403"],
    });
    const job = f.runner.submit(f.session, testInput());
    const finished = await state(f.db, f.session, job.id, "failed");
    expect(finished.failures).toContain("HN source HTTP 403");
    expect(f.providers.hackernews?.status).toBe("failed");
    expect(finished.indexed).toBe(0);
    expect(finished.evidenceVersion).toBe(0);
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(f.evidence.ingest).not.toHaveBeenCalled();
  });
  it("sanitizes a thrown collection error and continues the next queued job", async () => {
    const f = fixture();
    mocks.collect.mockRejectedValueOnce(new Error("SECRET REMOTE RESPONSE"));
    const first = f.runner.submit(f.session, testInput());
    const second = f.runner.submit(f.session, {
      ...testInput("mock-job-0002"),
      question: "Is onboarding clear?",
    });
    const failed = await state(f.db, f.session, first.id, "failed");
    await state(f.db, f.session, second.id, "ready");
    expect(JSON.stringify(failed)).not.toContain("SECRET REMOTE RESPONSE");
    expect(mocks.collect).toHaveBeenCalledTimes(2);
  });
  it("aborts collection when the worker deadline expires", async () => {
    const f = fixture({ JOB_TIMEOUT_MS: 30 });
    let signal: AbortSignal | undefined;
    mocks.collect.mockImplementation(
      async (_input: StartInput, opts: CollectionOptions) => {
        signal = opts.signal;
        return onAbort(opts.signal);
      },
    );
    const job = f.runner.submit(f.session, testInput());
    const finished = await state(f.db, f.session, job.id, "failed");
    expect(signal?.aborted).toBe(true);
    expect(finished.failures).toContain(
      "Research deadline exceeded. Start a smaller job.",
    );
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(f.evidence.ingest).not.toHaveBeenCalled();
  });
  it("aborts model analysis when the worker deadline expires", async () => {
    const f = fixture({ JOB_TIMEOUT_MS: 30 });
    let signal: AbortSignal | undefined;
    mocks.analyze.mockImplementation(
      async (
        _records: RawRecord[],
        _context: unknown,
        opts: AnalysisOptions,
      ) => {
        signal = opts.signal;
        return onAbort(opts.signal);
      },
    );
    const job = f.runner.submit(f.session, testInput());
    const finished = await state(f.db, f.session, job.id, "failed");
    expect(signal?.aborted).toBe(true);
    expect(finished.collected).toBe(1);
    expect(finished.failures).toContain(
      "Research deadline exceeded. Start a smaller job.",
    );
    expect(f.evidence.ingest).not.toHaveBeenCalled();
  });
  it("persists cancellation during collection and prevents late results from indexing", async () => {
    const f = fixture();
    const late = deferred<{
      records: RawRecord[];
      attempts: [];
      failures: [];
    }>();
    let signal: AbortSignal | undefined;
    mocks.collect.mockImplementation(
      async (_input: StartInput, opts: CollectionOptions) => {
        signal = opts.signal;
        return late.promise;
      },
    );
    const job = f.runner.submit(f.session, testInput());
    await state(f.db, f.session, job.id, "collecting");
    try {
      expect(f.runner.cancel("foreign-session", job.id)).toBeUndefined();
      expect(signal?.aborted).toBe(false);
      expect(f.runner.cancel(f.session, job.id)?.state).toBe("cancelled");
      expect(signal?.aborted).toBe(true);
    } finally {
      late.resolve({ records: [raw], attempts: [], failures: [] });
    }
    await vi.waitFor(
      () =>
        expect(f.db.findJob(f.session, job.id)?.failures).toContain(
          "Research cancelled.",
        ),
      { interval: 5 },
    );
    expect(f.db.findJob(f.session, job.id)?.state).toBe("cancelled");
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(f.evidence.ingest).not.toHaveBeenCalled();
  });
  it("removes a queued cancelled job without starting its collector", async () => {
    const f = fixture();
    const gate = deferred<{
      records: RawRecord[];
      attempts: [];
      failures: [];
    }>();
    mocks.collect.mockReturnValueOnce(gate.promise);
    const first = f.runner.submit(f.session, testInput());
    await state(f.db, f.session, first.id, "collecting");
    const second = f.runner.submit(f.session, {
      ...testInput("mock-job-0002"),
      question: "How is reliability?",
    });
    expect(f.db.findJob(f.session, second.id)?.state).toBe("queued");
    f.runner.cancel(f.session, second.id);
    gate.resolve({ records: [raw], attempts: [], failures: [] });
    await state(f.db, f.session, first.id, "ready");
    expect(f.db.findJob(f.session, second.id)?.state).toBe("cancelled");
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });
  it("marks partial analysis as ready while preserving failures and snapshot counts", async () => {
    const f = fixture({
      ANALYSIS_MODE: "openai",
      OPENAI_API_KEY: "explicit-mock-credential",
    });
    mocks.collect.mockResolvedValue({
      records: [
        raw,
        { ...raw, id: "hn:124", text: "AcmeFlow support is slow." },
      ],
      attempts: [],
      failures: [],
    });
    mocks.analyze.mockImplementation(
      async (
        records: RawRecord[],
        context: {
          researchId: string;
          sessionId: string;
          snapshotVersion: number;
        },
        opts: AnalysisOptions,
      ) => {
        opts.onProgress?.(1);
        return {
          records: [
            modelRecord(context, records[0]),
            {
              ...modelRecord(context, records[1]),
              relevant: false,
              productIdentity: "ambiguous",
              aspects: [],
              extractionStatus: "failed",
            },
          ],
          duplicates: 1,
          failures: ["One source had invalid model quote spans."],
        };
      },
    );
    const job = f.runner.submit(f.session, testInput());
    const finished = await state(f.db, f.session, job.id, "ready");
    expect(finished).toMatchObject({
      collected: 2,
      analyzed: 2,
      indexed: 2,
      duplicates: 1,
      evidenceVersion: 1,
      partial: true,
    });
    expect(finished.failures).toEqual([
      "One source had invalid model quote spans.",
    ]);
    expect(f.providers.openai?.status).toBe("verified");
  });
  it("completes a valid empty collection with zero evidence", async () => {
    const f = fixture();
    mocks.collect.mockResolvedValue({
      records: [],
      attempts: [],
      failures: [],
    });
    const job = f.runner.submit(f.session, testInput());
    const finished = await state(f.db, f.session, job.id, "ready");
    expect(finished).toMatchObject({
      collected: 0,
      analyzed: 0,
      indexed: 0,
      partial: false,
      evidenceVersion: 1,
    });
    expect(f.evidence.ingest).toHaveBeenCalledWith([], expect.any(AbortSignal));
  });
  it("does not index twice for an identical session idempotency key", async () => {
    const f = fixture();
    const first = f.runner.submit(f.session, testInput());
    const same = f.runner.submit(f.session, testInput());
    expect(same.id).toBe(first.id);
    await state(f.db, f.session, first.id, "ready");
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(f.evidence.ingest).toHaveBeenCalledTimes(1);
    expect(() =>
      f.runner.submit(f.session, {
        ...testInput(),
        question: "A changed question",
      }),
    ).toThrow("already used");
  });
  it("enforces the active-job cap for equal questions with new keys while permitting a replay", async () => {
    const f = fixture();
    mocks.collect.mockImplementation(
      async (_input: StartInput, opts: CollectionOptions) =>
        onAbort(opts.signal),
    );
    const firstInput = testInput("same-question-one");
    const first = f.runner.submit(f.session, firstInput);
    const second = f.runner.submit(f.session, testInput("same-question-two"));
    expect(second.id).not.toBe(first.id);
    expect(() =>
      f.runner.submit(f.session, testInput("same-question-three")),
    ).toThrow("Two research jobs");
    expect(f.db.listJobs(f.session)).toHaveLength(2);
    expect(f.runner.submit(f.session, firstInput).id).toBe(first.id);
    try {
      f.runner.submit(f.session, {
        ...firstInput,
        question: "Changed payload",
      });
      throw new Error("Expected an idempotency conflict");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        message: "Idempotency key was already used for another request.",
      });
    }
  });
  it("permits an existing same-key replay when the global queue is full", async () => {
    const f = fixture();
    mocks.collect.mockImplementation(
      async (_input: StartInput, opts: CollectionOptions) =>
        onAbort(opts.signal),
    );
    const firstInput = testInput("full-queue-original");
    const first = f.runner.submit(f.session, firstInput);
    await state(f.db, f.session, first.id, "collecting");
    for (let i = 0; i < 10; i++)
      f.runner.submit(f.db.session().id, testInput(`full-queue-${i}`));
    expect(() =>
      f.runner.submit(f.db.session().id, testInput("full-queue-extra")),
    ).toThrow("queue is full");
    expect(f.runner.submit(f.session, firstInput).id).toBe(first.id);
    try {
      f.runner.submit(f.session, {
        ...firstInput,
        product: "Different product",
      });
      throw new Error("Expected an idempotency conflict");
    } catch (error) {
      expect(error).toMatchObject({ status: 409 });
    }
  });
  it("keeps discovered stories separate from collected feedback in progress", async () => {
    const f = fixture();
    const gate = deferred<{
      records: RawRecord[];
      attempts: [];
      failures: [];
    }>();
    mocks.collect.mockImplementation(
      async (_input: StartInput, opts: CollectionOptions) => {
        opts.onProgress?.({
          query: "AcmeFlow",
          url: "https://hn.algolia.com/api/v1/search",
          status: "success",
          count: 7,
        });
        opts.onProgress?.({
          query: "HN item 123",
          url: raw.url,
          status: "success",
          count: 1,
        });
        return gate.promise;
      },
    );
    const job = f.runner.submit(f.session, testInput());
    try {
      await state(f.db, f.session, job.id, "collecting");
      expect(f.db.findJob(f.session, job.id)?.collected).toBe(1);
      expect(f.db.findJob(f.session, job.id)?.attempts).toHaveLength(2);
    } finally {
      gate.resolve({ records: [raw], attempts: [], failures: [] });
    }
    await state(f.db, f.session, job.id, "ready");
  });
  it("reports the model provider failed when every structured label fails validation", async () => {
    const f = fixture({
      ANALYSIS_MODE: "openai",
      OPENAI_API_KEY: "explicit-mock-credential",
    });
    mocks.analyze.mockImplementation(
      async (
        _records: RawRecord[],
        context: {
          researchId: string;
          sessionId: string;
          snapshotVersion: number;
        },
      ) => ({
        records: [
          {
            ...modelRecord(context),
            relevant: false,
            productIdentity: "ambiguous",
            aspects: [],
            extractionStatus: "failed",
          },
        ],
        duplicates: 0,
        failures: ["Invalid model quote spans."],
      }),
    );
    const job = f.runner.submit(f.session, testInput());
    const finished = await state(f.db, f.session, job.id, "ready");
    expect(finished.partial).toBe(true);
    expect(f.providers.openai?.status).toBe("failed");
  });
  it("does not publish late indexing success after the job deadline", async () => {
    const f = fixture({ JOB_TIMEOUT_MS: 30 });
    const gate = deferred<void>();
    f.evidence.ingest.mockReturnValueOnce(gate.promise);
    const job = f.runner.submit(f.session, testInput());
    try {
      const finished = await state(f.db, f.session, job.id, "failed", 300);
      expect(finished.evidenceVersion).toBe(0);
      expect(finished.indexed).toBe(0);
      expect(f.providers.elasticsearch?.status).toBe("failed");
    } finally {
      gate.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.db.findJob(f.session, job.id)?.state).toBe("failed");
  });
  it("enforces the deadline even when Elasticsearch initialization has not settled", async () => {
    const f = fixture({ JOB_TIMEOUT_MS: 30 });
    const gate = deferred<void>();
    f.evidence.init.mockReturnValueOnce(gate.promise);
    const job = f.runner.submit(f.session, testInput());
    try {
      const finished = await state(f.db, f.session, job.id, "failed", 300);
      expect(finished.failures).toContain(
        "Research deadline exceeded. Start a smaller job.",
      );
      expect(mocks.collect).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
  });
});

describe("real local SQLite recovery and result sequence rules", () => {
  it("recovers interrupted jobs after reopening the database and preserves terminal states", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "cua-parse-worker-test-"),
    );
    directories.push(directory);
    const file = path.join(directory, "jobs.db");
    const original = new LocalStore(file);
    stores.push(original);
    const session = original.session().id;
    const states: JobState[] = [
      "queued",
      "collecting",
      "analyzing",
      "indexing",
      "ready",
      "failed",
      "cancelled",
    ];
    const jobs = states.map((jobState, index) => {
      const job = original.insertJob(
        session,
        testInput(`recovery-${index}`),
      ).job;
      job.state = jobState;
      job.collected = 3;
      original.saveJob(job);
      return job;
    });
    original.close();
    const reopened = new LocalStore(file);
    stores.push(reopened);
    fixture({}, reopened);
    for (const [index, job] of jobs.entries()) {
      const saved = reopened.findJob(session, job.id)!;
      if (index < 4) {
        expect(saved.state).toBe("failed");
        expect(saved.failures).toContain(
          "Service restarted before completion. Start a new research job.",
        );
        expect(saved.collected).toBe(3);
      } else expect(saved.state).toBe(states[index]);
    }
    expect(reopened.recover()).toBe(0);
  });
  it("rejects late scope packets and keeps session query sequences separate", () => {
    const db = new LocalStore(":memory:");
    stores.push(db);
    const session = db.session().id;
    const other = db.session().id;
    const research = db.insertJob(session, testInput()).job.id;
    const packet: EvidencePacket = {
      researchId: research,
      snapshotVersion: 1,
      scopeVersion: "scope-current",
      requestId: "query-current",
      question: "Pricing?",
      filters: {
        excludedThreadIds: ["hn:100"],
        aspect: "pricing",
        source: null,
        from: null,
        to: null,
      },
      challenge: false,
      retrievalMode: "bm25",
      provenance: ["synthetic"],
      metrics: {
        collectedRecords: 0,
        scopedRecords: 0,
        relevantRecords: 0,
        distinctThreads: 0,
        aspectMentions: 0,
        aspects: [],
        threads: [],
      },
      findings: [],
      evidence: [],
      opposingEvidence: [],
      limitations: ["Explicit mock evidence packet."],
      spokenSummary: "No evidence.",
      generatedAt: "2026-09-19T12:00:00.000Z",
    };
    const oldSequence = db.nextQuery(session, research);
    const newSequence = db.nextQuery(session, research);
    expect(newSequence).toBe(oldSequence + 1);
    expect(db.savePacket(session, packet, newSequence)).toBe(true);
    expect(
      db.savePacket(
        session,
        { ...packet, scopeVersion: "scope-stale", requestId: "query-stale" },
        oldSequence,
      ),
    ).toBe(false);
    const saved = db.db
      .prepare("SELECT packet FROM views WHERE session=? AND research=?")
      .get(session, research) as { packet: string };
    expect(JSON.parse(saved.packet).scopeVersion).toBe("scope-current");
    expect(db.savePacket(other, packet, newSequence)).toBe(false);
    expect(db.nextQuery(other, research)).toBe(1);
    expect(
      db.savePacket(other, { ...packet, scopeVersion: "other-session" }, 1),
    ).toBe(true);
    const stillCurrent = db.db
      .prepare("SELECT packet FROM views WHERE session=? AND research=?")
      .get(session, research) as { packet: string };
    expect(JSON.parse(stillCurrent.packet).scopeVersion).toBe("scope-current");
  });
});
