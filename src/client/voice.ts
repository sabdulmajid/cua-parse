import type {
  EvidencePacket,
  Filters,
  QueryInput,
  ResearchJob,
} from "../shared/contracts";
import { querySchema } from "../shared/contracts";

export const emptyFilters: Filters = {
  excludedThreadIds: [],
  aspect: null,
  source: null,
  from: null,
  to: null,
};
export type ToolParameters = Record<string, unknown>;

export function queryFromTool(
  parameters: ToolParameters,
  job: ResearchJob | null,
  filters: Filters,
  requestId: string,
  activeQuery?: QueryInput | null,
): QueryInput {
  if (!job) throw new Error("Start research before asking for findings.");
  if (parameters.researchId && parameters.researchId !== job.id)
    throw new Error("That research is not the active research.");
  const next = {
    ...filters,
    excludedThreadIds: [...filters.excludedThreadIds],
  };
  for (const key of ["aspect", "source", "from", "to"] as const) {
    if (Object.hasOwn(parameters, key))
      (next as Record<string, unknown>)[key] =
        parameters[key] === "" ? null : parameters[key];
  }
  if (Array.isArray(parameters.excludedThreadIds))
    next.excludedThreadIds = parameters.excludedThreadIds as string[];
  if (
    typeof parameters.excludeThreadId === "string" &&
    parameters.excludeThreadId
  )
    next.excludedThreadIds = [
      ...new Set([...next.excludedThreadIds, parameters.excludeThreadId]),
    ];
  const sameQuestion =
    parameters.question === undefined ||
    parameters.question === activeQuery?.question;
  return querySchema.parse({
    researchId: job.id,
    question: parameters.question ?? activeQuery?.question ?? job.question,
    filters: next,
    challenge:
      parameters.challenge ??
      (sameQuestion ? activeQuery?.challenge : false) ??
      false,
    challengeSentiment:
      parameters.challengeSentiment ??
      activeQuery?.challengeSentiment ??
      "negative",
    requestId,
  });
}

export function isCurrentPacket(
  packet: EvidencePacket,
  researchId: string | undefined,
  requestId: string,
  generation: number,
  currentGeneration: number,
): boolean {
  return (
    packet.researchId === researchId &&
    packet.requestId === requestId &&
    generation === currentGeneration
  );
}

export function safeEvidenceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      [...value].some(
        (character) => character.charCodeAt(0) <= 32 || character === "\\",
      ) ||
      !host.includes(".") ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      /^[\d.]+$/.test(host) ||
      host.includes(":")
    )
      return null;
    url.hostname = host;
    return url.href;
  } catch {
    return null;
  }
}

export function microphoneError(error: unknown): string {
  if (
    error instanceof Error &&
    ["NotAllowedError", "PermissionDeniedError"].includes(error.name)
  )
    return "Microphone access was denied. Allow microphone access in this browser, then reconnect. You can still type below.";
  if (error instanceof Error && error.name === "NotFoundError")
    return "No microphone was found. Connect a microphone or use typed research.";
  return "Voice could not connect. Check your connection and voice setup, then reconnect. Typed research is available.";
}

