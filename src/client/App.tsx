import { useCallback, useEffect, useRef, useState } from "react";
import { useConversation, useConversationClientTool } from "@elevenlabs/react";
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FlaskConical,
  Headphones,
  Layers3,
  LoaderCircle,
  Mic,
  MicOff,
  Plus,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { Aspects, rawRecordSchema } from "../shared/contracts";
import type {
  DecisionBrief,
  EvidencePacket,
  EvidenceRecord,
  Filters,
  QueryInput,
  RawRecord,
  ResearchJob,
  SessionResponse,
  StartInput,
} from "../shared/contracts";
import {
  emptyFilters,
  isCurrentPacket,
  microphoneError,
  prepareConversation,
  queryFromTool,
  safeEvidenceUrl,
  VoiceAttempts,
  ResearchAnswers,
  currentScopeParameters,
  agentEvidencePacket,
} from "./voice";
import type { ConversationMode, ToolParameters } from "./voice";
import ElasticResearch from "./ElasticResearch";

const DEMO_QUESTION =
  "What do people dislike about AcmeFlow, especially its pricing and onboarding?";
const terminal = new Set(["ready", "failed", "cancelled"]);
type Turn = { id: string; role: "user" | "agent" | "action"; text: string };
type PendingTurn = {
  text: string;
  label?: string;
  answerResearchId?: string;
  automatic?: boolean;
};
const titleCase = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";
const dateLabel = (date: string | null) =>
  date
    ? new Date(date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Date not supplied";

function downloadBrief(brief: DecisionBrief) {
  const url = URL.createObjectURL(
    new Blob([brief.markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = brief.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const sessionRef = useRef<SessionResponse | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [prompt, setPrompt] = useState(
    () => sessionStorage.getItem("cua-unsent-prompt") ?? "",
  );
  const [elasticMode, setElasticMode] = useState(
    () => sessionStorage.getItem("cua-research-source") === "elastic",
  );
  const [elasticKey, setElasticKey] = useState(0);
  const [elasticHasContent, setElasticHasContent] = useState(false);
  const [mode, setMode] = useState<StartInput["mode"]>("live");
  const modeRef = useRef<StartInput["mode"]>("live");
  const [job, setJob] = useState<ResearchJob | null>(null);
  const jobRef = useRef<ResearchJob | null>(null);
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [packet, setPacket] = useState<EvidencePacket | null>(null);
  const packetRef = useRef<EvidencePacket | null>(null);
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters });
  const filtersRef = useRef<Filters>({ ...emptyFilters });
  const lastQueryRef = useRef<QueryInput | null>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectionRecovery, setConnectionRecovery] = useState(false);
  const [bound, setBound] = useState(false);
  const [connectionMode, setConnectionMode] =
    useState<ConversationMode>("text");
  const [conversationEvent, setConversationEvent] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [toolStatus, setToolStatus] = useState("");
  const answers = useRef(new ResearchAnswers());
  const scopeIntent = useRef(0);
  const answerScope = useRef<{ researchId: string; revision: number } | null>(
    null,
  );
  const [answerPending, setAnswerPending] = useState<string | null>(null);
  const answerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendTurnRef = useRef<(turn: PendingTurn) => boolean>(() => false);
  const attempts = useRef(new VoiceAttempts());
  const leaseRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const bindingRef = useRef<Promise<string> | null>(null);
  const pendingTurn = useRef<PendingTurn | null>(null);
  const sentEchoes = useRef<Array<{ text: string; time: number }>>([]);
  const connectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const evidenceRef = useRef<HTMLDetailsElement>(null);
  const [records, setRecords] = useState<RawRecord[] | undefined>();
  const [importName, setImportName] = useState("");
  const [importProduct, setImportProduct] = useState("");
  const [importQuestion, setImportQuestion] = useState(
    "What are the main strengths and problems in this feedback?",
  );

  const cancelAnswer = useCallback(() => {
    answers.current.cancel();
    answerScope.current = null;
    setAnswerPending(null);
    if (answerTimer.current) clearTimeout(answerTimer.current);
  }, []);
  const waitForAnswer = useCallback(
    (ticket: NonNullable<ReturnType<ResearchAnswers["claim"]>>) => {
      setAnswerPending(ticket.researchId);
      answerScope.current = {
        researchId: ticket.researchId,
        revision: scopeIntent.current,
      };
      if (answerTimer.current) clearTimeout(answerTimer.current);
      answerTimer.current = setTimeout(() => {
        if (!ticket.isCurrent()) return;
        answers.current.fail(ticket.researchId, ticket.conversationId);
        answerScope.current = null;
        setAnswerPending(null);
        setConversationError(
          "Evidence is ready, but the conversation answer did not finish. Select Read findings to retry.",
        );
      }, 90000);
    },
    [],
  );

  const api = useCallback(
    async <T,>(
      path: string,
      body?: unknown,
      conversationId?: string,
      signal?: AbortSignal,
    ): Promise<T> => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        signal,
        headers: {
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "X-CSRF-Token": sessionRef.current?.csrfToken ?? "",
              }),
          ...(conversationId ? { "X-Conversation-Id": conversationId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = (await response.json()) as T & {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : (data.message ?? `Request failed (${response.status}).`),
        );
      return data;
    },
    [],
  );

  const saveJob = useCallback((next: ResearchJob) => {
    jobRef.current = next;
    setJob(next);
    setJobs((old) => [next, ...old.filter((item) => item.id !== next.id)]);
  }, []);

  const loadSession = useCallback(async () => {
    setLoadingSession(true);
    setSessionError("");
    try {
      const result = await api<SessionResponse>("/api/session");
      sessionRef.current = result;
      setSession(result);
      setJobs(result.jobs);
    } catch (err) {
      setSessionError(errorText(err));
    } finally {
      setLoadingSession(false);
    }
  }, [api]);

  useEffect(() => {
    sessionStorage.removeItem("cua-unsent-prompt");
    void loadSession();
  }, [loadSession]);
  useEffect(() => {
    const activeAttempts = attempts.current;
    return () => {
      activeAttempts.cancel();
      answers.current.cancel();
      if (answerTimer.current) clearTimeout(answerTimer.current);
      if (connectionTimer.current) clearTimeout(connectionTimer.current);
    };
  }, []);
  useEffect(() => {
    if (turns.length && feedRef.current)
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [turns]);

  const query = useCallback(
    async (input: QueryInput, conversationId?: string) => {
      const currentGeneration = ++generation.current;
      lastQueryRef.current = input;
      filtersRef.current = input.filters;
      setFilters(input.filters);
      setQuerying(true);
      setPacket(null);
      packetRef.current = null;
      setError("");
      try {
        const { packet: result } = await api<{ packet: EvidencePacket }>(
          "/api/tools/query_feedback",
          input,
          conversationId,
        );
        if (
          !isCurrentPacket(
            result,
            jobRef.current?.id,
            input.requestId,
            currentGeneration,
            generation.current,
          )
        )
          throw new Error("A newer research scope replaced this response.");
        packetRef.current = result;
        setPacket(result);
        return result;
      } catch (err) {
        if (currentGeneration === generation.current) setError(errorText(err));
        throw err;
      } finally {
        if (currentGeneration === generation.current) setQuerying(false);
      }
    },
    [api],
  );

  const queryCurrent = useCallback(
    (parameters: ToolParameters = {}, conversationId?: string) =>
      query(
        queryFromTool(
          parameters,
          jobRef.current,
          filtersRef.current,
          crypto.randomUUID(),
          lastQueryRef.current,
        ),
        conversationId,
      ),
    [query],
  );

  const startResearch = useCallback(
    async (input: StartInput, conversationId?: string) => {
      const currentGeneration = ++generation.current;
      cancelAnswer();
      setBusy(true);
      setError("");
      try {
        const { job: next } = await api<{ job: ResearchJob }>(
          "/api/tools/start_research",
          input,
          conversationId,
        );
        if (currentGeneration !== generation.current)
          throw new Error("A newer research request is active.");
        lastQueryRef.current = null;
        filtersRef.current = { ...emptyFilters, excludedThreadIds: [] };
        setFilters(filtersRef.current);
        setPacket(null);
        packetRef.current = null;
        setQuerying(false);
        modeRef.current = next.mode;
        setMode(next.mode);
        if (conversationId && conversationId === conversationIdRef.current) {
          answers.current.arm({
            researchId: next.id,
            conversationId,
            question: next.question,
          });
        }
        saveJob(next);
        return next;
      } catch (err) {
        if (currentGeneration === generation.current) setError(errorText(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [api, saveJob, cancelAnswer],
  );

  const conversation = useConversation();

  const workspaceContext = () =>
    JSON.stringify({
      dataMode: modeRef.current,
      activeResearchId: jobRef.current?.id ?? null,
      researchState: jobRef.current?.state ?? null,
      question:
        lastQueryRef.current?.question ?? jobRef.current?.question ?? null,
      filters: filtersRef.current,
      challenge: lastQueryRef.current?.challenge ?? false,
      challengeSentiment:
        lastQueryRef.current?.challengeSentiment ?? "negative",
    });

  const sendTurn = (turn: PendingTurn) => {
    if (!conversationIdRef.current)
      throw new Error("The conversation is not connected.");
    let ticket: ReturnType<ResearchAnswers["claim"]> = null;
    if (turn.answerResearchId) {
      const researchId = turn.answerResearchId;
      const conversationId = conversationIdRef.current;
      if (researchId !== jobRef.current?.id) return false;
      if (!answers.current.matches(researchId, conversationId)) {
        if (turn.automatic) return false;
        answers.current.arm({
          researchId,
          conversationId,
          question: jobRef.current.question,
        });
      }
      ticket = answers.current.claim(
        researchId,
        conversationId,
        turn.automatic ? "automatic" : "manual",
      );
      if (!ticket) return false;
    }
    try {
      conversation.sendContextualUpdate(
        `Current workspace scope: ${workspaceContext()}. Use the selected dataMode for new research. Query evidence before stating findings.`,
      );
      conversation.sendUserMessage(turn.text);
    } catch (err) {
      if (ticket)
        answers.current.fail(ticket.researchId, ticket.conversationId);
      throw err;
    }
    if (ticket) waitForAnswer(ticket);
    sentEchoes.current.push({ text: turn.text, time: Date.now() });
    setTurns((old) => [
      ...old.slice(-79),
      {
        id: crypto.randomUUID(),
        role: turn.label ? "action" : "user",
        text: turn.label ?? turn.text,
      },
    ]);
    if (!turn.label) setPrompt("");
    return true;
  };
  sendTurnRef.current = sendTurn;

  const clearConnection = () => {
    cancelAnswer();
    conversationIdRef.current = null;
    bindingRef.current = null;
    leaseRef.current = null;
    setBound(false);
    setConnecting(false);
    if (connectionTimer.current) clearTimeout(connectionTimer.current);
  };

  const stopConversation = () => {
    attempts.current.cancel();
    pendingTurn.current = null;
    clearConnection();
    conversation.endSession();
    setConversationEvent("Conversation stopped.");
  };

  const connectConversation = async (
    nextMode: ConversationMode,
    turn?: PendingTurn,
  ) => {
    const attempt = attempts.current.begin();
    let sdkStarted = false;
    setConnectionRecovery(false);
    conversation.endSession();
    clearConnection();
    pendingTurn.current = turn ?? null;
    setConnectionMode(nextMode);
    setConversationError("");
    setConversationEvent("");
    setConnecting(true);
    connectionTimer.current = setTimeout(() => {
      if (!attempt.isCurrent()) return;
      attempts.current.cancel();
      pendingTurn.current = null;
      clearConnection();
      conversation.endSession();
      setConnectionRecovery(sdkStarted);
      setConversationError(
        sdkStarted
          ? "The connection timed out. Reload to reset it."
          : "The conversation took too long to connect. Try again.",
      );
    }, 30000);
    try {
      const result = await prepareConversation(
        nextMode,
        navigator.mediaDevices,
        (requestedMode, signal) =>
          api<{ signedUrl: string; leaseId: string }>(
            "/api/voice/session",
            { mode: requestedMode },
            undefined,
            signal,
          ),
        attempt,
      );
      if (!attempt.isCurrent()) return;
      leaseRef.current = result.leaseId;
      sdkStarted = true;
      conversation.startSession({
        ...result.options,
        onMessage: (message) => {
          if (!attempt.isCurrent()) return;
          if (message.role === "user") {
            const now = Date.now();
            sentEchoes.current = sentEchoes.current.filter(
              (entry) => now - entry.time < 30000,
            );
            const echo = sentEchoes.current.findIndex(
              (entry) => entry.text === message.message,
            );
            if (echo !== -1) {
              sentEchoes.current.splice(echo, 1);
              return;
            }
          }
          if (
            message.role === "agent" &&
            jobRef.current &&
            conversationIdRef.current &&
            answers.current.answerArrived(
              jobRef.current.id,
              conversationIdRef.current,
            )
          ) {
            answerScope.current = null;
            setAnswerPending(null);
            if (answerTimer.current) clearTimeout(answerTimer.current);
          }
          setTurns((old) => [
            ...old.slice(-79),
            {
              id: crypto.randomUUID(),
              role: message.role,
              text: message.message,
            },
          ]);
        },
        onInterruption: () => {
          if (attempt.isCurrent())
            setConversationEvent("Briefing interrupted. Listening.");
        },
        onConnect: ({ conversationId }) => {
          if (!attempt.isCurrent() || leaseRef.current !== result.leaseId)
            return;
          const binding = api<{ ok: boolean }>(
            "/api/voice/bind",
            { leaseId: result.leaseId, conversationId },
            undefined,
            attempt.signal,
          ).then(() => {
            if (!attempt.isCurrent())
              throw new Error("This connection attempt ended.");
            conversationIdRef.current = conversationId;
            setBound(true);
            setConnecting(false);
            setConversationEvent(
              nextMode === "text"
                ? "Chat connected."
                : "Voice connected. You can interrupt at any time.",
            );
            if (connectionTimer.current) clearTimeout(connectionTimer.current);
            if (nextMode === "voice") conversation.setMuted(false);
            const queued = pendingTurn.current;
            if (queued) {
              sendTurn(queued);
              pendingTurn.current = null;
            } else
              conversation.sendContextualUpdate(
                `Current workspace scope: ${workspaceContext()}. Use this dataMode for new research.`,
              );
            return conversationId;
          });
          bindingRef.current = binding;
          void binding.catch(() => {
            if (!attempt.isCurrent()) return;
            attempts.current.cancel();
            clearConnection();
            conversation.endSession();
            setConversationError(
              "This conversation could not be linked to your research. Try again.",
            );
          });
        },
        onDisconnect: (details) => {
          if (!attempt.isCurrent()) return;
          attempts.current.cancel();
          clearConnection();
          if (details.reason !== "user")
            setConversationEvent(
              "Conversation ended. Send a message or select Talk to reconnect.",
            );
        },
        onError: () => {
          if (!attempt.isCurrent()) return;
          attempts.current.cancel();
          clearConnection();
          setConversationError(
            "The conversation could not connect. Try again or check provider status in Details.",
          );
        },
      });
    } catch (err) {
      if (!attempt.isCurrent()) return;
      attempts.current.cancel();
      clearConnection();
      setConversationError(
        nextMode === "voice"
          ? microphoneError(err)
          : `Chat could not connect. ${errorText(err)}`,
      );
    }
  };

  const submitPrompt = (event: React.FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (
      !text ||
      connecting ||
      (!bound &&
        (conversation.status === "connecting" ||
          conversation.status === "connected"))
    )
      return;
    if (conversationIdRef.current) {
      try {
        sendTurn({ text });
      } catch (err) {
        setConversationError(errorText(err));
      }
    } else void connectConversation("text", { text });
  };

  const requireConversation = async () => {
    if (!bindingRef.current)
      throw new Error("The conversation is not linked yet.");
    const id = await bindingRef.current;
    if (id !== conversationIdRef.current)
      throw new Error("This conversation has ended.");
    return id;
  };
  const tool = async (
    name: string,
    operation: (id: string) => Promise<unknown>,
  ) => {
    setToolStatus(`${name}…`);
    try {
      const result = await operation(await requireConversation());
      setToolStatus(`${name} · complete`);
      return JSON.stringify(result);
    } catch (err) {
      setToolStatus(`${name} · failed`);
      return JSON.stringify({
        error: errorText(err),
        instruction:
          "Explain the error. Do not claim findings without a successful evidence packet.",
      });
    }
  };

  useConversationClientTool("start_research", (parameters) =>
    tool("Start research", async (id) => {
      const selectedMode = parameters.mode ?? modeRef.current;
      if (selectedMode === "import" && !records)
        throw new Error("Upload authorized JSON records in Details first.");
      const next = await startResearch(
        {
          product: String(parameters.product ?? ""),
          question: String(parameters.question ?? ""),
          mode: selectedMode as StartInput["mode"],
          idempotencyKey: crypto.randomUUID(),
          ...(selectedMode === "import" ? { records } : {}),
        },
        id,
      );
      return {
        job: next,
        instruction:
          "Collection runs in the background. The workspace will send an answer request when it is ready. Do not ask the user to ask again or request notification permission. Use get_research_status and query_feedback before answering.",
      };
    }),
  );
  useConversationClientTool("get_research_status", (parameters) =>
    tool("Check research", async (id) => {
      const current = jobRef.current;
      if (
        !current ||
        (parameters.researchId && parameters.researchId !== current.id)
      )
        throw new Error("This is not the active research.");
      const result = await api<{ job: ResearchJob }>(
        "/api/tools/get_research_status",
        { researchId: current.id },
        id,
      );
      if (jobRef.current?.id === current.id) {
        if (result.job.state === "ready") {
          const ticket = answers.current.claim(current.id, id, "automatic");
          if (ticket) waitForAnswer(ticket);
        }
        saveJob(result.job);
      }
      return result;
    }),
  );
  useConversationClientTool("query_feedback", (parameters) =>
    tool("Retrieve evidence", async (id) => {
      const currentResearch = jobRef.current;
      const scopedParameters =
        answerScope.current?.researchId === currentResearch?.id &&
        answerScope.current?.revision !== scopeIntent.current &&
        lastQueryRef.current
          ? currentScopeParameters(parameters, lastQueryRef.current)
          : parameters;
      let queryRevision: number | undefined;
      try {
        const pending = queryCurrent(scopedParameters, id);
        queryRevision = generation.current;
        const result = await pending;
        answers.current.observeQuery(result.researchId, id);
        return { packet: agentEvidencePacket(result) };
      } catch (err) {
        if (
          currentResearch?.id === jobRef.current?.id &&
          conversationIdRef.current === id &&
          (queryRevision === undefined || queryRevision === generation.current)
        ) {
          if (currentResearch) answers.current.fail(currentResearch.id, id);
          answerScope.current = null;
          setAnswerPending(null);
          if (answerTimer.current) clearTimeout(answerTimer.current);
        }
        throw err;
      }
    }),
  );
  useConversationClientTool("prepare_decision_brief", (parameters) =>
    tool("Prepare brief", async (id) => {
      const input = queryFromTool(
        parameters,
        jobRef.current,
        filtersRef.current,
        crypto.randomUUID(),
        lastQueryRef.current,
      );
      await query(input, id);
      const queryGeneration = generation.current;
      const result = await api<{ brief: DecisionBrief }>(
        "/api/tools/prepare_decision_brief",
        input,
        id,
      );
      if (
        queryGeneration !== generation.current ||
        result.brief.researchId !== jobRef.current?.id ||
        result.brief.scopeVersion !== packetRef.current?.scopeVersion
      )
        throw new Error("Research scope changed. Ask for a new brief.");
      downloadBrief(result.brief);
      return {
        brief: {
          researchId: result.brief.researchId,
          scopeVersion: result.brief.scopeVersion,
          filename: result.brief.filename,
        },
        downloadStarted: true,
      };
    }),
  );

  const activeId = job?.id;
  const activeState = job?.state;
  useEffect(() => {
    if (!activeId || !activeState || terminal.has(activeState)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const result = await api<{ job: ResearchJob }>(
          "/api/tools/get_research_status",
          { researchId: activeId },
          undefined,
          controller.signal,
        );
        if (!stopped && jobRef.current?.id === activeId) {
          saveJob(result.job);
          if (!terminal.has(result.job.state)) timer = setTimeout(poll, 1200);
        }
      } catch (err) {
        if (!stopped) {
          setError(`Progress could not refresh: ${errorText(err)}`);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeId, activeState, api, saveJob]);
  useEffect(() => {
    if (activeState === "ready") {
      void queryCurrent().catch(() => undefined);
      void loadSession();
    }
  }, [activeId, activeState, queryCurrent, loadSession]);

  useEffect(() => {
    const current = jobRef.current;
    if (
      activeState !== "ready" ||
      !current ||
      current.id !== activeId ||
      !bound ||
      !conversationIdRef.current
    )
      return;
    const scope = lastQueryRef.current;
    try {
      sendTurnRef.current({
        automatic: true,
        answerResearchId: current.id,
        label: "Research complete. Preparing your answer.",
        text: `The research I requested is ready: ${current.id}. Answer my original question: ${JSON.stringify(scope?.question ?? current.question)}. First call get_research_status. If ready, call query_feedback with this research ID, that question, the current workspace filters, challenge ${scope?.challenge ?? false}, and challengeSentiment ${scope?.challengeSentiment ?? "negative"}. Then answer the question directly using actual findings and citations from that packet. Use the normal overview unless the current scope explicitly requests opposing evidence. Include a short sample limitation. Do not ask me to ask again.`,
      });
    } catch (err) {
      setConversationError(errorText(err));
    }
  }, [activeId, activeState, bound]);

  const readFindings = () => {
    const current = packetRef.current;
    const research = jobRef.current;
    if (research?.state !== "ready") return;
    const turn = {
      label: "Read findings requested",
      answerResearchId: research.id,
      text: `Read the findings for my active research ${research.id}. First call get_research_status for this research. If ready, call query_feedback with the current scope, question ${JSON.stringify(current?.question ?? lastQueryRef.current?.question ?? research.question)}, challenge ${current?.challenge ?? lastQueryRef.current?.challenge ?? false}, and challengeSentiment ${lastQueryRef.current?.challengeSentiment ?? "negative"}. Give a concise briefing from that packet and state its sample limitations. Do not read URLs aloud.`,
    };
    if (conversationIdRef.current) {
      try {
        sendTurn(turn);
      } catch (err) {
        setConversationError(errorText(err));
      }
    } else void connectConversation("text", turn);
  };
  const applyScope = (next: Filters) => {
    if (jobRef.current?.state !== "ready") return;
    scopeIntent.current++;
    void query({
      researchId: jobRef.current.id,
      question: lastQueryRef.current?.question ?? jobRef.current.question,
      filters: next,
      challenge: lastQueryRef.current?.challenge ?? false,
      challengeSentiment:
        lastQueryRef.current?.challengeSentiment ?? "negative",
      requestId: crypto.randomUUID(),
    }).catch(() => undefined);
  };
  const excludeThread = (id: string) =>
    applyScope({
      ...filtersRef.current,
      excludedThreadIds: [
        ...new Set([...filtersRef.current.excludedThreadIds, id]),
      ],
    });
  const exportBrief = async () => {
    const current = packetRef.current;
    if (!current) return;
    const currentGeneration = generation.current;
    setExporting(true);
    try {
      const { brief } = await api<{ brief: DecisionBrief }>(
        "/api/tools/prepare_decision_brief",
        {
          researchId: current.researchId,
          question: current.question,
          filters: current.filters,
          challenge: current.challenge,
          challengeSentiment:
            lastQueryRef.current?.challengeSentiment ?? "negative",
          requestId: crypto.randomUUID(),
        },
      );
      if (
        currentGeneration !== generation.current ||
        brief.scopeVersion !== packetRef.current?.scopeVersion
      )
        throw new Error("The scope changed. Export the brief again.");
      downloadBrief(brief);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setExporting(false);
    }
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 3_000_000) {
      setError("Choose a JSON file smaller than 3 MB.");
      return;
    }
    try {
      const parsed = rawRecordSchema
        .array()
        .max(150)
        .parse(JSON.parse(await file.text()));
      setRecords(parsed);
      setImportName(`${file.name} · ${parsed.length} records`);
      setError("");
    } catch {
      setError(
        "Invalid import. Use the documented JSON array format, with up to 150 records.",
      );
    }
  };
  const selectResearch = (next: ResearchJob) => {
    cancelAnswer();
    generation.current++;
    lastQueryRef.current = null;
    filtersRef.current = { ...emptyFilters, excludedThreadIds: [] };
    setFilters(filtersRef.current);
    setPacket(null);
    packetRef.current = null;
    setQuerying(false);
    modeRef.current = next.mode;
    setMode(next.mode);
    saveJob(next);
    dialogRef.current?.close();
  };
  const newConversation = () => {
    setElasticKey((key) => key + 1);
    setElasticHasContent(false);
    stopConversation();
    generation.current++;
    lastQueryRef.current = null;
    jobRef.current = null;
    packetRef.current = null;
    setJob(null);
    setPacket(null);
    setTurns([]);
    setQuerying(false);
    setError("");
    setConversationError("");
    setConversationEvent("");
    setToolStatus("");
    setPrompt("");
    filtersRef.current = { ...emptyFilters, excludedThreadIds: [] };
    setFilters(filtersRef.current);
    modeRef.current = "live";
    setMode("live");
    requestAnimationFrame(() =>
      document
        .getElementById(elasticMode ? "elastic-prompt" : "prompt")
        ?.focus(),
    );
  };
  const tryDemo = () => {
    void startResearch({
      product: "AcmeFlow",
      question: DEMO_QUESTION,
      mode: "fixture",
      idempotencyKey: crypto.randomUUID(),
    }).catch(() => undefined);
  };
  const openCitation = (id: string) => {
    dialogRef.current?.close();
    if (evidenceRef.current) evidenceRef.current.open = true;
    requestAnimationFrame(() =>
      document
        .getElementById(`evidence-${id}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  };

  const connected = bound && conversation.status === "connected";
  const settling =
    !bound &&
    !connecting &&
    (conversation.status === "connecting" ||
      conversation.status === "connected");
  const ready = job?.state === "ready";
  const hasContent = elasticMode
    ? elasticHasContent
    : turns.length > 0 || !!job;
  const sourceLabel =
    job?.mode === "fixture"
      ? "Synthetic demo"
      : job?.mode === "import"
        ? "Imported records"
        : "Hacker News discussions";
  const allEvidence = packet
    ? [
        ...new Map(
          [...packet.opposingEvidence, ...packet.evidence].map((record) => [
            record.id,
            record,
          ]),
        ).values(),
      ]
    : [];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to research
      </a>
      <header className="app-header">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            newConversation();
          }}
        >
          <span className="brand-symbol">
            <Layers3 size={20} />
          </span>
          CUA Parse
        </a>
        <div className="header-actions">
          {hasContent && (
            <button className="quiet-button" onClick={newConversation}>
              <Plus size={16} />
              New conversation
            </button>
          )}
          {!elasticMode && (
            <button
              className="quiet-button"
              onClick={() => dialogRef.current?.showModal()}
            >
              <SlidersHorizontal size={16} />
              Details
            </button>
          )}
        </div>
      </header>
      <main id="main" className={hasContent ? "has-content" : ""}>
        <section
          className="conversation-workspace"
          aria-labelledby="page-title"
        >
          <div className="intro">
            <span className="eyebrow">
              PRODUCT RESEARCH, BACKED BY EVIDENCE
            </span>
            <h1 id="page-title">
              {hasContent ? (
                "Let’s look at the evidence."
              ) : (
                <>
                  Your next decision
                  <br />
                  starts with a question.
                </>
              )}
            </h1>
            {!hasContent && (
              <p>
                {elasticMode ? (
                  <>
                    Ask about the uploaded comments.
                    <br />
                    Check each answer against its sources.
                  </>
                ) : (
                  <>
                    Ask about a product. Talk through the feedback.
                    <br />
                    See what supports the answer.
                  </>
                )}
              </p>
            )}
          </div>
          <div className="workspace-source">
            <label className="source-choice">
              Source
              <select
                aria-label="Research source"
                value={elasticMode ? "elastic" : mode}
                onChange={(event) => {
                  const source = event.target.value;
                  if (source === "elastic") {
                    stopConversation();
                    sessionStorage.setItem("cua-research-source", "elastic");
                    setElasticMode(true);
                  } else {
                    sessionStorage.removeItem("cua-research-source");
                    setElasticHasContent(false);
                    setElasticMode(false);
                    modeRef.current = source as StartInput["mode"];
                    setMode(modeRef.current);
                  }
                }}
              >
                <option value="live">Live discussions</option>
                <option value="elastic">YouTube comments · Elastic</option>
                <option value="fixture">Synthetic demo</option>
                <option value="import">My import</option>
              </select>
            </label>
          </div>
          {!session && loadingSession && (
            <p className="tool-status" role="status">
              <LoaderCircle className="spin" size={13} />
              Connecting to the research server…
            </p>
          )}
          {sessionError && (
            <>
              <div className="error-message" role="alert">
                <CircleAlert size={17} />
                <div>{sessionError}</div>
              </div>
              <button
                className="text-button"
                disabled={loadingSession}
                onClick={() => void loadSession()}
              >
                Retry server connection
              </button>
            </>
          )}
          {elasticMode ? (
            <ElasticResearch
              key={elasticKey}
              csrfToken={session?.csrfToken ?? ""}
              available={session?.elasticAgentAvailable ?? false}
              onContentChange={setElasticHasContent}
            />
          ) : (
            <>
              {turns.length > 0 && (
                <div
                  className="conversation-feed"
                  ref={feedRef}
                  role="log"
                  aria-label="Conversation"
                  aria-live="polite"
                >
                  {turns.map((turn) => (
                    <article
                      key={turn.id}
                      className={`message turn ${turn.role}`}
                    >
                      <span>
                        {turn.role === "user"
                          ? "You"
                          : turn.role === "agent"
                            ? "CUA Parse"
                            : "Action"}
                      </span>
                      <p>{turn.text}</p>
                    </article>
                  ))}
                </div>
              )}
              <form className="prompt-composer" onSubmit={submitPrompt}>
                <label className="sr-only" htmlFor="prompt">
                  Message
                </label>
                <textarea
                  id="prompt"
                  rows={2}
                  maxLength={1000}
                  value={prompt}
                  disabled={connecting}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    if (connected) conversation.sendUserActivity();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    hasContent
                      ? "Ask a follow-up, or research another product…"
                      : "What do people dislike about Notion’s pricing?"
                  }
                />
                <div className="composer-controls">
                  <div className="conversation-controls">
                    {connected && connectionMode === "voice" ? (
                      <button
                        type="button"
                        className={`talk-button ${conversation.isMuted ? "muted" : ""}`}
                        onClick={() =>
                          conversation.setMuted(!conversation.isMuted)
                        }
                      >
                        {conversation.isMuted ? (
                          <MicOff size={17} />
                        ) : (
                          <Mic size={17} />
                        )}
                        {conversation.isMuted ? "Unmute" : "Mute"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="talk-button"
                        onClick={() => void connectConversation("voice")}
                        disabled={
                          connecting || settling || !session?.voiceAvailable
                        }
                      >
                        <AudioLines size={18} />
                        Talk
                      </button>
                    )}
                    {(connected || connecting) && (
                      <button
                        type="button"
                        className="stop-button"
                        onClick={stopConversation}
                        aria-label={
                          connecting ? "Cancel connection" : "Stop conversation"
                        }
                      >
                        <Square size={12} />
                      </button>
                    )}
                    <span className="connection-label" aria-live="polite">
                      {settling
                        ? "Stopping…"
                        : connecting
                          ? "Connecting…"
                          : connected
                            ? connectionMode === "voice"
                              ? conversation.isSpeaking
                                ? "Speaking"
                                : conversation.isMuted
                                  ? "Muted"
                                  : "Listening"
                              : "Chat connected"
                            : ""}
                    </span>
                  </div>
                  <button
                    className="send-button"
                    type="submit"
                    aria-label="Send message"
                    disabled={
                      !prompt.trim() || connecting || !session?.voiceAvailable
                    }
                  >
                    {connecting ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <ArrowRight size={19} />
                    )}
                  </button>
                </div>
              </form>
              <div className="composer-caption">
                <span>
                  {connectionMode === "voice" && connected
                    ? "You can interrupt the briefing."
                    : "Type to chat. No microphone needed."}
                </span>
              </div>
              {session && !session.voiceAvailable && !loadingSession && (
                <p className="availability-note">
                  Conversation is unavailable. Check setup in{" "}
                  <button onClick={() => dialogRef.current?.showModal()}>
                    Details
                  </button>
                  , or explore the demo.
                </p>
              )}
              {(conversationError || error) && (
                <div className="error-message" role="alert">
                  <CircleAlert size={17} />
                  <div>{conversationError || error}</div>
                  <button
                    className="icon-button"
                    aria-label="Dismiss error"
                    onClick={() => {
                      setError("");
                      setConversationError("");
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {(settling || connectionRecovery) && (
                <div className="connection-recovery">
                  <p>
                    The previous connection needs to close before a new one can
                    start.
                  </p>
                  <button
                    className="text-button"
                    onClick={() => {
                      sessionStorage.setItem("cua-unsent-prompt", prompt);
                      window.location.reload();
                    }}
                  >
                    Reload connection
                  </button>
                </div>
              )}
              {conversationEvent && connected && connectionMode === "voice" && (
                <p className="conversation-event" role="status">
                  {conversationEvent}
                </p>
              )}
              {!job && (
                <div className="demo-invite">
                  <button onClick={tryDemo} disabled={busy || !session}>
                    <FlaskConical size={14} />
                    {busy ? "Starting demo…" : "Try demo"}
                    <ArrowRight size={13} />
                  </button>
                  <span>Synthetic data · no account needed</span>
                </div>
              )}
              {toolStatus && (
                <p className="tool-status" role="status">
                  {toolStatus.endsWith("failed") ? (
                    <CircleAlert size={13} />
                  ) : toolStatus.endsWith("…") ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <Check size={13} />
                  )}
                  {toolStatus}
                </p>
              )}
              {job && (
                <div className={`research-progress ${job.state}`} role="status">
                  <div>
                    {!terminal.has(job.state) || querying ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : job.state === "ready" ? (
                      <Check size={16} />
                    ) : (
                      <CircleAlert size={16} />
                    )}
                    <span>
                      <strong>
                        {querying
                          ? "Updating evidence"
                          : job.state === "ready"
                            ? answerPending === job.id
                              ? "Preparing your answer"
                              : `${job.product} · research ready`
                            : `${job.product} · ${job.state}`}
                      </strong>
                      <small>
                        {ready
                          ? `${job.collected} records collected`
                          : `${job.collected} collected · ${job.analyzed} reviewed · ${job.indexed} indexed`}
                      </small>
                    </span>
                  </div>
                  {!terminal.has(job.state) ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        void api<{ job: ResearchJob }>(
                          `/api/research/${job.id}/cancel`,
                          {},
                        )
                          .then((result) => {
                            if (result.job.id === jobRef.current?.id)
                              saveJob(result.job);
                          })
                          .catch((err) => setError(errorText(err)))
                      }
                    >
                      Cancel
                    </button>
                  ) : ready && session?.voiceAvailable ? (
                    <button
                      className="text-button"
                      onClick={readFindings}
                      disabled={
                        connecting || settling || answerPending === job.id
                      }
                    >
                      <Headphones size={14} />
                      Read findings
                    </button>
                  ) : null}
                </div>
              )}
              {job && (job.partial || job.failures.length > 0) && (
                <p className="partial-sample-note">
                  {job.state === "failed"
                    ? "Research did not finish."
                    : "Partial sample: some collection or analysis steps did not complete."}{" "}
                  <button
                    className="inline-button"
                    onClick={() => dialogRef.current?.showModal()}
                  >
                    View details
                  </button>
                </p>
              )}
            </>
          )}
        </section>

        {!elasticMode && packet && (
          <section className="findings-card" aria-labelledby="findings-title">
            <div className="findings-heading">
              <span className="eyebrow">
                {packet.challenge
                  ? "CHALLENGE THE CONCLUSION"
                  : "THE CURRENT EVIDENCE"}
              </span>
              <span className={`provenance-tag ${job?.mode}`}>
                {sourceLabel}
              </span>
            </div>
            <h2 id="findings-title">
              {packet.challenge
                ? "What points the other way?"
                : `What the sample says about ${job?.product}`}
            </h2>
            <p className="conclusion">{packet.spokenSummary}</p>
            {packet.findings.length > 0 && (
              <ul className="answer-findings">
                {packet.findings.map((finding) => (
                  <li key={finding.id}>
                    <p>{finding.text}</p>
                    <div className="finding-citations">
                      {finding.evidenceIds.map((id, index) => (
                        <button key={id} onClick={() => openCitation(id)}>
                          Source {index + 1}
                          <ExternalLink size={10} />
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {packet.challenge && !packet.opposingEvidence.length && (
              <p className="empty-note">
                No opposing evidence was found in this scope. This does not
                prove that none exists elsewhere.
              </p>
            )}
            <div className="sample-counts">
              <span>
                <strong>{packet.metrics.scopedRecords}</strong> records in scope
              </span>
              <span>
                <strong>{packet.metrics.relevantRecords}</strong> relevant
              </span>
              <span>
                <strong>{packet.metrics.distinctThreads}</strong> threads
              </span>
            </div>
            <div className="finding-actions">
              <button
                className="secondary-button"
                disabled={querying}
                onClick={() => {
                  scopeIntent.current++;
                  void queryCurrent({ challenge: !packet.challenge }).catch(
                    () => undefined,
                  );
                }}
              >
                <SlidersHorizontal size={15} />
                {packet.challenge
                  ? "Return to overview"
                  : "Challenge conclusion"}
              </button>
              <button
                className="quiet-button"
                disabled={exporting || querying}
                onClick={() => void exportBrief()}
              >
                {exporting ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <ArrowDownToLine size={15} />
                )}
                Export brief
              </button>
            </div>
            <details className="evidence-disclosure" ref={evidenceRef}>
              <summary>
                Inspect {allEvidence.length} evidence records{" "}
                <ChevronDown size={15} />
              </summary>
              {packet.challenge && (
                <p className="evidence-note">
                  {packet.opposingEvidence.length} opposing matches are shown
                  first. Supporting records remain available for comparison.
                </p>
              )}
              <div className="evidence-list">
                {allEvidence.map((record) => (
                  <EvidenceCard
                    key={record.id}
                    record={record}
                    opposing={
                      packet.challenge &&
                      packet.opposingEvidence.some(
                        (item) => item.id === record.id,
                      )
                    }
                    onExclude={() => excludeThread(record.threadId)}
                  />
                ))}
                {!allEvidence.length && (
                  <p className="empty-note">
                    No matching records. Broaden the question or change the
                    scope in Details.
                  </p>
                )}
              </div>
            </details>
            <p className="sample-note">
              {packet.limitations[0] ??
                "These findings describe the collected sample, not all customers."}{" "}
              <button
                className="inline-button"
                onClick={() => dialogRef.current?.showModal()}
              >
                Sample details
              </button>
            </p>
          </section>
        )}
        <footer className="page-footer">
          Evidence you can inspect. Conclusions you can challenge.
        </footer>
      </main>

      <dialog
        className="details-dialog"
        ref={dialogRef}
        aria-labelledby="details-title"
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">YOUR RESEARCH</span>
            <h2 id="details-title">Details</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close details"
            onClick={() => dialogRef.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-content">
          {packet && (
            <details className="detail-group" open>
              <summary>Scope & filters</summary>
              <p className="detail-help">
                Filters change both the counts and retrieved evidence.
              </p>
              <div className="filter-fields">
                <label>
                  Aspect
                  <select
                    aria-label="Filter by aspect"
                    value={filters.aspect ?? ""}
                    onChange={(event) =>
                      applyScope({
                        ...filters,
                        aspect: (event.target.value ||
                          null) as Filters["aspect"],
                      })
                    }
                  >
                    <option value="">All aspects</option>
                    {Aspects.map((aspect) => (
                      <option key={aspect}>{aspect}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Source
                  <select
                    aria-label="Filter by source"
                    value={filters.source ?? ""}
                    onChange={(event) =>
                      applyScope({
                        ...filters,
                        source: (event.target.value ||
                          null) as Filters["source"],
                      })
                    }
                  >
                    <option value="">All sources</option>
                    <option value="fixture">Synthetic</option>
                    <option value="hackernews">Hacker News</option>
                    <option value="import">Imported</option>
                  </select>
                </label>
                <label>
                  From
                  <input
                    aria-label="From date"
                    type="date"
                    value={filters.from?.slice(0, 10) ?? ""}
                    onChange={(event) =>
                      applyScope({
                        ...filters,
                        from: event.target.value
                          ? `${event.target.value}T00:00:00.000Z`
                          : null,
                      })
                    }
                  />
                </label>
                <label>
                  To
                  <input
                    aria-label="To date"
                    type="date"
                    value={filters.to?.slice(0, 10) ?? ""}
                    onChange={(event) =>
                      applyScope({
                        ...filters,
                        to: event.target.value
                          ? `${event.target.value}T23:59:59.999Z`
                          : null,
                      })
                    }
                  />
                </label>
              </div>
              <label className="challenge-direction">
                Conclusion to challenge
                <select
                  aria-label="Conclusion sentiment to challenge"
                  value={lastQueryRef.current?.challengeSentiment ?? "negative"}
                  onChange={(event) => {
                    scopeIntent.current++;
                    void queryCurrent({
                      challenge: true,
                      challengeSentiment: event.target.value,
                    }).catch(() => undefined);
                  }}
                >
                  <option value="negative">Negative</option>
                  <option value="positive">Positive</option>
                </select>
              </label>
              {filters.excludedThreadIds.length > 0 && (
                <div className="excluded-list">
                  {filters.excludedThreadIds.map((id) => (
                    <button
                      key={id}
                      onClick={() =>
                        applyScope({
                          ...filters,
                          excludedThreadIds: filters.excludedThreadIds.filter(
                            (item) => item !== id,
                          ),
                        })
                      }
                    >
                      Restore {id}
                      <X size={12} />
                    </button>
                  ))}
                </div>
              )}
            </details>
          )}
          {packet && (
            <details className="detail-group">
              <summary>Sample & themes</summary>
              <dl className="sample-metrics">
                <dt>Collected after deduplication</dt>
                <dd>{packet.metrics.collectedRecords}</dd>
                <dt>Records in scope</dt>
                <dd>{packet.metrics.scopedRecords}</dd>
                <dt>Relevant product matches</dt>
                <dd>{packet.metrics.relevantRecords}</dd>
                <dt>Aspect mentions</dt>
                <dd>{packet.metrics.aspectMentions}</dd>
                <dt>Distinct scoped threads</dt>
                <dd>{packet.metrics.distinctThreads}</dd>
              </dl>
              <p className="detail-help">
                One record can mention several aspects. Counts are calculated
                over the full scope, not only displayed examples.
              </p>
              <div className="table-scroll">
                <table>
                  <caption>Aspect mentions by sentiment</caption>
                  <thead>
                    <tr>
                      <th>Aspect</th>
                      <th>Negative</th>
                      <th>Positive</th>
                      <th>Mixed</th>
                      <th>Neutral</th>
                      <th>Unknown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packet.metrics.aspects.map((aspect) => (
                      <tr key={aspect.aspect}>
                        <th>{titleCase(aspect.aspect)}</th>
                        <td>{aspect.negative}</td>
                        <td>{aspect.positive}</td>
                        <td>{aspect.mixed}</td>
                        <td>{aspect.neutral}</td>
                        <td>{aspect.unknown}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {packet.findings.map((finding) => (
                <div className="detail-finding" key={finding.id}>
                  <strong>{titleCase(finding.aspect)}</strong>
                  <p>{finding.text}</p>
                  <div className="citations">
                    {finding.evidenceIds.map((id) => (
                      <button key={id} onClick={() => openCitation(id)}>
                        {id}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <ul className="limitations">
                {packet.limitations.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p className="detail-help">
                Snapshot {packet.snapshotVersion} · scope {packet.scopeVersion}{" "}
                ·{" "}
                {packet.retrievalMode === "bm25"
                  ? "BM25 keyword search"
                  : "Hybrid search"}
              </p>
            </details>
          )}
          {packet && (
            <details className="detail-group">
              <summary>Threads & concentration</summary>
              <p className="detail-help">
                All records in the current scope, including records not labeled
                relevant. Exclude a thread to recalculate the sample.
              </p>
              {packet.metrics.threads.map((thread) => (
                <div className="thread-row" key={thread.threadId}>
                  <div>
                    <strong>{thread.title || thread.threadId}</strong>
                    <span>{thread.count} records</span>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => excludeThread(thread.threadId)}
                  >
                    Exclude
                    <span className="sr-only">
                      {" "}
                      {thread.title || thread.threadId}
                    </span>
                  </button>
                </div>
              ))}
              {!packet.metrics.threads.length && (
                <p className="empty-note">No threads in this scope.</p>
              )}
            </details>
          )}
          <details className="detail-group">
            <summary>Collection activity</summary>
            {job ? (
              <>
                <p className="detail-help">
                  {job.product} · {job.state} · {job.duplicates} duplicates
                  removed
                </p>
                {job.attempts.map((attempt, i) => (
                  <div className="source-attempt" key={i}>
                    <strong>{attempt.query}</strong>
                    <span>
                      {attempt.status} · {attempt.count} records
                    </span>
                    {attempt.message && <p>{attempt.message}</p>}
                    {safeEvidenceUrl(attempt.url) && (
                      <a
                        href={safeEvidenceUrl(attempt.url)!}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Original source <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                ))}
                {job.failures.map((failure, i) => (
                  <p className="failure-note" key={i}>
                    {failure}
                  </p>
                ))}
              </>
            ) : (
              <p className="empty-note">No research started yet.</p>
            )}
          </details>
          <details className="detail-group">
            <summary>Import your data</summary>
            <p className="detail-help">
              Upload a JSON array of up to 150 authorized records. This starts a
              direct import, without a conversation.
            </p>
            <label className="import-file">
              JSON file
              <input
                aria-label="Upload authorized JSON records"
                type="file"
                accept=".json,application/json"
                onChange={(event) => void importJson(event.target.files?.[0])}
              />
            </label>
            {importName && <p className="detail-help">{importName}</p>}
            <form
              className="import-form"
              onSubmit={(event) => {
                event.preventDefault();
                dialogRef.current?.close();
                void startResearch({
                  product: importProduct,
                  question: importQuestion,
                  mode: "import",
                  records,
                  idempotencyKey: crypto.randomUUID(),
                }).catch(() => undefined);
              }}
            >
              <label>
                Product
                <input
                  aria-label="Import product"
                  required
                  minLength={2}
                  maxLength={120}
                  value={importProduct}
                  onChange={(event) => setImportProduct(event.target.value)}
                />
              </label>
              <label>
                Question
                <textarea
                  aria-label="Import research question"
                  required
                  minLength={3}
                  maxLength={1000}
                  value={importQuestion}
                  onChange={(event) => setImportQuestion(event.target.value)}
                  rows={2}
                />
              </label>
              <button
                className="secondary-button"
                disabled={!records || busy || !session}
              >
                Research this import
                <ArrowRight size={14} />
              </button>
            </form>
          </details>
          <details className="detail-group">
            <summary>
              Research history <span>{jobs.length}</span>
            </summary>
            {jobs.length ? (
              jobs.map((item) => (
                <button
                  className="history-item"
                  key={item.id}
                  onClick={() => selectResearch(item)}
                >
                  <span>
                    {item.product}
                    <small>{item.question}</small>
                  </span>
                  <span>
                    {item.mode === "fixture" ? "Synthetic" : item.mode} ·{" "}
                    {item.state}
                  </span>
                </button>
              ))
            ) : (
              <p className="empty-note">
                Your research sessions will appear here.
              </p>
            )}
          </details>
          <details className="detail-group">
            <summary>Provider status</summary>
            <ProviderList session={session} loading={loadingSession} />
            <button className="text-button" onClick={() => void loadSession()}>
              Refresh status
            </button>
          </details>
        </div>
      </dialog>
    </div>
  );
}

function EvidenceCard({
  record,
  opposing,
  onExclude,
}: {
  record: EvidenceRecord;
  opposing: boolean;
  onExclude: () => void;
}) {
  const url = safeEvidenceUrl(record.url);
  const quotes = [
    ...new Set(
      record.aspects
        .filter((label) => record.text.includes(label.quote))
        .map((label) => label.quote),
    ),
  ];
  return (
    <article className="evidence-card" id={`evidence-${record.id}`}>
      <div className="evidence-meta">
        <span>
          {record.provenance === "synthetic"
            ? "Synthetic evidence"
            : record.provenance === "imported"
              ? "Imported evidence"
              : "Live discussion"}
          {opposing ? " · Opposing match" : ""}
        </span>
        <span>{dateLabel(record.publishedAt)}</span>
      </div>
      <h3>{record.threadTitle || "Untitled thread"}</h3>
      {quotes.length ? (
        <blockquote>“{quotes.join(" … ")}”</blockquote>
      ) : (
        <p className="original-excerpt">{record.text}</p>
      )}
      <details className="original-record">
        <summary>Full record & labels</summary>
        <p>{record.text}</p>
        <div className="aspect-labels">
          {record.aspects.map((label, i) => (
            <span key={i}>
              {label.aspect} · {label.sentiment}
            </span>
          ))}
        </div>
        <dl>
          <dt>Evidence</dt>
          <dd>{record.id}</dd>
          <dt>Thread</dt>
          <dd>{record.threadId}</dd>
          <dt>Parent</dt>
          <dd>{record.parentId ?? "None supplied"}</dd>
          <dt>Collected</dt>
          <dd>{dateLabel(record.collectedAt)}</dd>
          <dt>Analysis</dt>
          <dd>
            {record.analysisVersion} · {record.extractionStatus}
          </dd>
        </dl>
      </details>
      <div className="evidence-footer">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            View original
            <ExternalLink size={12} />
          </a>
        ) : (
          <span>
            {record.provenance === "synthetic"
              ? "Fixture record · no public source"
              : "No safe original link supplied"}
          </span>
        )}
        <button className="text-button" onClick={onExclude}>
          Exclude thread
        </button>
      </div>
    </article>
  );
}

function ProviderList({
  session,
  loading,
}: {
  session: SessionResponse | null;
  loading: boolean;
}) {
  return (
    <div className="provider-list">
      {loading ? (
        <p>Checking status…</p>
      ) : session ? (
        Object.entries(session.providers).map(([name, provider]) => (
          <div className="provider-row" key={name}>
            <div>
              <strong>{titleCase(name)}</strong>
              <span>{provider.status.replaceAll("-", " ")}</span>
            </div>
            <p>{provider.detail}</p>
          </div>
        ))
      ) : (
        <p>Connect to the local server to read provider status.</p>
      )}
    </div>
  );
}
