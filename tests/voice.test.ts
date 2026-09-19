import { describe, expect, it, vi } from "vitest";
import {
  checkMicrophone,
  conversationOptions,
  prepareConversation,
  emptyFilters,
  isCurrentPacket,
  microphoneError,
  queryFromTool,
  safeEvidenceUrl,
  VoiceAttempts,
  ResearchAnswers,
  currentScopeParameters,
  agentEvidencePacket,
} from "../src/client/voice";
import type {
  EvidencePacket,
  EvidenceRecord,
  ResearchJob,
} from "../src/shared/contracts";
const job = {
  id: "26d6a6db-cb82-4f81-a9ea-c2ab03e34712",
  question: "What about pricing?",
} as ResearchJob;

describe("voice tool scope bridge", () => {
  it("carries active filters into flat voice calls and adds a real thread exclusion", () => {
    const query = queryFromTool(
      { excludeThreadId: "large-thread", challenge: true },
      job,
      { ...emptyFilters, aspect: "pricing" },
      "request-2",
    );
    expect(query.filters.aspect).toBe("pricing");
    expect(query.filters.excludedThreadIds).toEqual(["large-thread"]);
    expect(query.challenge).toBe(true);
    expect(query.researchId).toBe(job.id);
  });
  it("does not accept an unrelated active research ID", () => {
    expect(() =>
      queryFromTool({ researchId: "another-session" }, job, emptyFilters, "id"),
    ).toThrow("not the active");
    expect(() => queryFromTool({}, null, emptyFilters, "id")).toThrow(
      "Start research",
    );
  });
  it("validates unknown aspects and malformed dates", () => {
    expect(() =>
      queryFromTool({ aspect: "invented" }, job, emptyFilters, "id"),
    ).toThrow();
    expect(() =>
      queryFromTool({ from: "yesterday" }, job, emptyFilters, "id"),
    ).toThrow();
  });
  it("rejects late results from an earlier scope or research", () => {
    const packet = { researchId: job.id, requestId: "r1" } as EvidencePacket;
    expect(isCurrentPacket(packet, job.id, "r1", 2, 2)).toBe(true);
    expect(isCurrentPacket(packet, job.id, "r1", 1, 2)).toBe(false);
    expect(isCurrentPacket(packet, "another-session", "r1", 2, 2)).toBe(false);
    expect(isCurrentPacket(packet, job.id, "r2", 2, 2)).toBe(false);
  });
});