export async function checkMicrophone(
  media: Pick<MediaDevices, "getUserMedia"> | undefined,
): Promise<void> {
  if (!media)
    throw new Error("Microphone access is unavailable in this browser.");
  const stream = await media.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

/** Owns one pending voice connection. Stop invalidates every later callback. */
export class VoiceAttempts {
  private generation = 0;
  private controller: AbortController | null = null;

  begin() {
    this.cancel();
    this.controller = new AbortController();
    return this.capture();
  }

  capture() {
    const generation = this.generation;
    const controller = this.controller;
    return {
      signal: controller?.signal,
      isCurrent: () =>
        controller !== null &&
        !controller.signal.aborted &&
        generation === this.generation,
    };
  }

  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
}

export type ConversationMode = "text" | "voice";
export function conversationOptions(signedUrl: string, mode: ConversationMode) {
  const textOnly = mode === "text";
  return {
    signedUrl,
    connectionType: "websocket" as const,
    textOnly,
    overrides: { conversation: { textOnly } },
  };
}

/** Text mode never requests microphone permission or opens an audio stream. */
export async function prepareConversation(
  mode: ConversationMode,
  media: Pick<MediaDevices, "getUserMedia"> | undefined,
  request: (
    mode: ConversationMode,
    signal?: AbortSignal,
  ) => Promise<{ signedUrl: string; leaseId: string }>,
  attempt: ReturnType<VoiceAttempts["capture"]>,
) {
  if (mode === "voice") await checkMicrophone(media);
  if (!attempt.isCurrent())
    throw new DOMException("Connection cancelled.", "AbortError");
  const session = await request(mode, attempt.signal);
  if (!attempt.isCurrent())
    throw new DOMException("Connection cancelled.", "AbortError");
  return {
    leaseId: session.leaseId,
    options: conversationOptions(session.signedUrl, mode),
  };
}

export type ResearchAnswer = {
  researchId: string;
  conversationId: string;
  question: string;
};
/** Claims one completion turn; manual reads and automatic completion share it. */
export class ResearchAnswers {
  private version = 0;
  private target:
    | (ResearchAnswer & {
        automaticUsed: boolean;
        pending: boolean;
        queried: boolean;
      })
    | null = null;

  arm(target: ResearchAnswer) {
    this.version++;
    this.target = {
      ...target,
      automaticUsed: false,
      pending: false,
      queried: false,
    };
  }
  cancel() {
    this.version++;
    this.target = null;
  }
  matches(researchId: string, conversationId: string) {
    return (
      this.target?.researchId === researchId &&
      this.target.conversationId === conversationId
    );
  }
  claim(
    researchId: string,
    conversationId: string,
    source: "automatic" | "manual",
  ) {
    const target = this.target;
    if (
      !target ||
      !this.matches(researchId, conversationId) ||
      target.pending ||
      (source === "automatic" && target.automaticUsed)
    )
      return null;
    target.automaticUsed = true;
    target.pending = true;
    target.queried = false;
    const version = this.version;
    return {
      ...target,
      isCurrent: () => version === this.version && this.target === target,
    };
  }
  observeQuery(researchId: string, conversationId: string) {
    if (!this.matches(researchId, conversationId) || !this.target) return false;
    this.target.automaticUsed = true;
    this.target.pending = true;
    this.target.queried = true;
    return true;
  }
  answerArrived(researchId: string, conversationId: string) {
    if (
      !this.matches(researchId, conversationId) ||
      !this.target?.pending ||
      !this.target.queried
    )
      return false;
    this.target.pending = false;
    return true;
  }
  fail(researchId: string, conversationId: string) {
    if (this.matches(researchId, conversationId) && this.target)
      this.target.pending = false;
  }
}

/** Keep a later user-selected scope when an earlier completion turn returns. */
export function currentScopeParameters(
  parameters: ToolParameters,
  current: QueryInput,
): ToolParameters {
  return {
    ...parameters,
    question: current.question,
    challenge: current.challenge,
    challengeSentiment: current.challengeSentiment,
    aspect: current.filters.aspect,
    source: current.filters.source,
    from: current.filters.from,
    to: current.filters.to,
    excludedThreadIds: current.filters.excludedThreadIds,
    excludeThreadId: undefined,
  };
}

/** Only verified, relevant originals may support claims in the conversation. */
export function agentEvidencePacket(packet: EvidencePacket): EvidencePacket {
  const permitted = (record: EvidencePacket["evidence"][number]) =>
    record.relevant && record.extractionStatus === "verified";
  const evidence = packet.evidence.filter(permitted);
  const opposingEvidence = packet.opposingEvidence.filter(permitted);
  const permittedIds = new Set(
    [...evidence, ...opposingEvidence].map((record) => record.id),
  );
  const findings = packet.findings.filter(
    (finding) =>
      finding.evidenceIds.length > 0 &&
      finding.evidenceIds.every((id) => permittedIds.has(id)),
  );
  const retrieved = [
    ...new Map(
      [...packet.evidence, ...packet.opposingEvidence].map((record) => [
        record.id,
        record,
      ]),
    ).values(),
  ];
  const unverified = retrieved.filter(
    (record) => record.extractionStatus !== "verified",
  ).length;
  const irrelevant = retrieved.filter(
    (record) => record.extractionStatus === "verified" && !record.relevant,
  ).length;
  const limitations = [...packet.limitations];
  if (unverified || irrelevant)
    limitations.push(
      `Among the retrieved examples, ${unverified} unverified records and ${irrelevant} verified but irrelevant records were withheld from the conversation. They remain available for inspection in the interface. Full-scope counts are unchanged.`,
    );
  const summaryNeedsReplacement =
    findings.length !== packet.findings.length || permittedIds.size === 0;
  const spokenSummary = summaryNeedsReplacement
    ? findings.length
      ? findings.map((finding) => finding.text).join(" ")
      : "No verified, relevant cited findings are available to answer this question. The sample is insufficient for a substantive conclusion."
    : packet.spokenSummary;
  return {
    ...packet,
    evidence,
    opposingEvidence,
    findings,
    limitations,
    spokenSummary,
  };
}
