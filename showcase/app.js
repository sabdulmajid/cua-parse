import {
  metricsFor,
  pricingMetrics,
  sourcesFor,
  steps,
  validateSample,
} from "./render.js";

const byId = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
let sample;
let activeStep = "overview";
let dialogOpener;

const copy = {
  overview: {
    kicker: "01 / FINDINGS",
    title: "What does the sample say?",
    scope: "All feedback",
    nextTitle: "Take a closer look.",
    nextDescription:
      "Narrow the evidence to pricing before drawing a conclusion.",
    action: "Focus on pricing",
    next: "pricing",
  },
  pricing: {
    kicker: "02 / PRICING",
    title: "Look at the pricing feedback.",
    scope: "Pricing",
    nextTitle: "Test the effect of one thread.",
    nextDescription:
      "Exclude the largest discussion and compare the remaining feedback.",
    action: "Exclude dominant thread",
    next: "excluded",
  },
  excluded: {
    kicker: "03 / SCOPE",
    title: "The scope changes the picture.",
    scope: "Dominant thread excluded",
    nextTitle: "Now test the conclusion.",
    nextDescription:
      "Find positive pricing feedback that challenges a negative conclusion.",
    action: "Challenge conclusion",
    next: "challenge",
  },
  challenge: {
    kicker: "04 / CHALLENGE",
    title: "What points the other way?",
    scope: "Opposing evidence",
    nextTitle: "Take the evidence with you.",
    nextDescription:
      "The brief includes the findings, citations, scope, and sample limits.",
    action: "Export brief",
    next: null,
  },
};

function announce(message) {
  byId("announcement").textContent = message;
}

function openDialog(title, content) {
  dialogOpener = document.activeElement;
  byId("source-dialog-title").textContent = title;
  byId("source-dialog-content").replaceChildren(...content);
  byId("source-dialog").showModal();
}

function inspect(ids) {
  const records = sourcesFor(sample.states[activeStep]);
  const selected = ids
    ? records.filter((record) => ids.includes(record.id))
    : records;
  const cards = selected.map((record) => {
    const card = node("article", undefined, "source-card");
    const meta = node("div", undefined, "source-meta");
    meta.append(
      node(
        "span",
        `Source ${records.findIndex((item) => item.id === record.id) + 1}`,
      ),
      node("span", "Synthetic record"),
    );
    card.append(
      meta,
      node("h3", record.threadTitle),
      node("blockquote", record.text),
      node("p", record.id, "source-id"),
    );
    return card;
  });
  openDialog(
    "Source feedback",
    cards.length
      ? cards
      : [node("p", "No source feedback is included in this scope.")],
  );
}

function renderComparison() {
  const panel = byId("scope-comparison");
  panel.replaceChildren();
  panel.hidden = activeStep === "overview";
  if (panel.hidden) return;
  const pricing = sample.states.pricing;
  const dominant = pricing.metrics.threads.find(
    (thread) => thread.threadId === sample.dominantThreadId,
  );
  if (activeStep === "pricing") {
    panel.append(node("span", "A SCOPE CHECK", "field-label"));
    if (dominant)
      panel.append(
        node(
          "p",
          `${dominant.count} of ${pricing.metrics.scopedRecords} scoped pricing records come from one thread.`,
          "comparison-title",
        ),
      );
    panel.append(
      node(
        "p",
        "Does that discussion represent the rest of the sample?",
        "comparison-note",
      ),
    );
  } else {
    const before = pricingMetrics(pricing);
    const after = pricingMetrics(sample.states.excluded);
    panel.append(node("span", "NEGATIVE PRICING MENTIONS", "field-label"));
    const change = node("p", undefined, "comparison-value");
    change.append(
      node("span", String(before.negative)),
      node("span", "→", "comparison-arrow"),
      node("strong", String(after.negative)),
    );
    panel.append(
      change,
      node(
        "p",
        "After the dominant thread is excluded. The remaining feedback deserves a separate reading.",
        "comparison-note",
      ),
    );
  }
}

