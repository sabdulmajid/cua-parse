import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BarChart3,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  ExternalLink,
  FileJson,
  Filter,
  Inbox,
  Menu,
  MessageSquare,
  Play,
  RotateCcw,
  Search,
  Upload,
  X,
} from "lucide-react";
import {
  analyze,
  balancedEvidence,
  brief,
  defaultFilters,
  parseImport,
  products,
  searchEvidence,
  IMPORT_LIMITS,
  type FeedbackRecord,
  type RankedIssue,
  type Scope,
  type WorkspaceDataset,
} from "./model";
import { sampleDataset } from "./sample";
import "./workspace.css";

type View = "overview" | "issues" | "evidence";
type DialogRef = RefObject<HTMLDialogElement | null>;
const sourceLabels: Record<string, string> = {
  hackernews: "Hacker News",
  youtube: "YouTube",
  reddit: "Reddit",
  steam: "Steam",
  fixture: "Sample",
  import: "Imported",
  lemmy: "Lemmy",
};
const sourceName = (name: string) =>
  Object.hasOwn(sourceLabels, name)
    ? sourceLabels[name]
    : name.replaceAll("_", " ");
const displayDate = (date: string | null) =>
  date && !Number.isNaN(Date.parse(date))
    ? new Date(date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Date not supplied";
const sourceHref = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const initialScope = (dataset: WorkspaceDataset) =>
  defaultFilters(products(dataset)[0] ?? "");

export default function Workspace({
  liveResearchHref,
  mediaBase = "./assets/",
}: {
  liveResearchHref?: string;
  mediaBase?: string;
}) {
  const [dataset, setDataset] = useState<WorkspaceDataset>(sampleDataset);
  const [scope, setScope] = useState<Scope>(() => initialScope(sampleDataset));
  const [view, setView] = useState<View>("overview");
  const [issueName, setIssueName] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [evidencePage, setEvidencePage] = useState(0);
  const [sourceRecord, setSourceRecord] = useState<FeedbackRecord | null>(null);
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [dateError, setDateError] = useState("");
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [voxInput, setVoxInput] = useState("");
  const [voxQuestion, setVoxQuestion] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [mediaError, setMediaError] = useState(false);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const voxDialog = useRef<HTMLDialogElement>(null);
  const mediaDialog = useRef<HTMLDialogElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const importGeneration = useRef(0);
  const openers = useRef(new Map<HTMLDialogElement, HTMLElement>());
  const datesRef = useRef<HTMLDetailsElement>(null);

  const productOptions = useMemo(() => products(dataset), [dataset]);
  const analysis = useMemo(() => analyze(dataset, scope), [dataset, scope]);
  const sourceOptions = useMemo(
    () =>
      [
        ...new Set(
          dataset.records
            .filter((record) => record.product === scope.product)
            .map((record) => record.source),
        ),
      ].sort(),
    [dataset, scope.product],
  );
  const selectedIssue = analysis.issues.find(
    (issue) => issue.name === issueName,
  );
  const issueRecords = useMemo(
    () =>
      analysis.records.filter(
        (record) =>
          record.relevant !== false && record.issues.includes(issueName),
      ),
    [analysis, issueName],
  );
  const voxAnswer = useMemo(
    () => (voxQuestion ? searchEvidence(analysis, voxQuestion) : null),
    [analysis, voxQuestion],
  );
  const largestThread = analysis.threads[0];
  const filtered =
    scope.sources.length > 0 ||
    scope.sentiment !== "all" ||
    !!scope.from ||
    !!scope.to ||
    !!scope.query ||
    scope.excludedThreadIds.length > 0;
  const totalProductRecords = dataset.records.filter(
    (record) => record.product === scope.product,
  ).length;
  const localResearch = (() => {
    if (
      !liveResearchHref ||
      !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
    )
      return null;
    try {
      const url = new URL(liveResearchHref, window.location.href);
      return url.origin === window.location.origin ? url.href : null;
    } catch {
      return null;
    }
  })();

  function openDialog(ref: DialogRef) {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    if (document.activeElement instanceof HTMLElement)
      openers.current.set(dialog, document.activeElement);
    dialog.showModal();
  }
  function restoreFocus(ref: DialogRef) {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = openers.current.get(dialog);
    if (opener?.isConnected) opener.focus();
    openers.current.delete(dialog);
  }
  useEffect(() => {
    function openWalkthrough() {
      if (window.location.hash === "#walkthrough" && !mediaDialog.current?.open)
        mediaDialog.current?.showModal();
    }
    openWalkthrough();
    window.addEventListener("hashchange", openWalkthrough);
    return () => {
      window.removeEventListener("hashchange", openWalkthrough);
      importGeneration.current++;
    };
  }, []);
  function navigate(next: View) {
    setView(next);
    setIssueName("");
    setMobileNav(false);
    setEvidencePage(0);
    window.requestAnimationFrame(() =>
      heading.current?.focus({ preventScroll: true }),
    );
  }
  function changeScope(change: Partial<Scope>) {
    setScope((current) => ({ ...current, ...change }));
    setVoxQuestion("");
    setSourceRecord(null);
    sourceDialog.current?.close();
    setEvidencePage(0);
  }
  function resetScope(product = scope.product) {
    setVoxQuestion("");
    setSourceRecord(null);
    sourceDialog.current?.close();
    setScope(defaultFilters(product));
    setFromDraft("");
    setToDraft("");
    setDateError("");
    setEvidencePage(0);
  }
  function changeProduct(product: string) {
    resetScope(product);
    setIssueName("");
    setVoxInput("");
    setVoxQuestion("");
    setAnnouncement(`Showing feedback for ${product}.`);
  }
  function replaceDataset(next: WorkspaceDataset) {
    importGeneration.current++;
    setDataset(next);
    setScope(initialScope(next));
    setView("overview");
    setIssueName("");
    setFromDraft("");
    setToDraft("");
    setDateError("");
    setVoxInput("");
    setVoxQuestion("");
    setEvidencePage(0);
    setSourceRecord(null);
    setImportError("");
    setImportBusy(false);
    for (const ref of [sourceDialog, importDialog, voxDialog])
      ref.current?.close();
    setAnnouncement(
      `${next.records.length.toLocaleString()} records loaded. Files stay on this device.`,
    );
  }
  async function importFile(file?: File) {
    if (!file) return;
    const attempt = ++importGeneration.current;
    setImportError("");
    setImportBusy(true);
    try {
      if (file.size > IMPORT_LIMITS.bytes)
        throw new Error("Choose a file no larger than 5 MiB.");
      const text = await file.text();
      if (attempt !== importGeneration.current) return;
      const next = parseImport(text, file.name);
      replaceDataset(next);
    } catch (error) {
      if (attempt === importGeneration.current)
        setImportError(
          error instanceof Error
            ? error.message
            : "The file could not be read. Choose another JSON or JSONL file.",
        );
    } finally {
      if (attempt === importGeneration.current) setImportBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  function closeImport() {
    importGeneration.current++;
    setImportBusy(false);
    restoreFocus(importDialog);
  }
  function inspect(record: FeedbackRecord) {
    setSourceRecord(record);
    openDialog(sourceDialog);
  }
  function excludeThread(id: string) {
    if (scope.excludedThreadIds.includes(id)) return;
    sourceDialog.current?.close();
    changeScope({ excludedThreadIds: [...scope.excludedThreadIds, id] });
    setAnnouncement(
      "Thread excluded. Counts and evidence now use the remaining records.",
    );
  }
  function exportBrief() {
    const markdown = brief(dataset, scope, analysis);
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${scope.product.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "feedback"}-brief.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setAnnouncement("The brief for this evidence scope is ready to save.");
  }
  function ask(event: FormEvent) {
    event.preventDefault();
    if (voxInput.trim()) setVoxQuestion(voxInput.trim());
  }
  function applyDates(event: FormEvent) {
    event.preventDefault();
    if (fromDraft && toDraft && fromDraft > toDraft) {
      setDateError("From date must be on or before To date.");
      return;
    }
    setDateError("");
    changeScope({ from: fromDraft, to: toDraft });
    if (datesRef.current) datesRef.current.open = false;
  }
  function showIssue(issue: RankedIssue) {
    setEvidencePage(0);
    setIssueName(issue.name);
    setView("issues");
    window.requestAnimationFrame(() =>
      heading.current?.focus({ preventScroll: true }),
    );
  }

  const headingText =
    view === "overview"
      ? "What the feedback says"
      : view === "evidence"
        ? "The original evidence"
        : issueName || "Pain points";
  const sourceCounts = sourceOptions
    .map((source) => ({
      source,
      count: analysis.records.filter((record) => record.source === source)
        .length,
    }))
    .filter((item) => item.count > 0);
  const card = (record: FeedbackRecord) => (
    <EvidenceCard key={record.id} record={record} onInspect={inspect} />
  );

  return (
    <div className="workspace-app">
      <a className="ws-skip" href="#workspace-main">
        Skip to content
      </a>
      {mobileNav && (
        <button
          className="ws-nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`ws-sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="ws-brand">
          <AudioLines aria-hidden="true" />
          <span>
            overheard<span className="ws-brand-dot">.</span>
          </span>
          <button
            className="ws-icon-button ws-mobile-only"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="ws-workspace-label">
          <span className="ws-workspace-symbol">O</span>
          <div>
            <strong>Your evidence workspace</strong>
            <span>Runs on this device</span>
          </div>
        </div>
        <p className="ws-nav-label">Workspace</p>
        <nav className="ws-navigation" aria-label="Workspace navigation">
          <button
            className={view === "overview" ? "active" : ""}
            aria-current={view === "overview" ? "page" : undefined}
            onClick={() => navigate("overview")}
          >
            <BarChart3 size={17} />
            Overview
          </button>
          <button
            className={view === "issues" ? "active" : ""}
            aria-current={view === "issues" ? "page" : undefined}
            onClick={() => navigate("issues")}
          >
            <MessageSquare size={17} />
            Pain points
            <span className="ws-nav-count">{analysis.issues.length}</span>
          </button>
          <button
            className={view === "evidence" ? "active" : ""}
            aria-current={view === "evidence" ? "page" : undefined}
            onClick={() => navigate("evidence")}
          >
            <Inbox size={17} />
            Evidence
          </button>
        </nav>
        <label className="ws-product">
          <span className="ws-nav-label">Product</span>
          <select
            aria-label="Product"
            value={scope.product}
            onChange={(event) => changeProduct(event.target.value)}
          >
            {productOptions.map((product) => (
              <option key={product}>{product}</option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <div className="ws-dataset-card">
          <span
            className={`ws-badge ${dataset.provenance === "synthetic" ? "sample" : ""}`}
          >
            {dataset.provenance === "synthetic"
              ? "Synthetic sample"
              : "Your imported data"}
          </span>
          <strong title={dataset.label}>{dataset.label}</strong>
          <p>
            {dataset.records.length.toLocaleString()} records ·{" "}
            {productOptions.length} product
            {productOptions.length === 1 ? "" : "s"}
          </p>
          <button
            className="ws-text-button"
            onClick={() => openDialog(importDialog)}
          >
            <Upload size={13} />
            Import feedback
          </button>
        </div>
        <div className="ws-sidebar-bottom">
          <button onClick={() => replaceDataset(sampleDataset)}>
            <RotateCcw size={15} />
            Reset to sample
          </button>
          <button
            onClick={() => {
              setMediaError(false);
              openDialog(mediaDialog);
            }}
          >
            <Play size={15} />
            Walkthrough
          </button>
          {localResearch && (
            <a
              title="Open the configured local research backend"
              href={localResearch}
            >
              <ExternalLink size={15} />
              Connected research
            </a>
          )}
          <p>
            <span className="ws-status-dot" />
            Browser analysis · no provider calls
          </p>
        </div>
      </aside>

      <div className="ws-main-wrap">
        <header className="ws-topbar">
          <div className="ws-breadcrumb">
            <button
              className="ws-icon-button ws-mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <strong>{scope.product}</strong>
          </div>
          <div className="ws-top-actions">
            <span className="ws-private-note">
              Your files stay on this device
            </span>
            <button
              className="ws-button ws-vox-trigger"
              onClick={() => openDialog(voxDialog)}
            >
              <AudioLines size={16} />
              Ask Vox
            </button>
          </div>
        </header>
        <main id="workspace-main" className="ws-main" tabIndex={-1}>
          <div className="ws-page-heading">
            <div>
              {issueName && view === "issues" ? (
                <button className="ws-back" onClick={() => setIssueName("")}>
                  <ArrowLeft size={13} />
                  All pain points
                </button>
              ) : (
                <p className="ws-eyebrow">
                  {view === "overview"
                    ? "Your feedback, in focus"
                    : view === "issues"
                      ? "Patterns in the evidence"
                      : "Keep the context"}
                </p>
              )}
              <h1 ref={heading} tabIndex={-1}>
                {headingText}
              </h1>
              <p>
                {view === "overview"
                  ? "Find the recurring issues. Read the comments. Check what changes the result."
                  : view === "issues"
                    ? "Ranked by records with a supplied issue label, within your current scope."
                    : "Search and inspect the complete records behind the summaries."}
              </p>
            </div>
            <button
              className="ws-button ws-export"
              onClick={exportBrief}
              disabled={!analysis.records.length}
            >
              <Download size={15} />
              Export brief
            </button>
          </div>

          <section className="ws-filter-bar" aria-label="Evidence scope">
            <label className="ws-search">
              <Search size={16} />
              <input
                aria-label="Search loaded evidence"
                type="search"
                placeholder="Search feedback…"
                value={scope.query}
                onChange={(event) => changeScope({ query: event.target.value })}
              />
            </label>
            <label className="ws-filter-select">
              <span>Source</span>
              <select
                aria-label="Filter by source"
                value={scope.sources[0] ?? ""}
                onChange={(event) =>
                  changeScope({
                    sources: event.target.value ? [event.target.value] : [],
                  })
                }
              >
                <option value="">All sources</option>
                {sourceOptions.map((source) => (
                  <option key={source} value={source}>
                    {sourceName(source)}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <label className="ws-filter-select">
              <span>Sentiment</span>
              <select
                aria-label="Filter by sentiment"
                value={scope.sentiment}
                onChange={(event) =>
                  changeScope({
                    sentiment: event.target.value as Scope["sentiment"],
                  })
                }
              >
                {[
                  "all",
                  "negative",
                  "positive",
                  "neutral",
                  "mixed",
                  "unknown",
                ].map((sentiment) => (
                  <option key={sentiment} value={sentiment}>
                    {sentiment === "all"
                      ? "Any label"
                      : sentiment.charAt(0).toUpperCase() + sentiment.slice(1)}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <details className="ws-date-filter" ref={datesRef}>
              <summary>
                <Filter size={13} />
                {scope.from || scope.to ? "Dates applied" : "All dates"}
                <ChevronDown size={12} />
              </summary>
              <form onSubmit={applyDates}>
                <label>
                  From
                  <input
                    type="date"
                    aria-label="From date"
                    value={fromDraft}
                    onChange={(event) => setFromDraft(event.target.value)}
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    aria-label="To date"
                    value={toDraft}
                    onChange={(event) => setToDraft(event.target.value)}
                  />
                </label>
                {dateError && (
                  <p role="alert" className="ws-form-error">
                    {dateError}
                  </p>
                )}
                <button type="submit" className="ws-button ws-accent">
                  Apply dates
                </button>
              </form>
            </details>
            {filtered && (
              <button className="ws-reset-scope" onClick={() => resetScope()}>
                <RotateCcw size={13} />
                Reset scope
              </button>
            )}
          </section>
          <div className="ws-scope-caption">
            <span>
              {analysis.metrics.scopedRecords.toLocaleString()} of{" "}
              {totalProductRecords.toLocaleString()} product records in scope
            </span>
            <span
              className={`ws-badge ${dataset.provenance === "synthetic" ? "sample" : ""}`}
            >
              {dataset.provenance === "synthetic"
                ? "Synthetic AcmeFlow / OrbitQuest data"
                : "Imported labels · not independently verified"}
            </span>
          </div>
          {scope.excludedThreadIds.length > 0 && (
            <div className="ws-excluded" aria-label="Excluded threads">
              <span>
                {scope.excludedThreadIds.length} thread
                {scope.excludedThreadIds.length === 1 ? "" : "s"} excluded
              </span>
              {scope.excludedThreadIds.map((id) => (
                <button
                  key={id}
                  onClick={() =>
                    changeScope({
                      excludedThreadIds: scope.excludedThreadIds.filter(
                        (item) => item !== id,
                      ),
                    })
                  }
                >
                  <RotateCcw size={11} />
                  Restore{" "}
                  {dataset.records.find((record) => record.threadId === id)
                    ?.threadTitle || "thread"}
                </button>
              ))}
            </div>
          )}
          {dataset.importReport && (
            <details className="ws-import-report">
              <summary>
                <Check size={13} />
                Import report · {dataset.importReport.acceptedRows} accepted
                {dataset.importReport.rejectedRows
                  ? ` · ${dataset.importReport.rejectedRows} rejected`
                  : ""}
                {dataset.importReport.duplicateRows
                  ? ` · ${dataset.importReport.duplicateRows} duplicates`
                  : ""}
                <ChevronDown size={12} />
              </summary>
              <p>
                {dataset.importReport.inputRows} rows read.{" "}
                {dataset.importReport.warnings.length
                  ? dataset.importReport.warnings.join(" ")
                  : "No import warnings."}
              </p>
            </details>
          )}

          {view === "overview" && (
            <>
              <section
                className="ws-metrics"
                aria-label="Current evidence counts"
              >
                <Metric
                  value={analysis.metrics.scopedRecords}
                  label="Records in scope"
                  note="All filters and exclusions applied"
                />
                <Metric
                  value={analysis.metrics.complaints}
                  label="Labeled complaints"
                  note="Supplied labels, not verified facts"
                />
                <Metric
                  value={analysis.metrics.sourceCount}
                  label="Sources represented"
                  note={`${analysis.metrics.threadCount} separate threads`}
                />
                <Metric
                  value={analysis.metrics.unlabeled}
                  label="Unknown sentiment"
                  note="Kept visible without an assumed label"
                />
              </section>
              <section className="ws-section">
                <div className="ws-section-heading">
                  <div>
                    <h2>Issues to investigate</h2>
                    <p>
                      Start with a repeated label. Read its evidence before
                      deciding what to change.
                    </p>
                  </div>
                  <button
                    className="ws-text-button"
                    onClick={() => navigate("issues")}
                  >
                    All pain points
                    <ArrowRight size={13} />
                  </button>
                </div>
                <div className="ws-issue-list">
                  {analysis.issues.slice(0, 3).map((issue, index) => (
                    <button
                      className="ws-issue-card"
                      key={issue.name}
                      onClick={() => showIssue(issue)}
                    >
                      <span className="ws-rank">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <h3>{issue.name}</h3>
                        <p>
                          {issue.count} record{issue.count === 1 ? "" : "s"}{" "}
                          carry this issue label.
                        </p>
                        <span>Inspect the original feedback</span>
                      </div>
                      <ArrowRight size={17} />
                    </button>
                  ))}
                  {!analysis.issues.length && (
                    <Empty
                      title="No issue labels in this scope"
                      description="You can still read the feedback. Broaden the scope or inspect records without issue labels."
                      action={
                        <button
                          className="ws-button"
                          onClick={() => navigate("evidence")}
                        >
                          Browse evidence
                          <ArrowRight size={14} />
                        </button>
                      }
                    />
                  )}
                </div>
              </section>
              <div className="ws-context-grid">
                <section className="ws-surface ws-source-mix">
                  <div className="ws-section-heading">
                    <div>
                      <h2>Source mix</h2>
                      <p>Different sources reach different audiences.</p>
                    </div>
                  </div>
                  {sourceCounts.map(({ source, count }) => (
                    <div className="ws-source-row" key={source}>
                      <span>{sourceName(source)}</span>
                      <span className="ws-source-bar">
                        <i
                          style={{
                            width: `${(count / Math.max(analysis.records.length, 1)) * 100}%`,
                          }}
                        />
                      </span>
                      <strong>{count}</strong>
                    </div>
                  ))}
                  {!sourceCounts.length && (
                    <p className="ws-muted">
                      No sources match the current filters.
                    </p>
                  )}
                </section>
                <section className="ws-surface ws-concentration">
                  <p className="ws-eyebrow">Check the concentration</p>
                  <h2>
                    {largestThread ? (
                      <>
                        {largestThread.count}{" "}
                        <span>of {analysis.records.length} records</span>
                      </>
                    ) : (
                      "No matching threads"
                    )}
                  </h2>
                  <p>
                    {largestThread ? (
                      <>
                        come from <strong>{largestThread.title}</strong>.
                        Exclude it to see what the other threads say.
                      </>
                    ) : (
                      "Broaden the scope to inspect discussion threads."
                    )}
                  </p>
                  {largestThread && (
                    <button
                      className="ws-button"
                      onClick={() => excludeThread(largestThread.id)}
                    >
                      Exclude largest thread
                      <ArrowRight size={14} />
                    </button>
                  )}
                </section>
              </div>
              <section className="ws-section">
                <div className="ws-section-heading">
                  <div>
                    <h2>A closer look at the feedback</h2>
                    <p>
                      A few records from the current scope. Open any record for
                      the full text.
                    </p>
                  </div>
                  <button
                    className="ws-text-button"
                    onClick={() => navigate("evidence")}
                  >
                    All evidence
                    <ArrowRight size={13} />
                  </button>
                </div>
                <div className="ws-evidence-grid">
                  {balancedEvidence(analysis.records, 4).map(card)}
                </div>
                {!analysis.records.length && (
                  <Empty
                    title="No matching feedback"
                    description="Change a filter or restore an excluded thread. Your loaded records are still available."
                    action={
                      <button
                        className="ws-button"
                        onClick={() => resetScope()}
                      >
                        Reset scope
                      </button>
                    }
                  />
                )}
              </section>
            </>
          )}

          {view === "issues" && !issueName && (
            <section className="ws-surface ws-issues-table-wrap">
              <table className="ws-issues-table">
                <thead>
                  <tr>
                    <th>Issue label</th>
                    <th>Records</th>
                    <th>Sources</th>
                    <th>
                      <span className="ws-sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.issues
                    .slice(evidencePage * 20, (evidencePage + 1) * 20)
                    .map((issue) => (
                      <tr key={issue.name}>
                        <td>
                          <button onClick={() => showIssue(issue)}>
                            {issue.name}
                          </button>
                        </td>
                        <td>{issue.count}</td>
                        <td>
                          {
                            new Set(
                              analysis.records
                                .filter(
                                  (record) =>
                                    record.relevant !== false &&
                                    record.issues.includes(issue.name),
                                )
                                .map((record) => record.source),
                            ).size
                          }
                        </td>
                        <td>
                          <button
                            className="ws-text-button"
                            onClick={() => showIssue(issue)}
                            aria-label={`Review ${issue.name}`}
                          >
                            Review
                            <ArrowRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <Pagination
                page={evidencePage}
                total={analysis.issues.length}
                onChange={setEvidencePage}
                label="pain points"
              />
              {!analysis.issues.length && (
                <Empty
                  title="No matching issue labels"
                  description="Change the scope or go to Evidence to inspect unlabeled records."
                />
              )}
              <p className="ws-table-note">
                Issue counts can overlap: one record can carry more than one
                label. These are patterns to inspect, not a priority score.
              </p>
            </section>
          )}
          {view === "issues" && issueName && (
            <section className="ws-section">
              <div className="ws-issue-detail-note">
                <MessageSquare size={19} />
                <div>
                  <h2>
                    {selectedIssue
                      ? `${selectedIssue.count} supporting records`
                      : "No records in this scope"}
                  </h2>
                  <p>
                    Read the records and their context. A repeated label does
                    not establish the cause or urgency of a problem.
                  </p>
                </div>
                <button
                  className="ws-button"
                  onClick={() => {
                    setVoxInput(issueName);
                    setVoxQuestion(issueName);
                    openDialog(voxDialog);
                  }}
                >
                  Search with Vox
                  <ArrowRight size={14} />
                </button>
              </div>
              <div className="ws-evidence-grid">
                {issueRecords
                  .slice(evidencePage * 20, (evidencePage + 1) * 20)
                  .map(card)}
              </div>
              <Pagination
                page={evidencePage}
                total={issueRecords.length}
                onChange={setEvidencePage}
              />
              {!selectedIssue && (
                <Empty
                  title="This label is outside the current scope"
                  description="The filters remain active. Reset the scope or choose another pain point."
                  action={
                    <button
                      className="ws-button"
                      onClick={() => setIssueName("")}
                    >
                      All pain points
                    </button>
                  }
                />
              )}
            </section>
          )}
          {view === "evidence" && (
            <section className="ws-section">
              <p className="ws-evidence-note">
                Showing {analysis.records.length ? evidencePage * 20 + 1 : 0}–
                {Math.min((evidencePage + 1) * 20, analysis.records.length)} of{" "}
                {analysis.records.length} records. Original text and unknown
                labels remain visible.
                {analysis.metrics.irrelevant > 0
                  ? ` ${analysis.metrics.irrelevant} records are explicitly labeled irrelevant and are not used for issue summaries.`
                  : ""}
              </p>
              <div className="ws-evidence-grid">
                {analysis.records
                  .slice(evidencePage * 20, (evidencePage + 1) * 20)
                  .map(card)}
              </div>
              <Pagination
                page={evidencePage}
                total={analysis.records.length}
                onChange={setEvidencePage}
              />
              {!analysis.records.length && (
                <Empty
                  title="No matching feedback"
                  description="Try a different search, clear a date range, or restore an excluded thread."
                  action={
                    <button className="ws-button" onClick={() => resetScope()}>
                      Reset scope
                    </button>
                  }
                />
              )}
            </section>
          )}
          <details className="ws-limitations">
            <summary>
              Scope and evidence notes
              <ChevronDown size={13} />
            </summary>
            <p>{analysis.scopeDescription}</p>
            <ul>
              {analysis.limitations.map((limitation, index) => (
                <li key={index}>{limitation}</li>
              ))}
            </ul>
            <p>
              Files are processed in this browser and kept in memory. Reloading
              the page returns to the sample. Source links open external
              websites only when you select them.
            </p>
          </details>
          <footer className="ws-footer">
            <span>
              OverHeard<span> · </span>Evidence before decisions.
            </span>
            <a
              href="https://github.com/tyseer2335/OverHeard"
              target="_blank"
              rel="noopener noreferrer"
            >
              Team project
              <ExternalLink size={11} />
            </a>
          </footer>
        </main>
      </div>

      <dialog
        ref={sourceDialog}
        className="ws-dialog ws-source-dialog"
        aria-labelledby="ws-source-title"
        onClose={() => restoreFocus(sourceDialog)}
      >
        <DialogHeader
          title="Original feedback"
          id="ws-source-title"
          eyebrow={
            sourceRecord?.provenance === "synthetic"
              ? "Synthetic sample record"
              : "Imported record"
          }
          onClose={() => sourceDialog.current?.close()}
        />
        {sourceRecord && (
          <>
            <div className="ws-original-meta">
              <Sentiment sentiment={sourceRecord.sentiment} />
              <span>{sourceName(sourceRecord.source)}</span>
              <span>{displayDate(sourceRecord.publishedAt)}</span>
            </div>
            <h3>{sourceRecord.threadTitle}</h3>
            <blockquote className="ws-full-quote">
              {sourceRecord.text}
            </blockquote>
            <dl className="ws-record-fields">
              <dt>Product</dt>
              <dd>{sourceRecord.product}</dd>
              <dt>Issue labels</dt>
              <dd>{sourceRecord.issues.join(", ") || "Not supplied"}</dd>
              <dt>Complaint label</dt>
              <dd>
                {sourceRecord.isComplaint === null
                  ? "Unknown"
                  : sourceRecord.isComplaint
                    ? "Complaint"
                    : "Not a complaint"}
              </dd>
              <dt>Relevance label</dt>
              <dd>
                {sourceRecord.relevant === null
                  ? "Unknown"
                  : sourceRecord.relevant
                    ? "Relevant"
                    : "Irrelevant"}
              </dd>
            </dl>
            <p className="ws-record-id">Record {sourceRecord.id}</p>
            <div className="ws-dialog-actions">
              {sourceHref(sourceRecord.url) && (
                <a
                  className="ws-button ws-accent"
                  href={sourceHref(sourceRecord.url)!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open original source
                  <ExternalLink size={14} />
                </a>
              )}
              <button
                className="ws-button"
                disabled={scope.excludedThreadIds.includes(
                  sourceRecord.threadId,
                )}
                onClick={() => excludeThread(sourceRecord.threadId)}
              >
                Exclude this thread
              </button>
            </div>
            {!sourceHref(sourceRecord.url) && (
              <p className="ws-muted">
                {sourceRecord.provenance === "synthetic"
                  ? "This is an invented sample. It has no external source URL."
                  : "No valid web source URL was supplied."}
              </p>
            )}
          </>
        )}
      </dialog>

      <dialog
        ref={importDialog}
        className="ws-dialog ws-import-dialog"
        aria-labelledby="ws-import-title"
        onClose={closeImport}
      >
        <DialogHeader
          title="Bring your feedback"
          id="ws-import-title"
          eyebrow="No upload. No account required."
          onClose={() => importDialog.current?.close()}
        />
        <p className="ws-dialog-description">
          Open an OverHeard export or a JSON / JSONL file. The data stays in
          this browser’s memory and replaces the current sample.
        </p>
        <label className="ws-file-picker">
          <FileJson size={28} />
          <strong>
            {importBusy ? "Reading file…" : "Choose JSON or JSONL file"}
          </strong>
          <span>Up to 5 MiB · 5,000 records</span>
          <input
            ref={fileInput}
            type="file"
            aria-label="Choose JSON or JSONL file"
            accept=".json,.jsonl,.ndjson,application/json,application/x-ndjson"
            disabled={importBusy}
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
        </label>
        {importBusy && (
          <p className="ws-muted" role="status">
            Reading and checking the file on this device…
          </p>
        )}
        {importError && (
          <div className="ws-form-error" role="alert">
            <CircleAlert size={16} />
            <p>{importError}</p>
          </div>
        )}
        <details className="ws-import-help">
          <summary>
            Accepted record formats
            <ChevronDown size={13} />
          </summary>
          <p>
            Use a JSON array, an OverHeard CLI export, or one JSON object per
            line. Normalized records need external_id, product, source, and
            content. Raw CLI exports are also supported. Date, sentiment, and
            issue labels are kept when supplied; missing labels stay unknown.
          </p>
          <pre>
            {
              '{"external_id":"1","product":"My product","content":"The setup was confusing.","source":"hackernews","sentiment":"negative","issue_categories":["onboarding"]}'
            }
          </pre>
        </details>
        <p className="ws-muted">
          Nothing is sent to a server. Export your brief before reloading the
          page if you want to keep the result.
        </p>
      </dialog>

      <dialog
        ref={voxDialog}
        className="ws-dialog ws-vox-dialog"
        aria-labelledby="ws-vox-title"
        onClose={() => restoreFocus(voxDialog)}
      >
        <DialogHeader
          title="Vox"
          id="ws-vox-title"
          eyebrow="Evidence search · on this device"
          onClose={() => voxDialog.current?.close()}
        />
        <div className="ws-vox-intro">
          <AudioLines size={27} />
          <h3>A question starts with the evidence.</h3>
          <p>
            Search the records in your current scope. Vox returns source matches
            and counts. It does not generate an AI answer or use a microphone.
          </p>
        </div>
        <div className="ws-vox-scope">
          <span className="ws-status-dot" />
          {scope.product} · {analysis.records.length} records in scope
        </div>
        <form className="ws-vox-form" onSubmit={ask}>
          <label htmlFor="ws-vox-question">Search evidence with Vox</label>
          <div>
            <input
              id="ws-vox-question"
              value={voxInput}
              onChange={(event) => setVoxInput(event.target.value)}
              placeholder="What do people say about pricing?"
              maxLength={1000}
            />
            <button
              className="ws-button ws-accent"
              type="submit"
              aria-label="Search with Vox"
              disabled={!voxInput.trim()}
            >
              <ArrowRight size={17} />
            </button>
          </div>
        </form>
        <div className="ws-vox-suggestions">
          {[
            "Summarize the feedback",
            "Show positive feedback",
            ...analysis.issues.slice(0, 2).map((issue) => issue.name),
          ].map((question) => (
            <button
              key={question}
              onClick={() => {
                setVoxInput(question);
                setVoxQuestion(question);
              }}
            >
              {question}
            </button>
          ))}
        </div>
        {voxAnswer && (
          <section
            className="ws-vox-answer"
            aria-label="Evidence search results"
          >
            <span className="ws-eyebrow">Search result</span>
            <p>{voxAnswer.text}</p>
            <div className="ws-vox-citations">
              {voxAnswer.citations.map((record, index) => (
                <button key={record.id} onClick={() => inspect(record)}>
                  <span>
                    Source {index + 1}
                    <ExternalLink size={11} />
                  </span>
                  <p>
                    {record.text.length > 220
                      ? `${record.text.slice(0, 220).trimEnd()}…`
                      : record.text}
                  </p>
                  <small>
                    {sourceName(record.source)} ·{" "}
                    {displayDate(record.publishedAt)}
                  </small>
                </button>
              ))}
            </div>
            {voxAnswer.limitations.length > 0 && (
              <details>
                <summary>
                  Search limits
                  <ChevronDown size={12} />
                </summary>
                <ul>
                  {voxAnswer.limitations.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
        <p className="ws-vox-footer">
          Search uses the loaded records only. Source, sentiment, date, and
          thread filters also apply here.
        </p>
      </dialog>

      <dialog
        ref={mediaDialog}
        className="ws-dialog ws-media-dialog"
        aria-labelledby="ws-media-title"
        onClose={() => {
          mediaRef.current?.pause();
          restoreFocus(mediaDialog);
        }}
      >
        <DialogHeader
          title="A recorded walkthrough"
          id="ws-media-title"
          eyebrow="See the evidence workflow"
          onClose={() => mediaDialog.current?.close()}
        />
        <video
          ref={mediaRef}
          controls
          playsInline
          preload="metadata"
          poster={`${mediaBase}poster.webp`}
          aria-label="OverHeard evidence workflow walkthrough"
          onError={() => setMediaError(true)}
        >
          <source src={`${mediaBase}walkthrough.mp4`} type="video/mp4" />
          <track
            kind="captions"
            src={`${mediaBase}captions.vtt`}
            srcLang="en"
            label="English"
            default
          />
        </video>
        {mediaError && (
          <p className="ws-form-error" role="alert">
            The walkthrough is unavailable. You can continue exploring the
            workspace.
          </p>
        )}
        <p className="ws-muted">
          A recorded example using synthetic feedback. The workspace above works
          with your own imported records.
        </p>
      </dialog>
      <p className="ws-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

function Metric({
  value,
  label,
  note,
}: {
  value: number;
  label: string;
  note: string;
}) {
  return (
    <article>
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
      <p>{note}</p>
    </article>
  );
}
function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="ws-empty">
      <Inbox size={27} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function DialogHeader({
  title,
  id,
  eyebrow,
  onClose,
}: {
  title: string;
  id: string;
  eyebrow: string;
  onClose: () => void;
}) {
  return (
    <header className="ws-dialog-header">
      <div>
        <p className="ws-eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      <button
        className="ws-icon-button"
        aria-label={`Close ${title === "Vox" ? "Vox" : title.toLowerCase()}`}
        onClick={onClose}
      >
        <X size={20} />
      </button>
    </header>
  );
}
function Sentiment({ sentiment }: { sentiment: FeedbackRecord["sentiment"] }) {
  return (
    <span className={`ws-sentiment ${sentiment}`}>
      <i aria-hidden="true" />
      {sentiment === "unknown" ? "Unknown sentiment" : sentiment}
    </span>
  );
}
function EvidenceCard({
  record,
  onInspect,
}: {
  record: FeedbackRecord;
  onInspect: (record: FeedbackRecord) => void;
}) {
  const excerpt =
    record.text.length > 360
      ? `${record.text
          .slice(0, 360)
          .replace(/\s+\S*$/, "")
          .trimEnd()}…`
      : record.text;
  return (
    <article className="ws-evidence-card">
      <div className="ws-evidence-meta">
        <span>{sourceName(record.source)}</span>
        <Sentiment sentiment={record.sentiment} />
      </div>
      <blockquote>{excerpt}</blockquote>
      <div className="ws-evidence-bottom">
        <span title={record.threadTitle}>{record.threadTitle}</span>
        <span>{displayDate(record.publishedAt)}</span>
      </div>
      <div className="ws-evidence-actions">
        <button className="ws-text-button" onClick={() => onInspect(record)}>
          Read full record
          <ArrowRight size={12} />
        </button>
        {record.relevant === false && (
          <span className="ws-badge">Labeled irrelevant</span>
        )}
        {record.provenance === "synthetic" && (
          <span className="ws-badge sample">Synthetic</span>
        )}
      </div>
    </article>
  );
}

function Pagination({
  page,
  total,
  onChange,
  label = "records",
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
  label?: string;
}) {
  if (total <= 20) return null;
  return (
    <nav
      className="ws-pagination"
      aria-label={`${label === "records" ? "Evidence" : "Pain point"} pages`}
    >
      <button
        className="ws-button"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        <ArrowLeft size={14} />
        Previous {label}
      </button>
      <span>
        Page {page + 1} of {Math.ceil(total / 20)}
      </span>
      <button
        className="ws-button"
        disabled={(page + 1) * 20 >= total}
        onClick={() => onChange(page + 1)}
      >
        Next {label}
        <ArrowRight size={14} />
      </button>
    </nav>
  );
}