describe("voice permission handling", () => {
  it("releases the permission-check microphone stream", async () => {
    const stop = vi.fn();
    const getUserMedia = vi
      .fn()
      .mockResolvedValue({ getTracks: () => [{ stop }] });
    await checkMicrophone({ getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledOnce();
  });
  it("handles denied microphone access with typed fallback", async () => {
    const error = new Error("Permission denied");
    error.name = "NotAllowedError";
    await expect(
      checkMicrophone({ getUserMedia: vi.fn().mockRejectedValue(error) }),
    ).rejects.toThrow("Permission denied");
    expect(microphoneError(error)).toContain("You can still type");
  });
  it("handles a missing device and connection failures", () => {
    const error = new Error();
    error.name = "NotFoundError";
    expect(microphoneError(error)).toContain("No microphone");
    expect(microphoneError(new Error("network"))).toContain("reconnect");
  });
});

describe("original source links", () => {
  it("allows public source links and rejects unsafe destinations", () => {
    expect(safeEvidenceUrl("https://news.ycombinator.com/item?id=123")).toBe(
      "https://news.ycombinator.com/item?id=123",
    );
    for (const value of [
      null,
      "javascript:alert(1)",
      "http://localhost:3000/",
      "http://127.0.0.1/a",
      "https://secret@evil.example/a",
      "http://192.168.1.1/",
      "https://internal.local/",
    ])
      expect(safeEvidenceUrl(value)).toBeNull();
  });
});

describe("voice connection cancellation", () => {
  it("aborts pending token and binding requests when Stop is selected", () => {
    const attempts = new VoiceAttempts();
    const pendingToken = attempts.begin();
    const pendingBinding = attempts.capture();
    attempts.cancel();
    expect(pendingToken.signal?.aborted).toBe(true);
    expect(pendingToken.isCurrent()).toBe(false);
    expect(pendingBinding.isCurrent()).toBe(false);
  });
  it("does not let a previous connection restore state after reconnect", async () => {
    const attempts = new VoiceAttempts();
    const old = attempts.begin();
    const next = attempts.begin();
    let active = "";
    const finish = async () => {
      await Promise.resolve();
      if (old.isCurrent()) active = "old";
    };
    await finish();
    expect(active).toBe("");
    expect(old.signal?.aborted).toBe(true);
    expect(next.isCurrent()).toBe(true);
  });
});

describe("active challenge preservation", () => {
  it("keeps the last question and positive challenge direction unless explicitly changed", () => {
    const active = queryFromTool(
      {
        question: "How strong is support praise?",
        challenge: true,
        challengeSentiment: "positive",
      },
      job,
      emptyFilters,
      "first",
    );
    const next = queryFromTool({}, job, emptyFilters, "second", active);
    expect(next.question).toBe(active.question);
    expect(next.challenge).toBe(true);
    expect(next.challengeSentiment).toBe("positive");
    const reset = queryFromTool(
      { challenge: false, challengeSentiment: "negative" },
      job,
      emptyFilters,
      "third",
      active,
    );
    expect(reset.challenge).toBe(false);
    expect(reset.challengeSentiment).toBe("negative");
  });
});

describe("real text conversation setup", () => {
  it("uses signed WebSocket credentials with both text-only flags", () => {
    expect(conversationOptions("wss://signed.example/session", "text")).toEqual(
      {
        signedUrl: "wss://signed.example/session",
        connectionType: "websocket",
        textOnly: true,
        overrides: { conversation: { textOnly: true } },
      },
    );
    expect(
      conversationOptions("wss://signed.example/session", "voice").textOnly,
    ).toBe(false);
  });
  it("connects text without requesting a microphone, including when no media API exists", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new Error("must not be called"));
    const request = vi.fn().mockResolvedValue({
      signedUrl: "wss://signed.example/session",
      leaseId: "lease",
    });
    const attempts = new VoiceAttempts();
    const result = await prepareConversation(
      "text",
      { getUserMedia },
      request,
      attempts.begin(),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.options.textOnly).toBe(true);
    await expect(
      prepareConversation("text", undefined, request, attempts.begin()),
    ).resolves.toHaveProperty("leaseId", "lease");
  });
  it("checks microphone permission before requesting a voice session", async () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    const request = vi.fn();
    await expect(
      prepareConversation(
        "voice",
        { getUserMedia: vi.fn().mockRejectedValue(denied) },
        request,
        new VoiceAttempts().begin(),
      ),
    ).rejects.toThrow("Permission denied");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects late signed credentials after Stop", async () => {
    const attempts = new VoiceAttempts();
    const pending = prepareConversation(
      "text",
      undefined,
      async () => {
        attempts.cancel();
        return { signedUrl: "wss://signed.example/session", leaseId: "lease" };
      },
      attempts.begin(),
    );
    await expect(pending).rejects.toThrow("Connection cancelled");
  });
});

describe("research completion answers", () => {
  const research = {
    researchId: job.id,
    conversationId: "conversation-1",
    question: "What sucks about Microsoft Team?",
  };
  it("claims a completion turn once even if Ready is observed repeatedly", () => {
    const answers = new ResearchAnswers();
    answers.arm(research);
    expect(
      answers.claim(job.id, research.conversationId, "automatic"),
    ).not.toBeNull();
    expect(
      answers.claim(job.id, research.conversationId, "automatic"),
    ).toBeNull();
    answers.observeQuery(job.id, research.conversationId);
    expect(answers.answerArrived(job.id, research.conversationId)).toBe(true);
    expect(
      answers.claim(job.id, research.conversationId, "automatic"),
    ).toBeNull();
  });
  it("lets manual Read win the completion race without a second automatic answer", () => {
    const answers = new ResearchAnswers();
    answers.arm(research);
    expect(
      answers.claim(job.id, research.conversationId, "manual"),
    ).not.toBeNull();
    expect(
      answers.claim(job.id, research.conversationId, "automatic"),
    ).toBeNull();
    expect(answers.claim(job.id, research.conversationId, "manual")).toBeNull();
  });
  it("does not treat an acknowledgement as the answer before evidence is queried", () => {
    const answers = new ResearchAnswers();
    answers.arm(research);
    answers.claim(job.id, research.conversationId, "automatic");
    expect(answers.answerArrived(job.id, research.conversationId)).toBe(false);
    expect(answers.observeQuery(job.id, "other-conversation")).toBe(false);
    answers.observeQuery(job.id, research.conversationId);
    expect(answers.answerArrived(job.id, research.conversationId)).toBe(true);
  });
  it("cancels late completion turns when research or conversation changes", () => {
    const answers = new ResearchAnswers();
    answers.arm(research);
    const previous = answers.claim(
      job.id,
      research.conversationId,
      "automatic",
    )!;
    answers.arm({ ...research, researchId: "new-research" });
    expect(previous.isCurrent()).toBe(false);
    expect(
      answers.claim(job.id, research.conversationId, "automatic"),
    ).toBeNull();
    const active = answers.claim(
      "new-research",
      research.conversationId,
      "automatic",
    )!;
    answers.cancel();
    expect(active.isCurrent()).toBe(false);
    expect(
      answers.claim("new-research", research.conversationId, "automatic"),
    ).toBeNull();
  });
  it("allows explicit retry after failure without retrying the automatic turn", () => {
    const answers = new ResearchAnswers();
    answers.arm(research);
    answers.claim(job.id, research.conversationId, "automatic");
    answers.fail(job.id, research.conversationId);
    expect(
      answers.claim(job.id, research.conversationId, "automatic"),
    ).toBeNull();
    expect(
      answers.claim(job.id, research.conversationId, "manual"),
    ).not.toBeNull();
  });
  it("uses an agent query already in progress instead of sending a duplicate turn", () => {
    const answers = new ResearchAnswers();
    answers.arm(research);
    answers.observeQuery(job.id, research.conversationId);
    expect(
      answers.claim(job.id, research.conversationId, "automatic"),
    ).toBeNull();
  });
});

