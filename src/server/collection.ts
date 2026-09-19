import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import { Parser } from "htmlparser2";
import { z } from "zod";
import { fixtureRecords, FIXTURE_PRODUCT } from "../../fixtures/acmeflow.js";
import {
  rawRecordSchema,
  startSchema,
  type CollectionOptions,
  type CollectionResult,
  type RawRecord,
  type SourceAttempt,
  type StartInput,
} from "../shared/contracts.js";

const ALGOLIA = "https://hn.algolia.com";
const HN_API = "https://hacker-news.firebaseio.com";
const MAX_RESPONSE_BYTES = 1_000_000;
const itemSchema = z.object({
  id: z.number().int().positive(),
  type: z.string(),
  text: z.string().optional(),
  title: z.string().optional(),
  time: z.number().optional(),
  parent: z.number().int().positive().optional(),
  kids: z.array(z.number().int().positive()).optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
});
type HnItem = z.infer<typeof itemSchema>;
const discoverySchema = z.object({
  hits: z.array(z.object({ objectID: z.string().regex(/^\d+$/) })).max(100),
});

/** Display text captured from HN HTML. Text nodes and entities are preserved; no HTML executes. */
export function htmlToText(html: string): string {
  let text = "";
  let hidden = 0;
  const block = new Set(["p", "br", "div", "li", "pre", "blockquote"]);
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "script" || name === "style") hidden++;
        if (!hidden && block.has(name) && text && !text.endsWith("\n"))
          text += "\n";
      },
      ontext(value) {
        if (!hidden) text += value;
      },
      onclosetag(name) {
        if (name === "script" || name === "style")
          hidden = Math.max(0, hidden - 1);
        if (!hidden && block.has(name) && text && !text.endsWith("\n"))
          text += "\n";
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return text.trim();
}

/** Imported links are references only. No collector ever fetches an imported URL. */
export function validateReferenceUrl(value: string | null): string | null {
  if (value === null) return null;
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(hostname.replace(/^\[|\]$/g, "")) ||
    !hostname.includes(".") ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    [...value].some(
      (character) => character.charCodeAt(0) <= 32 || character === "\\",
    )
  ) {
    throw new Error(
      "Imported source links must be public HTTP(S) domain references without credentials or custom ports.",
    );
  }
  url.hostname = hostname;
  return url.href;
}

/** Stable identity and source payload must agree; repeated observations may have a new collection time. */
export function sameSourceRecord(left: RawRecord, right: RawRecord): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.provenance === right.provenance &&
    left.text === right.text &&
    left.threadId === right.threadId &&
    left.threadTitle === right.threadTitle &&
    left.parentId === right.parentId &&
    left.url === right.url &&
    left.publishedAt === right.publishedAt
  );
}

function bounded(value: number, cap: number, name: string) {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
  return Math.min(value, cap);
}

function safeFailure(error: unknown): string {
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return "Source request timed out or was cancelled.";
  // Do not forward remote response bodies, URLs, or configuration in errors.
  if (error instanceof SourceError) return error.message;
  return "Source request failed or returned an invalid response.";
}
class SourceError extends Error {}

async function fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
  if (!(
    (url.origin === ALGOLIA && url.pathname === "/api/v1/search") ||
    (url.origin === HN_API && /^\/v0\/item\/\d+\.json$/.test(url.pathname))
  ))
    throw new SourceError("Source URL is not allowlisted.");
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryDelay = Number.isFinite(seconds)
          ? seconds * 1000
          : retryAfter
            ? Date.parse(retryAfter) - Date.now()
            : 1000;
        await response.body?.cancel();
        if (
          attempt === 0 &&
          [429, 502, 503, 504].includes(response.status) &&
          Number.isFinite(retryDelay) &&
          retryDelay >= 0 &&
          retryDelay <= 5000
        ) {
          await delay(Math.max(250, retryDelay), undefined, { signal });
          continue;
        }
        throw new SourceError(`Source returned HTTP ${response.status}.`);
      }
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new SourceError("Source response exceeded the size limit.");
      }
      if (!response.body)
        throw new SourceError("Source returned an empty response.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new SourceError("Source response exceeded the size limit.");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      signal.throwIfAborted();
      if (
        attempt === 0 &&
        !(error instanceof SourceError) &&
        !(error instanceof SyntaxError)
      ) {
        await delay(500, undefined, { signal });
        continue;
      }
      throw error;
    }
  }
  throw new SourceError("Source retry limit reached.");
}

export function discoveryQueries(product: string, question: string): string[] {
  const aspects = [
    "pricing",
    "onboarding",
    "reliability",
    "support",
    "features",
  ]
    .filter((term) => question.toLowerCase().includes(term))
    .slice(0, 2);
  const broadNegative =
    /\b(?:sucks?|complaints?|frustrat\w*|hate|problems?)\b/i.test(question);
  const targets = aspects.length
    ? aspects
    : [broadNegative ? "complaints" : "experience"];
  return [product, ...targets.map((aspect) => `${product} ${aspect}`)];
}

