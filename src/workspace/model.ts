/** Local feedback analysis. No model, network request, or inferred source labels. */
export type Sentiment =
  "positive" | "negative" | "neutral" | "mixed" | "unknown";
export type Provenance = "synthetic" | "imported";
export interface FeedbackRecord {
  id: string;
  nativeId: string;
  tenant: string;
  productId: string;
  product: string;
  source: string;
  text: string;
  url: string | null;
  threadId: string;
  threadTitle: string;
  publishedAt: string | null;
  sentiment: Sentiment;
  relevant: boolean | null;
  issues: string[];
  isComplaint: boolean | null;
  engagement: number;
  provenance: Provenance;
}
export interface ImportReport {
  inputRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  warnings: string[];
}
export interface WorkspaceDataset {
  label: string;
  records: FeedbackRecord[];
  provenance: Provenance;
  importReport?: ImportReport;
}
export interface Scope {
  product: string;
  sources: string[];
  sentiment: "all" | Sentiment;
  from: string;
  to: string;
  query: string;
  excludedThreadIds: string[];
}
export type Filters = Scope;
export type Dataset = WorkspaceDataset;
export type Feedback = FeedbackRecord;
export interface RankedIssue {
  name: string;
  count: number;
  /** Percentage of records that are not explicitly marked irrelevant. */
  share: number;
  evidence: FeedbackRecord[];
}
export interface Analysis {
  records: FeedbackRecord[];
  metrics: {
    totalRecords: number;
    scopedRecords: number;
    sourceCount: number;
    threadCount: number;
    complaints: number;
    unlabeled: number;
    irrelevant: number;
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
  };
  issues: RankedIssue[];
  threads: { id: string; title: string; count: number }[];
  limitations: string[];
  scopeDescription: string;
}
export interface EvidenceAnswer {
  text: string;
  citations: FeedbackRecord[];
  kind: "overview" | "issue" | "positive" | "search" | "empty";
  limitations: string[];
}
export class ImportError extends Error {
  constructor(
    message: string,
    public readonly report: ImportReport,
  ) {
    super(message);
    this.name = "ImportError";
  }
}
export const IMPORT_LIMITS = {
  bytes: 5 * 1024 * 1024,
  rows: 5000,
  content: 20000,
};
const sentiments = new Set<Sentiment>([
  "positive",
  "negative",
  "neutral",
  "mixed",
  "unknown",
]);
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const folded = (text: string) => text.toLocaleLowerCase("en-US");
const identity = (...parts: string[]) => JSON.stringify(parts);
function requiredText(value: unknown, field: string, max = 500): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (char) =>
        char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)),
    )
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}
function optionalText(value: unknown, field: string, max = 500): string {
  if (value === undefined || value === null || value === "") return "";
  return requiredText(value, field, max);
}
function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}
/** Reject ambiguous dates, rollover days, and local-time timestamps. */
export function normalizedDate(value: string): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(
      value,
    )
  )
    return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function privateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