describe("primary question intent", () => {
  it("does not turn a negative question into a challenge", () => {
    const input = queryFromTool(
      { question: "What sucks about Microsoft Team?" },
      job,
      emptyFilters,
      "question-1",
    );
    expect(input.challenge).toBe(false);
  });
  it("resets an inherited challenge for a different question while keeping explicit challenges", () => {
    const old = queryFromTool(
      { question: "Find opposing evidence", challenge: true },
      job,
      emptyFilters,
      "old",
    );
    expect(
      queryFromTool(
        { question: "What sucks about Microsoft Team?" },
        job,
        emptyFilters,
        "new",
        old,
      ).challenge,
    ).toBe(false);
    expect(
      queryFromTool(
        { question: "What contradicts that finding?", challenge: true },
        job,
        emptyFilters,
        "explicit",
        old,
      ).challenge,
    ).toBe(true);
    expect(
      queryFromTool(
        { excludeThreadId: "large-thread" },
        job,
        emptyFilters,
        "same-question",
        old,
      ).challenge,
    ).toBe(true);
  });
});

describe("scope changes during automatic completion", () => {
  it("keeps a later explicit challenge and exclusion when the earlier completion returns", () => {
    const current = queryFromTool(
      {
        question: "Which claims are contradicted?",
        challenge: true,
        challengeSentiment: "positive",
        excludeThreadId: "large-thread",
        aspect: "pricing",
      },
      job,
      emptyFilters,
      "later",
    );
    const parameters = currentScopeParameters(
      {
        question: "What sucks about Microsoft Team?",
        challenge: false,
        excludeThreadId: "old-thread",
      },
      current,
    );
    const result = queryFromTool(parameters, job, emptyFilters, "completion");
    expect(result.question).toBe(current.question);
    expect(result.challenge).toBe(true);
    expect(result.challengeSentiment).toBe("positive");
    expect(result.filters.excludedThreadIds).toEqual(["large-thread"]);
    expect(result.filters.aspect).toBe("pricing");
  });
});