async function collectHackerNews(
  input: StartInput,
  options: CollectionOptions,
): Promise<CollectionResult> {
  const maxThreads = bounded(options.maxThreads, 10, "maxThreads");
  const maxItems = bounded(options.maxItems, 150, "maxItems");
  const concurrency = bounded(options.concurrency, 2, "concurrency");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
  const records: RawRecord[] = [];
  const attempts: SourceAttempt[] = [];
  const failures: string[] = [];
  const emit = (attempt: SourceAttempt) => {
    attempts.push(attempt);
    options.onProgress?.(attempt);
  };
  const resultLists: number[][] = [];
  const queries = discoveryQueries(input.product, input.question);
  for (const query of queries) {
    signal.throwIfAborted();
    const url = new URL("/api/v1/search", ALGOLIA);
    url.searchParams.set("query", query);
    url.searchParams.set("tags", "story");
    url.searchParams.set("hitsPerPage", String(maxThreads));
    url.searchParams.set("page", "0");
    try {
      const data = discoverySchema.parse(await fetchJson(url, signal));
      const ids = data.hits
        .map((hit) => Number(hit.objectID))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      resultLists.push(ids);
      emit({
        query,
        url: url.href,
        status: "success",
        count: ids.length,
        message:
          "Algolia discovery: first page of story matches. This is a bounded sample.",
      });
    } catch (error) {
      signal.throwIfAborted();
      const message = safeFailure(error);
      failures.push(message);
      emit({ query, url: url.href, status: "failed", count: 0, message });
      resultLists.push([]);
    }
  }
  // Interleave neutral and targeted results so targeted queries can affect discovery.
  const threadIds: number[] = [];
  for (let row = 0; row < maxThreads && threadIds.length < maxThreads; row++) {
    for (const ids of resultLists) {
      const id = ids[row];
      if (id && !threadIds.includes(id) && threadIds.length < maxThreads)
        threadIds.push(id);
    }
  }
  type Task = { id: number; threadId: number; title: string };
  // Keep breadth-first order within each thread, but give each active thread one
  // request per turn. One large reply list must not consume the entire sample.
  const queues: Task[][] = threadIds.map((id) => [
    { id, threadId: id, title: `Hacker News thread ${id}` },
  ]);
  const queued = new Set(threadIds);
  const seen = new Set<number>();
  const titles = new Map<number, string>();
  let cursor = 0;
  let pending = queued.size;
  let omittedReplies = false;
  let requests = 0;
  const requestCap = Math.min(190, maxItems + maxThreads + 20);
  while (pending && records.length < maxItems && requests < requestCap) {
    signal.throwIfAborted();
    const batch: Task[] = [];
    const batchSize = Math.min(
      concurrency,
      maxItems - records.length,
      requestCap - requests,
    );
    for (
      let checked = 0;
      checked < queues.length && batch.length < batchSize;
      checked++
    ) {
      const queue = queues[cursor]!;
      cursor = (cursor + 1) % queues.length;
      const task = queue.shift();
      if (!task) continue;
      pending--;
      queued.delete(task.id);
      seen.add(task.id);
      batch.push(task);
    }
    requests += batch.length;
    const fetched = await Promise.all(
      batch.map(async (task) => {
        const url = new URL(`/v0/item/${task.id}.json`, HN_API);
        try {
          return { task, item: itemSchema.parse(await fetchJson(url, signal)) };
        } catch (error) {
          signal.throwIfAborted();
          const message = safeFailure(error);
          failures.push(`HN item ${task.id}: ${message}`);
          emit({
            query: `HN item ${task.id}`,
            url: url.href,
            status: "failed",
            count: 0,
            message,
          });
          return { task, item: null };
        }
      }),
    );
    for (const { task, item } of fetched) {
      if (!item) continue;
      const originalUrl = `https://news.ycombinator.com/item?id=${task.id}`;
      if (item.id !== task.id || !["story", "comment"].includes(item.type)) {
        emit({
          query: `HN item ${task.id}`,
          url: originalUrl,
          status: "skipped",
          count: 0,
          message: "Unsupported or mismatched item.",
        });
        continue;
      }
      const removed = item.deleted || item.dead;
      if (task.id === task.threadId && !removed)
        titles.set(
          task.threadId,
          htmlToText(item.title ?? task.title).slice(0, 500),
        );
      const title = titles.get(task.threadId) ?? task.title;
      // Do not retain removed text or titles. Its valid children can still be
      // collected within the same thread, request budget, and source allowlist.
      const text = removed ? "" : htmlToText(item.text ?? "");
      let count = 0;
      if (text) {
        const record = rawRecordSchema.safeParse({
          id: `hn:${item.id}`,
          text,
          url: originalUrl,
          threadId: `hn:${task.threadId}`,
          threadTitle: title,
          parentId: item.parent ? `hn:${item.parent}` : null,
          publishedAt: publicationDate(item),
          collectedAt: new Date().toISOString(),
          source: "hackernews",
          provenance: "live",
        });
        if (record.success) {
          records.push(record.data);
          count = 1;
        } else {
          failures.push(
            `HN item ${task.id}: text or metadata exceeded the record limits.`,
          );
        }
      }
      emit({
        query: `HN item ${task.id}`,
        url: originalUrl,
        status: count ? "success" : "skipped",
        count,
        message: count
          ? "Original HN API text; HTML entities decoded."
          : removed
            ? "Deleted or dead original omitted; valid descendants remain eligible."
            : "No usable text in this item.",
      });
      const queue = queues[threadIds.indexOf(task.threadId)]!;
      if ((item.kids?.length ?? 0) > 150) omittedReplies = true;
      for (const child of (item.kids ?? []).slice(0, 150)) {
        if (seen.has(child) || queued.has(child)) continue;
        if (pending >= 300) {
          // Share the bounded pending queue as well as request turns. Retain
          // earlier replies; only replace a longer thread's last pending reply.
          const longest = queues.reduce((a, b) =>
            a.length >= b.length ? a : b,
          );
          if (longest.length <= queue.length + 1) {
            omittedReplies = true;
            continue;
          }
          const removed = longest.pop()!;
          queued.delete(removed.id);
          pending--;
          omittedReplies = true;
        }
        queue.push({ id: child, threadId: task.threadId, title });
        queued.add(child);
        pending++;
      }
    }
  }
  if (pending || omittedReplies)
    emit({
      query: "Collection limit",
      url: null,
      status: "skipped",
      count: pending,
      message:
        "Some replies were not collected because the item, request, or pending queue limit was reached. Requests rotate across available threads; this is not a representative sample.",
    });
  return { records, attempts, failures };
}

