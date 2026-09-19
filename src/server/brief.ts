import type { EvidencePacket, DecisionBrief } from "../shared/contracts.js";
const plain = (value: string) =>
  value.replace(/[\\`*_{}[\]<>#|]/g, "\\$&").replace(/\r?\n/g, " ");
export function makeBrief(
  packet: EvidencePacket,
  product: string,
): DecisionBrief {
  const records = new Map(
    [...packet.evidence, ...packet.opposingEvidence].map((e) => [e.id, e]),
  );
  const lines = [
    `# ${plain(product)} — decision brief`,
    "",
    `Question: ${plain(packet.question)}`,
    `Evidence snapshot: ${packet.snapshotVersion}; scope: ${packet.scopeVersion}`,
    `Generated: ${packet.generatedAt}`,
    `Data: ${packet.provenance.join(", ") || "empty sample"}. Retrieval: ${packet.retrievalMode}.`,
    "",
    "## Scope and sample",
    `Collected records after deduplication: ${packet.metrics.collectedRecords}. Scoped records: ${packet.metrics.scopedRecords}. Relevant records: ${packet.metrics.relevantRecords}. Distinct scoped threads: ${packet.metrics.distinctThreads}.`,
    `Excluded threads: ${packet.filters.excludedThreadIds.map(plain).join(", ") || "none"}. Aspect: ${packet.filters.aspect || "all"}. Source: ${packet.filters.source || "all"}. Dates: ${packet.filters.from || "unbounded"} to ${packet.filters.to || "unbounded"}.`,
    "",
    "## Observations",
    ...packet.findings.map(
      (f) =>
        `- ${plain(f.text)} Citations: ${
          f.evidenceIds
            .filter((id) => records.has(id))
            .map(plain)
            .join(", ") || "No retrieved example; computed aggregate only."
        }`,
    ),
    "",
    "## Opposing evidence",
    ...(packet.opposingEvidence.length
      ? packet.opposingEvidence.map(
          (e) =>
            `- ${plain(e.id)}: ${plain(
              e.aspects
                .filter(
                  (a) =>
                    packet.filters.aspect === null ||
                    a.aspect === packet.filters.aspect,
                )
                .map((a) => a.quote)
                .join(" / ") || e.text,
            )}`,
        )
      : [
          "No opposing evidence was retrieved within this scope. This does not establish that none exists elsewhere.",
        ]),
    "",
    "## Proposed next steps (recommendations)",
    ...(packet.findings.length
      ? packet.findings.map(
          (f) =>
            `- Investigate ${plain(f.aspect)} with a small user interview or product experiment. Check the cited records (${f.evidenceIds.map(plain).join(", ") || "aggregate only"}) and test the opposite explanation before a product change.`,
        )
      : ["- Collect more relevant evidence before a product decision."]),
    "- Check concentration by thread and repeat the analysis after excluding the largest thread.",
    "- Confirm findings with independent customer research. Comments are not verified customers.",
    "",
    "## Evidence",
    ...Array.from(records.values()).flatMap((e) => [
      `### ${plain(e.id)}`,
      `Source: ${e.source}; ${e.provenance}. Thread: ${plain(e.threadTitle)} (${plain(e.threadId)}).`,
      `Published: ${e.publishedAt || "unknown"}; collected: ${e.collectedAt}.`,
      e.url
        ? `Original: <${e.url.replaceAll("<", "%3C").replaceAll(">", "%3E")}>`
        : e.provenance === "synthetic"
          ? "Synthetic evidence; no original public URL."
          : "No original URL supplied.",
      `> ${plain(e.text)}`,
      "",
    ]),
    "## Limitations",
    ...packet.limitations.map((x) => `- ${plain(x)}`),
    "",
    "This is a saved draft/export. No external ticket was created.",
  ];
  return {
    researchId: packet.researchId,
    scopeVersion: packet.scopeVersion,
    filename: `cua-parse-${packet.researchId.slice(0, 8)}-${packet.scopeVersion.slice(0, 8)}.md`,
    markdown: lines.join("\n"),
  };
}
