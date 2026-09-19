/** Explicit, bounded, billable smoke check. Never run from the automatic test suite. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/server/config.js";
import { analyze } from "../src/server/analysis.js";
import { fixtureRecords } from "../fixtures/acmeflow.js";

const reportPath = path.resolve(".local/analysis-smoke.json");
const statusCodes: number[] = [];
const providerCodes: string[] = [];
const safeProviderCodes = new Set([
  "insufficient_quota",
  "rate_limit_exceeded",
  "invalid_api_key",
  "model_not_found",
  "permission_denied",
]);
const report = {
  status: "FAIL" as "PASS" | "FAIL",
  checkedAt: new Date().toISOString(),
  mode: "real-openai-structured-analysis",
  dataProvenance: "synthetic",
  keyPresent: Boolean(process.env.OPENAI_API_KEY?.trim()),
  model: null as string | null,
  testedRecordCount: 2,
  aspectsQuoteValidationPass: false,
  expectedAspectSentimentsPass: false,
  logicalAnalysisCalls: 0,
  httpRequestCount: 0,
  requestStatusCodes: statusCodes,
  providerErrorCodes: providerCodes,
  failureCategory: null as string | null,
  resultCounts: {
    records: 0,
    verified: 0,
    failed: 0,
    unlabeled: 0,
    aspectLabels: 0,
    duplicates: 0,
    failures: 0,
  },
  limitations: [
    "Inputs are synthetic. This verifies the live model path, not live source collection or a full voice session.",
  ],
};

function classifyFailure() {
  if (providerCodes.includes("insufficient_quota")) return "insufficient_quota";
  if (statusCodes.includes(401)) return "authentication_failed_http_401";
  if (statusCodes.includes(403)) return "permission_denied_http_403";
  if (statusCodes.includes(404))
    return "model_or_endpoint_unavailable_http_404";
  if (statusCodes.includes(429)) return "quota_or_rate_limit_http_429";
  if (statusCodes.some((status) => status >= 500))
    return "provider_server_error";
  return "structured_output_or_evidence_validation_failed";
}

async function main() {
  if (!report.keyPresent) {
    report.failureCategory = "OPENAI_API_KEY_missing";
    return;
  }
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch {
    report.failureCategory = "configuration_invalid";
    return;
  }
  report.model = config.OPENAI_ANALYSIS_MODEL;
  const selectedIds = ["fixture:praise-1", "fixture:mixed-1"];
  const inputs = selectedIds.map((id) =>
    fixtureRecords().find((record) => record.id === id)!,
  );
  if (inputs.some((record) => !record || record.provenance !== "synthetic")) {
    report.failureCategory = "synthetic_smoke_inputs_invalid";
    return;
  }
  const originals = new Map(inputs.map((record) => [record.id, record]));
  const originalFetch = globalThis.fetch;
  // Observe status only. Never inspect or save request headers, credentials, or prompt bodies.
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    statusCodes.push(response.status);
    report.httpRequestCount++;
    if (!response.ok) {
      try {
        const body: unknown = await response.clone().json();
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          body.error &&
          typeof body.error === "object" &&
          "code" in body.error &&
          typeof body.error.code === "string" &&
          safeProviderCodes.has(body.error.code)
        ) {
          providerCodes.push(body.error.code);
        }
      } catch {
        /* Status remains sufficient when an error body is absent or invalid. */
      }
    }
    return response;
  };
  try {
    report.logicalAnalysisCalls = 1;
    const result = await analyze(
      inputs,
      {
        researchId: randomUUID(),
        sessionId: randomUUID(),
        product: "AcmeFlow",
        snapshotVersion: 1,
      },
      {
        mode: "openai",
        model: config.OPENAI_ANALYSIS_MODEL,
        apiKey: config.OPENAI_API_KEY,
        signal: AbortSignal.timeout(75_000),
      },
    );
    report.resultCounts = {
      records: result.records.length,
      verified: result.records.filter(
        (record) => record.extractionStatus === "verified",
      ).length,
      failed: result.records.filter(
        (record) => record.extractionStatus === "failed",
      ).length,
      unlabeled: result.records.filter(
        (record) => record.extractionStatus === "unlabeled",
      ).length,
      aspectLabels: result.records.reduce(
        (count, record) => count + record.aspects.length,
        0,
      ),
      duplicates: result.duplicates,
      failures: result.failures.length,
    };
    report.aspectsQuoteValidationPass =
      result.records.length === 2 &&
      result.records.every((record) => {
        const original = originals.get(record.id);
        return (
          original &&
          record.provenance === "synthetic" &&
          record.extractionStatus === "verified" &&
          record.relevant &&
          record.productIdentity === "match" &&
          record.aspects.length > 0 &&
          record.aspects.every((aspect) => original.text.includes(aspect.quote))
        );
      });
    const has = (id: string, aspect: string, sentiment: string) =>
      result.records
        .find((record) => record.id === id)
        ?.aspects.some(
          (label) => label.aspect === aspect && label.sentiment === sentiment,
        ) ?? false;
    report.expectedAspectSentimentsPass =
      has("fixture:praise-1", "pricing", "positive") &&
      has("fixture:mixed-1", "pricing", "negative") &&
      has("fixture:mixed-1", "features", "positive");
    if (
      report.aspectsQuoteValidationPass &&
      report.expectedAspectSentimentsPass &&
      result.failures.length === 0 &&
      report.httpRequestCount > 0 &&
      statusCodes.every((status) => status >= 200 && status < 300)
    )
      report.status = "PASS";
    else report.failureCategory = classifyFailure();
  } catch (error) {
    report.failureCategory =
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
        ? "bounded_deadline_exceeded"
        : "analysis_execution_failed";
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await main();
mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    status: report.status,
    mode: report.mode,
    model: report.model,
    testedRecords: report.testedRecordCount,
    verifiedRecords: report.resultCounts.verified,
    exactQuotes: report.aspectsQuoteValidationPass,
    aspectSentiments: report.expectedAspectSentimentsPass,
    requests: report.httpRequestCount,
    httpStatus: statusCodes,
    failureCategory: report.failureCategory,
    saved: ".local/analysis-smoke.json",
  }),
);
if (report.status !== "PASS") process.exitCode = 1;