function publicationDate(item: HnItem): string | null {
  if (item.time === undefined) return null;
  const date = new Date(item.time * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface SourceAdapter {
  collect(
    input: StartInput,
    options: CollectionOptions,
  ): Promise<CollectionResult>;
}
const adapters: Record<StartInput["mode"], SourceAdapter> = {
  live: { collect: collectHackerNews },
  fixture: {
    async collect(input, options) {
      if (input.product.trim().toLowerCase() !== FIXTURE_PRODUCT.toLowerCase())
        throw new Error(
          "The synthetic fixture is only for AcmeFlow. Use live collection or an authorized import for another product.",
        );
      const all = fixtureRecords();
      const records = all.slice(0, bounded(options.maxItems, 150, "maxItems"));
      const attempt: SourceAttempt = {
        query: "Synthetic AcmeFlow fixture",
        url: null,
        status: "success",
        count: records.length,
        message:
          "Invented demo records and declared labels. No web search occurred.",
      };
      options.onProgress?.(attempt);
      return {
        records,
        attempts: [attempt],
        failures:
          records.length < all.length
            ? ["The fixture was limited by the configured item cap."]
            : [],
      };
    },
  },
  import: {
    async collect(input, options) {
      if (!input.records)
        throw new Error(
          "Import mode requires explicit records with imported provenance.",
        );
      if (input.records.length > bounded(options.maxItems, 150, "maxItems"))
        throw new Error("Import exceeds the configured item cap.");
      const ids = new Map<string, RawRecord>();
      const records = input.records.map((value) => {
        const record = rawRecordSchema.parse(value);
        if (record.source !== "import" || record.provenance !== "imported")
          throw new Error(
            "Imported records must use source=import and provenance=imported.",
          );
        const validated = { ...record, url: validateReferenceUrl(record.url) };
        const previous = ids.get(record.id);
        if (previous && !sameSourceRecord(previous, validated))
          throw new Error(
            "An imported record ID refers to conflicting content or metadata.",
          );
        ids.set(record.id, validated);
        return validated;
      });
      const attempt: SourceAttempt = {
        query: "Authorized JSON import",
        url: null,
        status: "success",
        count: records.length,
        message:
          "User supplied records and timestamps. Source URLs were validated as references, not fetched.",
      };
      options.onProgress?.(attempt);
      return { records, attempts: [attempt], failures: [] };
    },
  },
};

export async function collect(
  input: StartInput,
  options: CollectionOptions,
): Promise<CollectionResult> {
  options.signal.throwIfAborted();
  const validated = startSchema.parse(input);
  return adapters[validated.mode].collect(validated, options);
}
