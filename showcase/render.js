export const steps = ["overview", "pricing", "excluded", "challenge"];

export function sourcesFor(packet) {
  const records = new Map(
    [...packet.evidence, ...packet.opposingEvidence].map((record) => [
      record.id,
      record,
    ]),
  );
  const ordered = new Map();
  for (const finding of packet.findings)
    for (const id of finding.evidenceIds)
      if (records.has(id)) ordered.set(id, records.get(id));
  for (const [id, record] of records) ordered.set(id, record);
  return [...ordered.values()];
}

export function pricingMetrics(packet) {
  return (
    packet.metrics.aspects.find((aspect) => aspect.aspect === "pricing") ?? {
      mentions: 0,
      positive: 0,
      negative: 0,
      neutral: 0,
      mixed: 0,
      unknown: 0,
    }
  );
}

export function metricsFor(packet, step) {
  if (step === "overview")
    return [
      [packet.metrics.relevantRecords, "relevant records"],
      [packet.metrics.collectedRecords, "collected records"],
      [packet.metrics.distinctThreads, "threads in scope"],
    ];
  const pricing = pricingMetrics(packet);
  return [
    [pricing.mentions, "pricing mentions"],
    [pricing.negative, "negative"],
    [pricing.positive, "positive"],
  ];
}

export function validateSample(sample) {
  if (
    sample?.schemaVersion !== 1 ||
    sample.synthetic !== true ||
    !sample.question ||
    !sample.briefs?.challenge
  )
    throw new Error("The saved sample is incomplete.");
  for (const step of steps) {
    const packet = sample.states?.[step];
    if (
      !packet?.metrics ||
      !Array.isArray(packet.findings) ||
      !Array.isArray(packet.evidence) ||
      !Array.isArray(packet.opposingEvidence)
    )
      throw new Error("A saved evidence scope is missing.");
    const sources = sourcesFor(packet);
    if (
      sources.some(
        (record) => record.provenance !== "synthetic" || record.url !== null,
      )
    )
      throw new Error(
        "The sample must contain only labeled synthetic sources.",
      );
    const ids = new Set(sources.map((record) => record.id));
    if (
      packet.findings.some((finding) =>
        finding.evidenceIds.some((id) => !ids.has(id)),
      )
    )
      throw new Error("A finding has no matching source.");
  }
  return sample;
}