function showStep(step, focus = true) {
  if (!sample || !steps.includes(step)) return;
  activeStep = step;
  const packet = sample.states[step];
  const labels = copy[step];
  byId("sample-intro").hidden = true;
  byId("research-results").hidden = false;
  byId("restart").hidden = false;
  document.querySelectorAll("[data-step]").forEach((button) => {
    const current = button.dataset.step === step;
    button.setAttribute("aria-current", current ? "step" : "false");
    button.classList.toggle("active", current);
  });
  byId("answer-kicker").textContent = labels.kicker;
  byId("answer-title").textContent = labels.title;
  byId("scope-tag").textContent = labels.scope;
  byId("answer-summary").textContent = packet.spokenSummary;
  byId("sample-metrics").replaceChildren(
    ...metricsFor(packet, step).map(([value, label]) => {
      const metric = node("div", undefined, "metric");
      metric.append(node("strong", String(value)), node("span", label));
      return metric;
    }),
  );
  const records = sourcesFor(packet);
  byId("findings").replaceChildren(
    ...packet.findings.map((finding) => {
      const item = node("li");
      item.append(node("p", finding.text));
      const citations = node("div", undefined, "citations");
      for (const id of finding.evidenceIds) {
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) continue;
        const button = node("button", `Source ${index + 1}`, "citation");
        button.type = "button";
        button.addEventListener("click", () => inspect([id]));
        citations.append(button);
      }
      item.append(citations);
      return item;
    }),
  );
  byId("inspect-sources").hidden = !records.length;
  renderComparison();
  byId("next-title").textContent = labels.nextTitle;
  byId("next-description").textContent = labels.nextDescription;
  byId("next-step").replaceChildren(
    node("span", labels.action),
    node("span", labels.next ? "→" : "↓"),
  );
  announce(
    `${labels.title} ${packet.metrics.relevantRecords} relevant records in this scope.`,
  );
  if (focus) byId("answer-title").focus();
}

function exportBrief() {
  const url = URL.createObjectURL(
    new Blob([sample.briefs.challenge], {
      type: "text/markdown;charset=utf-8",
    }),
  );
  const link = node("a");
  link.href = url;
  link.download = "acmeflow-decision-brief.md";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce("The decision brief is ready to save.");
}

async function loadSample() {
  byId("sample-error").hidden = true;
  byId("sample-loading").hidden = false;
  try {
    const response = await fetch("./data/demo.json");
    if (!response.ok) throw new Error("The sample is unavailable.");
    sample = validateSample(await response.json());
    byId("research-question").textContent = sample.question;
    byId("sample-content").hidden = false;
  } catch {
    byId("sample-error").hidden = false;
    byId("sample-content").hidden = true;
  } finally {
    byId("sample-loading").hidden = true;
  }
}

byId("show-findings").addEventListener("click", () => showStep("overview"));
byId("next-step").addEventListener("click", () =>
  copy[activeStep].next ? showStep(copy[activeStep].next) : exportBrief(),
);
document
  .querySelectorAll("[data-step]")
  .forEach((button) =>
    button.addEventListener("click", () => showStep(button.dataset.step)),
  );
byId("restart").addEventListener("click", () => {
  byId("sample-intro").hidden = false;
  byId("research-results").hidden = true;
  byId("restart").hidden = true;
  byId("show-findings").focus();
  announce("The sample has returned to the research question.");
});
byId("inspect-sources").addEventListener("click", () => inspect());
byId("sample-details").addEventListener("click", () => {
  const list = node("ul", undefined, "limitations");
  for (const text of sample.states[activeStep].limitations)
    list.append(node("li", text));
  openDialog("About the evidence", [
    node(
      "p",
      "AcmeFlow is a fictional product. The feedback, threads, and labels in this sample are synthetic. These saved outputs were produced by the research application, including the counts for each scope.",
    ),
    list,
  ]);
});
byId("close-sources").addEventListener("click", () =>
  byId("source-dialog").close(),
);
byId("source-dialog").addEventListener("close", () => dialogOpener?.focus());
byId("retry-sample").addEventListener("click", () => void loadSample());
void loadSample();
