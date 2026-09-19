import type { Config } from "./config.js";
import { LocalStore } from "./storage.js";
import { EvidenceStore } from "./elastic.js";
import { collect } from "./collection.js";
import { analyze } from "./analysis.js";
import type {
  ResearchJob,
  StartInput,
  ProviderStatus,
} from "../shared/contracts.js";
export function withinDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Research aborted."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export class JobRunner {
  private running = false;
  private queue: Array<{
    session: string;
    input: StartInput;
    job: ResearchJob;
  }> = [];
  private controllers = new Map<string, AbortController>();
  constructor(
    private db: LocalStore,
    private evidence: EvidenceStore,
    private config: Config,
    private providers: Record<string, ProviderStatus>,
  ) {
    db.recover();
  }
  submit(session: string, input: StartInput) {
    // A replay consumes no queue slot. Match the key and full input before
    // capacity checks; equal question text does not identify the same operation.
    const existing = this.db.findJobByIdempotency(session, input);
    if (existing) return existing;
    if (this.queue.length >= 10)
      throw Object.assign(
        new Error("Research queue is full. Try again after a job completes."),
        { status: 429 },
      );
    const active = this.db
      .listJobs(session)
      .filter((x) =>
        ["queued", "collecting", "analyzing", "indexing"].includes(x.state),
      );
    if (active.length >= 2)
      throw Object.assign(new Error("Two research jobs are already active."), {
        status: 429,
      });
    const result = this.db.insertJob(session, input);
    if (result.created) {
      this.queue.push({ session, input, job: result.job });
      void this.drain();
    }
    return result.job;
  }
  cancel(session: string, id: string) {
    const job = this.db.findJob(session, id);
    if (!job) return undefined;
    if (["ready", "failed", "cancelled"].includes(job.state)) return job;
    job.state = "cancelled";
    this.db.saveJob(job);
    this.controllers.get(id)?.abort();
    this.queue = this.queue.filter((x) => x.job.id !== id);
    return job;
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        await this.run(task);
      }
    } finally {
      this.running = false;
    }
  }
  private async run({
    session,
    input,
    job,
  }: {
    session: string;
    input: StartInput;
    job: ResearchJob;
  }) {
    const control = new AbortController();
    this.controllers.set(job.id, control);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      control.abort();
    }, this.config.JOB_TIMEOUT_MS);
    const persist = () => {
      control.signal.throwIfAborted();
      this.db.saveJob(job);
    };
    try {
      await withinDeadline(this.evidence.init(control.signal), control.signal);
      this.providers.elasticsearch = {
        status: "verified",
        detail: "Connected; evidence mapping verified.",
      };
      control.signal.throwIfAborted();
      job.state = "collecting";
      persist();
      const collected = await withinDeadline(
        collect(input, {
          maxThreads: this.config.MAX_THREADS,
          maxItems: this.config.MAX_ITEMS,
          concurrency: this.config.COLLECTION_CONCURRENCY,
          signal: control.signal,
          onProgress: (attempt) => {
            job.attempts.push(attempt);
            if (
              attempt.status === "success" &&
              (input.mode !== "live" || attempt.query.startsWith("HN item "))
            )
              job.collected += attempt.count;
            persist();
          },
        }),
        control.signal,
      );
      job.attempts = collected.attempts;
      job.failures.push(...collected.failures);
      job.collected = collected.records.length;
      persist();
      if (input.mode === "live" && collected.records.length)
        this.providers.hackernews = {
          status: "verified",
          detail: "Public HN API collection completed in this service.",
        };
      if (
        input.mode === "live" &&
        collected.records.length === 0 &&
        collected.failures.length
      )
        throw new Error("All collection attempts failed.");
      job.state = "analyzing";
      persist();
      const result = await withinDeadline(
        analyze(
          collected.records,
          {
            researchId: job.id,
            sessionId: session,
            product: input.product,
            snapshotVersion: 1,
          },
          {
            mode:
              input.mode === "fixture" ? "fixture" : this.config.ANALYSIS_MODE,
            model: this.config.OPENAI_ANALYSIS_MODEL,
            apiKey: this.config.OPENAI_API_KEY,
            signal: control.signal,
            onProgress: (n) => {
              job.analyzed = n;
              persist();
            },
          },
        ),
        control.signal,
      );
      job.duplicates = result.duplicates;
      job.analyzed = result.records.length;
      job.failures.push(...result.failures);
      job.state = "indexing";
      persist();
      await withinDeadline(
        this.evidence.ingest(result.records, control.signal),
        control.signal,
      );
      control.signal.throwIfAborted();
      job.indexed = result.records.length;
      job.evidenceVersion = 1;
      job.partial = job.failures.length > 0;
      job.state = "ready";
      persist();
      if (
        input.mode !== "fixture" &&
        this.config.ANALYSIS_MODE === "openai" &&
        result.records.some((x) => x.extractionStatus === "verified")
      )
        this.providers.openai = {
          status: "verified",
          detail: "Structured analysis returned validated source spans.",
        };
      else if (
        input.mode !== "fixture" &&
        this.config.ANALYSIS_MODE === "openai" &&
        result.failures.length
      )
        this.providers.openai = {
          status: "failed",
          detail:
            "No source labels passed model validation. Inspect job failures.",
        };
    } catch {
      const stage = job.state;
      const cancelled = this.db.findJob(session, job.id)?.state === "cancelled";
      if (!cancelled) {
        const provider =
          stage === "collecting" && input.mode === "live"
            ? "hackernews"
            : stage === "analyzing" && this.config.ANALYSIS_MODE === "openai"
              ? "openai"
              : stage === "queued" || stage === "indexing"
                ? "elasticsearch"
                : null;
        if (provider)
          this.providers[provider] = {
            status: "failed",
            detail: timedOut
              ? "Research deadline exceeded."
              : `Research failed during ${stage}. Check local configuration and source attempts.`,
          };
      }
      job.state = cancelled ? "cancelled" : "failed";
      job.partial = job.indexed > 0 || job.failures.length > 0;
      job.failures.push(
        cancelled
          ? "Research cancelled."
          : timedOut
            ? "Research deadline exceeded. Start a smaller job."
            : "Research could not finish. Check source/provider status and local setup.",
      );
      this.db.saveJob(job);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(job.id);
    }
  }
  async stop() {
    for (const [id, c] of this.controllers) {
      c.abort();
      for (const q of this.queue) {
        q.job.state = "failed";
        q.job.failures.push("Service stopped.");
        this.db.saveJob(q.job);
      }
      this.queue = [];
      void id;
    }
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }
}