/** A link can open a public original, but can never carry credentials or local addresses. */
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !host.includes(".") ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      privateIpv4(host)
    )
      return null;
    // IPv6 literals are unnecessary for public source links and include many private encodings.
    if (host.includes(":")) return null;
    if (
      [...url.searchParams.keys()].some((key) =>
        /(?:token|secret|password|credential|api[_-]?key|signature|authorization|^(?:auth|key|sig|access[_-]?key(?:[_-]?id)?)$)/iu.test(
          key,
        ),
      )
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
function parsedRecord(value: unknown): FeedbackRecord {
  if (!object(value)) throw new Error("row is not an object");
  const normalized = Object.hasOwn(value, "content");
  const meta = object(value.source_metadata) ? value.source_metadata : {};
  const source = requiredText(value.source, "source", 80).trim();
  const rawId = requiredText(
    normalized ? value.external_id : value.id,
    "native ID",
    1000,
  );
  const nativeId =
    !normalized && rawId.startsWith(`${source}_`)
      ? rawId.slice(source.length + 1)
      : rawId;
  if (!nativeId) throw new Error("invalid native ID");
  const tenant =
    optionalText(value.organization_id, "organization ID", 500) || "unscoped";
  const product = requiredText(
    normalized
      ? meta.product_name || value.product || value.product_id
      : value.product,
    "product",
    500,
  ).trim();
  const productId =
    optionalText(value.product_id, "product ID", 500) || product;
  const text = requiredText(
    normalized ? value.content : value.text,
    "content",
    IMPORT_LIMITS.content,
  );
  const timestamp = normalized ? value.published_at : value.created_at;
  let publishedAt: string | null = null;
  if (timestamp !== undefined && timestamp !== null && timestamp !== "") {
    if (
      typeof timestamp !== "string" ||
      !(publishedAt = normalizedDate(timestamp))
    )
      throw new Error("invalid publication date");
  }
  let sentiment: Sentiment = "unknown";
  if (value.sentiment !== undefined && value.sentiment !== null) {
    if (
      typeof value.sentiment !== "string" ||
      !sentiments.has(folded(value.sentiment) as Sentiment)
    )
      throw new Error("invalid sentiment label");
    sentiment = folded(value.sentiment) as Sentiment;
  }
  const categories = value.issue_categories ?? value.issues ?? [];
  if (!Array.isArray(categories) || categories.length > 100)
    throw new Error("invalid issue labels");
  const issues = [
    ...new Set(
      categories.map((label) => requiredText(label, "issue label", 160).trim()),
    ),
  ].sort(order);
  const thread =
    optionalText(
      normalized ? meta.thread_id : value.thread_id,
      "thread ID",
      2000,
    ) || nativeId;
  const threadTitle =
    optionalText(
      normalized ? meta.thread_title : value.thread_title,
      "thread title",
      2000,
    ) || "Untitled source thread";
  const engagementValue = object(value.engagement)
    ? value.engagement.score
    : value.score;
  const engagement =
    engagementValue === undefined || engagementValue === null
      ? 0
      : engagementValue;
  if (typeof engagement !== "number" || !Number.isFinite(engagement))
    throw new Error("invalid engagement");
  return {
    id: identity(tenant, productId, source, nativeId),
    nativeId,
    tenant,
    productId,
    product,
    source,
    text,
    url: safeSourceUrl(value.url),
    threadId: identity(tenant, productId, source, thread),
    threadTitle,
    publishedAt,
    sentiment,
    relevant: optionalBoolean(value.relevant, "relevance label"),
    issues,
    isComplaint: optionalBoolean(value.is_complaint, "complaint label"),
    engagement,
    provenance: "imported",
  };
}
function emptyReport(): ImportReport {
  return {
    inputRows: 0,
    acceptedRows: 0,
    rejectedRows: 0,
    duplicateRows: 0,
    warnings: [],
  };
}
/** Read OverHeard FeedbackRecord JSON/JSONL or collect_cli SourceDocument JSONL. */
export function parseImport(
  text: string,
  fileName = "Imported feedback",
): WorkspaceDataset {
  const report = emptyReport();
  if (new TextEncoder().encode(text).byteLength > IMPORT_LIMITS.bytes)
    throw new ImportError(
      "File exceeds the 5 MiB limit. No records were imported.",
      report,
    );
  const input = text.replace(/^\uFEFF/u, "").trim();
  if (!input)
    throw new ImportError(
      "The file is empty. No records were imported.",
      report,
    );
  let rows: unknown[];
  try {
    const json: unknown = JSON.parse(input);
    if (Array.isArray(json)) rows = json;
    else if (object(json) && Array.isArray(json.records)) rows = json.records;
    else if (object(json) && Array.isArray(json.documents))
      rows = json.documents;
    else rows = [json];
  } catch {
    const lines = input.split(/\r?\n/u).filter((line) => line.trim());
    rows = lines.map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    });
  }
  report.inputRows = rows.length;
  if (rows.length > IMPORT_LIMITS.rows)
    throw new ImportError(
      `File contains ${rows.length} rows; the limit is 5,000. No records were imported.`,
      report,
    );
  const records: FeedbackRecord[] = [];
  const seen = new Set<string>();
  const reasons = new Map<string, number>();
  let unsafeLinks = 0;
  for (const row of rows) {
    try {
      const record = parsedRecord(row);
      if (seen.has(record.id)) {
        report.duplicateRows++;
        continue;
      }
      seen.add(record.id);
      records.push(record);
      if (object(row) && row.url && record.url === null) unsafeLinks++;
    } catch (error) {
      report.rejectedRows++;
      const reason = error instanceof Error ? error.message : "invalid row";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  report.acceptedRows = records.length;
  for (const [reason, count] of [...reasons].sort(([a], [b]) => order(a, b)))
    report.warnings.push(`${count} rejected: ${reason}.`);
  if (report.duplicateRows)
    report.warnings.push(
      `${report.duplicateRows} duplicate identities skipped; the first record was kept.`,
    );
  if (unsafeLinks)
    report.warnings.push(
      `${unsafeLinks} unsafe or invalid source URLs removed. Their text remains available.`,
    );
  if (!records.length)
    throw new ImportError(
      `No valid records. ${report.rejectedRows} of ${report.inputRows} rows were rejected. ${report.warnings.join(" ")}`,
      report,
    );
  // Canonicalize each tenant/product identity before assigning globally unique labels.
  // A literal product name can itself look like our suffix, so reserve every base name.
  const identities = new Map<string, FeedbackRecord[]>();
  for (const record of records) {
    const key = identity(record.tenant, record.productId);
    const group = identities.get(key) ?? [];
    group.push(record);
    identities.set(key, group);
  }
  const groups = [...identities]
    .sort(([a], [b]) => order(a, b))
    .map(([, rows]) => ({
      rows,
      base: [...new Set(rows.map((row) => row.product))].sort(order)[0],
    }));
  const baseCounts = new Map<string, number>();
  for (const group of groups)
    baseCounts.set(group.base, (baseCounts.get(group.base) ?? 0) + 1);
  const reserved = new Set(groups.map((group) => group.base));
  for (const group of groups) {
    let label = group.base;
    if ((baseCounts.get(group.base) ?? 0) > 1) {
      const first = group.rows[0];
      const prefix = `${group.base} (${first.tenant} / ${first.productId})`;
      label = prefix;
      let suffix = 2;
      while (reserved.has(label)) label = `${prefix} [${suffix++}]`;
      reserved.add(label);
    }
    for (const record of group.rows) record.product = label;
  }
  return {
    label: fileName.slice(0, 160),
    records,
    provenance: "imported",
    importReport: report,
  };
}
export function defaultFilters(product = ""): Scope {
  return {
    product,
    sources: [],
    sentiment: "all",
    from: "",
    to: "",
    query: "",
    excludedThreadIds: [],
  };
}
export function products(dataset: WorkspaceDataset): string[] {
  return [...new Set(dataset.records.map((record) => record.product))].sort(
    order,
  );
}
/** Case-insensitive AND search. A token must occur in original text or thread title. */
function matchesText(record: FeedbackRecord, query: string): boolean {
  const haystack = folded(`${record.text}\n${record.threadTitle}`);
  return folded(query)
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}
export function scopeRecords(
  dataset: WorkspaceDataset,
  scope: Scope,
): FeedbackRecord[] {
  const from = scope.from ? normalizedDate(scope.from) : null;
  const to = scope.to ? normalizedDate(scope.to) : null;
  if (!scope.product || (scope.from && !from) || (scope.to && !to)) return [];
  const start = from ? Date.parse(from) : -Infinity;
  const end = to
    ? Date.parse(to) +
      (/^\d{4}-\d{2}-\d{2}$/u.test(scope.to) ? 86400000 - 1 : 0)
    : Infinity;
  if (start > end) return [];
  const excluded = new Set(scope.excludedThreadIds);
  const sources = new Set(scope.sources);
  return dataset.records.filter((record) => {
    const published =
      record.publishedAt === null ? null : Date.parse(record.publishedAt);
    return (
      record.product === scope.product &&
      (!sources.size || sources.has(record.source)) &&
      (scope.sentiment === "all" || record.sentiment === scope.sentiment) &&
      !excluded.has(record.threadId) &&
      ((!scope.from && !scope.to) ||
        (published !== null && published >= start && published <= end)) &&
      matchesText(record, scope.query)
    );
  });
}
/** Take one record from each source in turn; never compare engagement across platforms. */
export function balancedEvidence(
  records: FeedbackRecord[],
  limit = 4,
): FeedbackRecord[] {
  const groups = new Map<string, FeedbackRecord[]>();
  for (const record of records) {
    const group = groups.get(record.source) ?? [];
    group.push(record);
    groups.set(record.source, group);
  }
  const ordered = [...groups]
    .sort(([a], [b]) => order(a, b))
    .map(([, rows]) =>
      rows.sort(
        (a, b) =>
          order(b.publishedAt ?? "", a.publishedAt ?? "") || order(a.id, b.id),
      ),
    );
  const result: FeedbackRecord[] = [];
  for (let position = 0; result.length < limit; position++) {
    let found = false;
    for (const rows of ordered) {
      if (rows[position] && result.length < limit) {
        result.push(rows[position]);
        found = true;
      }
    }
    if (!found) break;
  }
  return result;
}
export function rankIssues(records: FeedbackRecord[]): RankedIssue[] {
  const eligible = records.filter((record) => record.relevant !== false);
  const byIssue = new Map<string, FeedbackRecord[]>();
  for (const record of eligible)
    for (const issue of new Set(record.issues)) {
      const rows = byIssue.get(issue) ?? [];
      rows.push(record);
      byIssue.set(issue, rows);
    }
  return [...byIssue]
    .map(([name, rows]) => ({
      name,
      count: rows.length,
      share: eligible.length ? (rows.length / eligible.length) * 100 : 0,
      evidence: balancedEvidence(rows),
    }))
    .sort((a, b) => b.count - a.count || order(a.name, b.name));
}
function describeScope(scope: Scope): string {
  return `${scope.product || "no product selected"}; ${scope.sources.length ? [...scope.sources].sort(order).join(", ") : "all sources"}; ${scope.sentiment === "all" ? "all sentiment labels" : `${scope.sentiment} label`}; ${scope.from || "any start date"} to ${scope.to || "any end date"}; ${scope.excludedThreadIds.length} excluded threads${scope.query.trim() ? `; text contains “${scope.query.trim()}”` : ""}`;
}
export function analyze(dataset: WorkspaceDataset, scope: Scope): Analysis {
  const records = scopeRecords(dataset, scope);
  const threads = new Map<
    string,
    { id: string; title: string; count: number }
  >();
  for (const record of records) {
    const thread = threads.get(record.threadId) ?? {
      id: record.threadId,
      title: record.threadTitle,
      count: 0,
    };
    thread.count++;
    threads.set(record.threadId, thread);
  }
  const count = (sentiment: Sentiment) =>
    records.filter((record) => record.sentiment === sentiment).length;
  const unreviewed = records.filter(
    (record) => record.relevant === null,
  ).length;
  const irrelevant = records.filter(
    (record) => record.relevant === false,
  ).length;
  const limitations = [
    dataset.provenance === "synthetic"
      ? "This is authored synthetic feedback. It is not customer research."
      : "Sentiment, complaint, issue, and relevance labels are imported metadata. They were not verified here.",
    "Counts describe the current dataset and scope, not the wider market. Issue rank measures label frequency, not severity.",
    "Source comments use a balanced selection across sources. Engagement is not comparable across platforms.",
  ];
  if (unreviewed)
    limitations.push(
      `${unreviewed} scoped records have no relevance label; their relevance to this product is unverified.`,
    );
  if (irrelevant)
    limitations.push(
      `${irrelevant} records marked irrelevant remain in scope counts but are excluded from issue rankings and answer examples.`,
    );
  if (records.some((record) => record.sentiment === "unknown"))
    limitations.push(
      "Missing sentiment remains unknown. Text keywords do not create labels.",
    );
  if (
    (scope.from || scope.to) &&
    dataset.records.some(
      (record) => record.product === scope.product && !record.publishedAt,
    )
  )
    limitations.push(
      "Records without a publication date are excluded by the date filter.",
    );
  if (
    (scope.from && !normalizedDate(scope.from)) ||
    (scope.to && !normalizedDate(scope.to)) ||
    (scope.from &&
      scope.to &&
      Date.parse(scope.from) >
        Date.parse(scope.to) +
          (/^\d{4}-\d{2}-\d{2}$/u.test(scope.to) ? 86400000 - 1 : 0))
  )
    limitations.push("The date range is invalid. No records are shown.");
  return {
    records,
    metrics: {
      totalRecords: dataset.records.length,
      scopedRecords: records.length,
      sourceCount: new Set(records.map((record) => record.source)).size,
      threadCount: threads.size,
      complaints: records.filter((record) => record.isComplaint === true)
        .length,
      unlabeled: count("unknown"),
      irrelevant,
      positive: count("positive"),
      negative: count("negative"),
      neutral: count("neutral"),
      mixed: count("mixed"),
    },
    issues: rankIssues(records),
    threads: [...threads.values()].sort(
      (a, b) => b.count - a.count || order(a.id, b.id),
    ),
    limitations,
    scopeDescription: describeScope(scope),
  };
}
export const analyzeScope = analyze;
const questionStop = new Set(
  "a an and are about at be can could do does for from give how i in is it me most of on or our please show some tell that the their them these this to us was we what which with you your feedback comments evidence people say said think product products overview summary summarize positive opposing counter counterexamples challenge praise like works well top biggest main worst complaint complaints dislike pain problem problems issue issues finding findings".split(
    " ",
  ),
);
function questionTerms(question: string, analysis: Analysis): string[] {
  const productWords = new Set(
    analysis.records.flatMap(
      (record) => folded(record.product).match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  );
  return [
    ...new Set(
      (folded(question).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (term) => !questionStop.has(term) && !productWords.has(term),
      ),
    ),
  ];
}
function questionMatch(record: FeedbackRecord, terms: string[]): boolean {
  const haystack = folded(
    `${record.text}\n${record.threadTitle}\n${record.issues.join(" ")}`,
  );
  return terms.every((term) => haystack.includes(term));
}
export function searchEvidence(
  analysis: Analysis,
  question: string,
): EvidenceAnswer {
  const eligible = analysis.records.filter(
    (record) => record.relevant !== false,
  );
  const limitations = [
    ...analysis.limitations,
    "This is deterministic evidence search, not an AI answer. Source labels and lexical matches are not independently verified.",
  ];
  const suffix = ` Scope: ${analysis.scopeDescription}.`;
  const result = (
    kind: EvidenceAnswer["kind"],
    text: string,
    rows: FeedbackRecord[] = [],
  ): EvidenceAnswer => ({
    kind,
    text: text + suffix,
    citations: balancedEvidence(rows, 4),
    limitations,
  });
  if (!eligible.length)
    return result(
      "empty",
      "No eligible source comments match the current scope. Change a filter or import records; no conclusion is available.",
    );
  const lower = folded(question);
  const terms = questionTerms(question, analysis);
  const matchedIssue = analysis.issues.find((issue) =>
    lower.includes(folded(issue.name)),
  );
  if (
    /\b(positive|opposing|counter(?:examples)?|challenge|praise)\b/u.test(
      lower,
    ) ||
    /\bworks well\b/u.test(lower)
  ) {
    const rows = eligible.filter(
      (record) =>
        record.sentiment === "positive" && questionMatch(record, terms),
    );
    if (!rows.length)
      return result(
        "empty",
        "No comments with a supplied positive label match this question in the current scope. This absence does not confirm a negative conclusion.",
      );
    return result(
      "positive",
      `${rows.length} comments carry a positive label and match this request. They provide a different view to inspect, but do not prove that a specific complaint is false.`,
      rows,
    );
  }
  const issueTerms: string[] = matchedIssue
    ? (folded(matchedIssue.name).match(/[\p{L}\p{N}]+/gu) ?? [])
    : [];
  const issueOnlyQuestion =
    matchedIssue && terms.every((term) => issueTerms.includes(term));
  if (
    issueOnlyQuestion ||
    (!terms.length &&
      /\b(top|biggest|main|worst|complaints?|dislike|pain|problems?|issues?)\b/u.test(
        lower,
      ))
  ) {
    const issue = matchedIssue ?? analysis.issues[0];
    if (!issue)
      return result(
        "empty",
        "No issue labels are supplied in this scope. Original text remains searchable, but there is no labelled issue ranking.",
      );
    const rows = eligible.filter((record) =>
      record.issues.includes(issue.name),
    );
    return result(
      "issue",
      `“${issue.name}” appears on ${issue.count} records (${issue.share.toFixed(1)}% of records not marked irrelevant). This is supplied label frequency, not a measure of severity or verified complaints. Read the original comments below.`,
      rows,
    );
  }
  if (!terms.length)
    return result(
      "overview",
      `${analysis.metrics.scopedRecords} records are in scope across ${analysis.metrics.sourceCount} sources and ${analysis.metrics.threadCount} threads. Supplied labels mark ${analysis.metrics.negative} negative, ${analysis.metrics.positive} positive, and ${analysis.metrics.complaints} complaints; ${analysis.metrics.unlabeled} have unknown sentiment.`,
      eligible,
    );
  const rows = eligible.filter((record) => questionMatch(record, terms));
  if (!rows.length)
    return result(
      "empty",
      `No eligible comments match all search terms: ${terms.join(", ")}. This is a lexical search result, not proof that the problem does not exist.`,
    );
  return result(
    "search",
    `${rows.length} comments match all search terms: ${terms.join(", ")}. Matches use original text, thread titles, and supplied issue labels. Read the comments before drawing a conclusion.`,
    rows,
  );
}
export const answerQuestion = searchEvidence;
function markdownText(text: string): string {
  return text.replace(/([\\`*_{}[\]<>#!|])/gu, "\\$1");
}
export function brief(
  dataset: WorkspaceDataset,
  scope: Scope,
  _analysis?: Analysis,
): string {
  // Recompute to prevent an old UI result from exporting evidence from a different scope.
  const analysis = analyze(dataset, scope);
  const evidence = balancedEvidence(
    analysis.records.filter((record) => record.relevant !== false),
    8,
  );
  const lines = [
    "# Feedback decision brief",
    "",
    `Dataset: ${markdownText(dataset.label)} (${dataset.provenance}).`,
    "",
    `Scope: ${markdownText(analysis.scopeDescription)}.`,
    "",
    `Records: ${analysis.metrics.scopedRecords} of ${analysis.metrics.totalRecords}. Sources: ${analysis.metrics.sourceCount}. Threads: ${analysis.metrics.threadCount}.`,
    `Supplied sentiment labels: ${analysis.metrics.negative} negative; ${analysis.metrics.positive} positive; ${analysis.metrics.neutral} neutral; ${analysis.metrics.mixed} mixed; ${analysis.metrics.unlabeled} unknown.`,
    `Supplied complaint labels: ${analysis.metrics.complaints}. Explicitly irrelevant: ${analysis.metrics.irrelevant}.`,
    "",
    "## Supplied issue labels",
    "",
    ...analysis.issues.map(
      (issue) =>
        `- ${markdownText(issue.name)}: ${issue.count} records (${issue.share.toFixed(1)}% of records not marked irrelevant).`,
    ),
    ...(analysis.issues.length ? [] : ["No issue labels in this scope."]),
    "",
    "## Original source comments",
    "",
  ];
  for (const [index, record] of evidence.entries()) {
    lines.push(
      `### ${index + 1}. ${markdownText(record.source)} · ${markdownText(record.threadTitle)}`,
      "",
      `Provenance: ${record.provenance}. Publication date: ${record.publishedAt ?? "unknown"}. Supplied sentiment: ${record.sentiment}.`,
      "",
      ...record.text.split(/\r?\n/u).map((line) => `> ${markdownText(line)}`),
      "",
    );
    if (record.url)
      lines.push(
        `[Open original](${record.url.replace(/[()]/gu, (char) => (char === "(" ? "%28" : "%29"))})`,
        "",
      );
    else lines.push("No public original URL supplied.", "");
  }
  if (!evidence.length)
    lines.push("No eligible comments in the current scope.", "");
  lines.push(
    "## Limits",
    "",
    ...analysis.limitations.map((limit) => `- ${markdownText(limit)}`),
    "- No network collection or model call was used to build this brief.",
    "",
  );
  return lines.join("\n");
}
export const buildBrief = brief;