describe("agent evidence boundary", () => {
  const record = (
    id: string,
    relevant: boolean,
    extractionStatus: EvidenceRecord["extractionStatus"],
  ): EvidenceRecord => ({
    id,
    relevant,
    extractionStatus,
    text: "The verified price is too high.",
    url: null,
    threadId: "thread-1",
    threadTitle: "Synthetic discussion",
    parentId: null,
    publishedAt: null,
    collectedAt: "2026-09-19T00:00:00.000Z",
    source: "fixture",
    provenance: "synthetic",
    researchId: job.id,
    sessionId: "session",
    snapshotVersion: 1,
    contentHash: id,
    productIdentity: relevant ? "match" : "other",
    aspects:
      extractionStatus === "verified"
        ? [
            {
              aspect: "pricing",
              sentiment: "negative",
              quote: "The verified price is too high.",
            },
          ]
        : [],
    analysisVersion: "test",
    contextualText: "Original source text.",
  });
  const packet = (): EvidencePacket => ({
    researchId: job.id,
    snapshotVersion: 1,
    scopeVersion: "scope-1",
    requestId: "request-1",
    question: "What are the problems?",
    filters: { ...emptyFilters },
    challenge: false,
    retrievalMode: "bm25",
    provenance: ["synthetic"],
    generatedAt: "2026-09-19T00:00:00.000Z",
    metrics: {
      collectedRecords: 4,
      scopedRecords: 4,
      relevantRecords: 3,
      distinctThreads: 1,
      aspectMentions: 1,
      aspects: [],
      threads: [],
    },
    findings: [
      {
        id: "valid",
        aspect: "pricing",
        text: "The verified price is too high.",
        evidenceIds: ["verified"],
      },
      {
        id: "failed",
        aspect: "reliability",
        text: "Unverified Linux claim.",
        evidenceIds: ["failed"],
      },
      {
        id: "mixed",
        aspect: "support",
        text: "Partly unverified claim.",
        evidenceIds: ["verified", "unlabeled"],
      },
      {
        id: "irrelevant",
        aspect: "other",
        text: "Another product claim.",
        evidenceIds: ["irrelevant"],
      },
      { id: "uncited", aspect: "other", text: "No citation.", evidenceIds: [] },
    ],
    evidence: [
      record("verified", true, "verified"),
      record("failed", true, "failed"),
      record("unlabeled", true, "unlabeled"),
      record("irrelevant", false, "verified"),
    ],
    opposingEvidence: [
      record("failed", true, "failed"),
      record("verified", true, "verified"),
    ],
    limitations: ["Synthetic sample; not real customers."],
    spokenSummary: "Unverified Linux claim.",
  });
  it("excludes failed, unlabeled, and irrelevant originals and unsupported findings without changing scope or counts", () => {
    const original = packet();
    const result = agentEvidencePacket(original);
    expect(result.evidence.map((item) => item.id)).toEqual(["verified"]);
    expect(result.opposingEvidence.map((item) => item.id)).toEqual([
      "verified",
    ]);
    expect(result.findings.map((item) => item.id)).toEqual(["valid"]);
    expect(result.metrics).toBe(original.metrics);
    expect(result.filters).toBe(original.filters);
    expect(result.researchId).toBe(original.researchId);
    expect(result.snapshotVersion).toBe(original.snapshotVersion);
    expect(result.scopeVersion).toBe(original.scopeVersion);
    expect(result.requestId).toBe(original.requestId);
    expect(result.spokenSummary).toBe("The verified price is too high.");
    expect(result.limitations).toContain(original.limitations[0]);
    expect(result.limitations.at(-1)).toContain(
      "2 unverified records and 1 verified but irrelevant records",
    );
    expect(original.evidence).toHaveLength(4);
    expect(original.findings).toHaveLength(5);
    expect(original.spokenSummary).toBe("Unverified Linux claim.");
    expect(original.limitations).toHaveLength(1);
  });
  it("returns explicit insufficiency rather than leaving unsupported claims in the spoken summary", () => {
    const input = packet();
    input.evidence = input.evidence.filter((item) => item.id !== "verified");
    input.opposingEvidence = [];
    const result = agentEvidencePacket(input);
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.spokenSummary).toContain(
      "No verified, relevant cited findings",
    );
    expect(result.spokenSummary).not.toContain("Linux");
    expect(result.metrics).toEqual(input.metrics);
  });
  it("preserves a fully supported summary and counts duplicated originals only once in limitations", () => {
    const input = packet();
    input.findings = [input.findings[0]];
    input.spokenSummary = "One verified record criticizes pricing.";
    const result = agentEvidencePacket(input);
    expect(result.spokenSummary).toBe(input.spokenSummary);
    expect(result.limitations.at(-1)).toContain("2 unverified records");
  });
});

describe("source URL normalization", () => {
  it.each([
    "http://localhost./secret",
    "https://host.internal./secret",
    "http://127.0.0.1./secret",
    "https://example.com:8443/path",
    "https://example.com/\\path",
  ])("rejects local or unsafe reference %s", (value) => {
    expect(safeEvidenceUrl(value)).toBeNull();
  });
  it("normalizes a public trailing-dot hostname", () => {
    expect(safeEvidenceUrl("https://example.com./source")).toBe(
      "https://example.com/source",
    );
  });
});
