# Architecture

CUA Parse connects a research question to original feedback, a defined evidence scope, and inspectable findings. The current backend has two research paths. They share a reference UI, but they do not yet share one evidence contract.

The public guided demo is a third, static surface. It presents saved synthetic responses in the browser. It does not host the API, collect sources, or call a model.

## Research jobs

```mermaid
flowchart LR
  UI[React client] --> API[Express API]
  UI <--> Voice[ElevenLabs text or voice]
  Voice --> Tools[Browser client tools]
  Tools --> API
  API --> Jobs[Bounded job worker]
  Jobs --> Collect[HN, import, or fixture]
  Collect --> Analyze[Analysis and validation]
  Analyze --> ES[Elasticsearch snapshot]
  Jobs --> DB[SQLite job state]
  API --> Query[Scoped retrieval and counts]
  Query --> ES
  Query --> Packet[EvidencePacket and brief]
  Packet --> UI
  Packet --> Tools
```

1. A session starts a research job with a product, question, source mode, and idempotency key. That key lets an unchanged retry reuse the original operation.
2. The worker collects bounded records and persists its progress. Live collection uses fixed HN discovery and item APIs. Import validates supplied records without fetching their URLs. Fixture mode supplies declared synthetic data.
3. Analysis assigns product relevance and aspect labels. OpenAI responses must pass schema, identity, and exact source-span validation. Fixture labels have explicit synthetic provenance. Unlabelled mode does not claim model analysis.
4. Elasticsearch stores a fixed evidence snapshot for the job. SQLite holds sessions, job state, saved result views, and briefs.
5. A query applies the current filters and exclusions. Elasticsearch calculates metrics across the entire filtered scope. Retrieval selects examples from that same scope.
6. The API returns an `EvidencePacket`. The UI and conversation tools can inspect it, challenge a sentiment, or prepare a brief from the matching scope.

Jobs move through `queued → collecting → analyzing → indexing → ready`. Failure and cancellation are terminal alternatives. A ready job can contain partial collection or analysis failures; those remain visible. A restart marks interrupted jobs as failed. There is one worker and one API process per SQLite database, not a distributed queue.

## Uploaded YouTube corpus

```mermaid
flowchart LR
  UI[Typed question and selected product] --> Cloud[Cloud adapter]
  Cloud --> ES[Existing YouTube index]
  Cloud --> Counts[Fixed Agent Builder count query]
  ES --> Check[Check counts and source scope]
  Counts --> Check
  Check --> Select[Agent Builder selects source passages]
  Select --> Validate[Restore source sentences and assign citations]
  Validate --> Answer[ElasticAnswer]
  Answer --> UI
```

The product catalog is read from Elasticsearch without a model call. Each question includes an explicit product value. The Elasticsearch query and fixed ES|QL query apply that value, dates, and video exclusions. Returned originals must match the selected product and scope before they enter the explanation request.

The explanation request has tools and Elastic capabilities disabled. The server accepts only passages found in supplied originals, restores their sentence context, and assigns citation numbers. It generates count statements from query results. Uploaded sentiment, complaint, and category labels remain metadata.

`scopedRecords` is the selected product and filter denominator. `totalRecords` counts the whole upload across products. The explanation can include at most 500 complete comments within a 100,000-character context budget. All scoped records still contribute to the counts. Matching Elasticsearch and ES|QL totals do not make the source index immutable.

The adapter is read-only. It neither collects YouTube comments nor writes the uploaded index. Its `ElasticAnswer` is separate from `EvidencePacket`; the voice tools, snapshot challenge flow, and shared brief do not use it yet.

## Contracts and invariants

The definitions in [contracts.ts](../src/shared/contracts.ts) are authoritative. A schema checks the shape of data. An invariant is a rule that must remain true across operations.

| Invariant                                         | Implementation boundary                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A record keeps its source identity                | Deduplicate repeated stable IDs only when content and context agree. Keep distinct IDs even when their text matches. |
| Every displayed quote comes from an original      | Validate source spans and retain sentence context, including negation. Source text is untrusted data.                |
| Metrics and examples use one scope                | Apply filters to full-scope aggregation and retrieval. Reject missing snapshot records.                              |
| One discussion cannot disappear from counts alone | Thread/video exclusion changes both metrics and returned originals.                                                  |
| A late reply cannot replace current research      | Keep research, snapshot, scope, and request identifiers; the client discards stale responses.                        |
| A retry does not become a different operation     | Compare the idempotency key or request ID with the full input, including product. Conflicting reuse fails.           |
| A session cannot query another session's research | API ownership checks cover research tools; conversation leases bind client tools to the session.                     |

The uploaded corpus is available to the local app's sessions. Product filtering is not tenant authorization. Do not treat it as access control for a private multi-tenant index.

## Code map

| Area                               | Main files                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| API, configuration, session checks | [app.ts](../src/server/app.ts), [config.ts](../src/server/config.ts)                                                 |
| Jobs and local state               | [jobs.ts](../src/server/jobs.ts), [storage.ts](../src/server/storage.ts)                                             |
| Collection and analysis            | [collection.ts](../src/server/collection.ts), [analysis.ts](../src/server/analysis.ts)                               |
| Scope, findings, and brief         | [elastic.ts](../src/server/elastic.ts), [findings.ts](../src/server/findings.ts), [brief.ts](../src/server/brief.ts) |
| Uploaded corpus                    | [elastic-cloud.ts](../src/server/elastic-cloud.ts), [ElasticResearch.tsx](../src/client/ElasticResearch.tsx)         |
| Conversation tools                 | [voice.ts](../src/client/voice.ts), [server voice.ts](../src/server/voice.ts)                                        |
| Reference UI                       | [App.tsx](../src/client/App.tsx)                                                                                     |
| Repeatable source sample           | [AcmeFlow fixture](../fixtures/acmeflow.ts), [independent expected facts](../fixtures/acmeflow.expected.json)        |

Provider keys remain on the server. The browser receives a short-lived signed conversation connection, not the provider API key. The API uses HTTP-only session cookies, same-origin checks, and CSRF tokens. It binds to a local origin. Public hosting of the static demo does not change this backend boundary.

## Integration work that remains

X and Reddit collectors, a canonical multi-platform ingestion contract, source-deletion synchronization, and a shared voice/YouTube evidence service are proposed work. A source index can change after a query; the Cloud path has no point-in-time snapshot. Quote validation is a source check, not a guarantee of semantic truth.

See [Agent handoff](AGENT_HANDOFF.md) for data identity, product attribution, lifecycle, ownership, and migration proposals. See [Verification](VERIFICATION.md) for the difference between deterministic tests, live checks, and unverified behavior.
