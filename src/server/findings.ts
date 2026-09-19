import type {
  EvidenceRecord,
  Finding,
  QueryInput,
} from "../shared/contracts.js";

/** Question focus selects examples; it does not change the population counted. */
export function questionSentiment(
  question: string,
): "negative" | "positive" | null {
  // Remove a bounded negative phrase before checking for requests for praise.
  const withoutNegativeLike = question.replace(
    /\bdon['’]?t(?:\s+(?:people|users|customers|they|you|we|i))?\s+like\b/gi,
    "",
  );
  const negative =
    withoutNegativeLike !== question ||
    /\b(sucks?|dislikes?|hate[ds]?|complaints?|problems?|frustrat\w*|drawbacks?|downsides?|weakness\w*|negative|criticism|bad|wrong)\b/i.test(
      question,
    );
  const positive =
    /\b(likes?|love[ds]?|praise|strengths?|benefits?|positive|good)\b/i.test(
      withoutNegativeLike,
    );
  return negative === positive ? null : negative ? "negative" : "positive";
}

/** Show actual validated source claims instead of substituting sentiment totals for an answer. */
export function sourceFindings(
  records: EvidenceRecord[],
  input: QueryInput,
  scope: string,
): Finding[] {
  const focus = input.challenge
    ? input.challengeSentiment === "negative"
      ? "positive"
      : "negative"
    : questionSentiment(input.question);
  const candidates = records
    .filter((r) => r.relevant && r.extractionStatus === "verified")
    .flatMap((record) =>
      record.aspects
        .filter(
          (label) =>
            (!input.filters.aspect || label.aspect === input.filters.aspect) &&
            (!focus ||
              label.sentiment === focus ||
              (!input.challenge && label.sentiment === "mixed")) &&
            record.text.includes(label.quote),
        )
        .map((label) => ({ record, label })),
    );
  // Direct complaints/praise come before mixed observations. Keep the exact
  // source text and avoid presenting a mixed feature-name quote as the lead issue.
  if (focus)
    candidates.sort(
      (a, b) =>
        Number(b.label.sentiment === focus) -
        Number(a.label.sentiment === focus),
    );
  const selected: typeof candidates = [];
  const seenQuotes = new Set<string>();
  const seenAspects = new Set<string>();
  const seenThreads = new Set<string>();
  for (const diverse of [true, false]) {
    for (const candidate of candidates) {
      if (selected.length >= 4) break;
      const key = candidate.label.quote
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      if (
        seenQuotes.has(key) ||
        (diverse &&
          seenAspects.has(candidate.label.aspect) &&
          seenThreads.has(candidate.record.threadId))
      )
        continue;
      selected.push(candidate);
      seenQuotes.add(key);
      seenAspects.add(candidate.label.aspect);
      seenThreads.add(candidate.record.threadId);
    }
  }
  return selected.map(({ record, label }, i) => {
    const quote = label.quote;
    const aspect = label.aspect[0].toUpperCase() + label.aspect.slice(1);
    return {
      id: `${scope}-source-${i}`,
      aspect: label.aspect,
      text: `${aspect}: “${quote}”`,
      evidenceIds: [record.id],
    };
  });
}
