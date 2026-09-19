# Integrate without replacing another frontend

The backend can serve an existing UI. The React workspace is a reference client. Keep the API contracts and session rules when building another frontend.

## Change boundaries

The initial feature history has two implementation commits: **Add research backend and shared API** and **Add minimal research workspace and browser coverage**. The second depends on the first. A merge commit preserves both for selective integration.

| Area           | Paths                                                        | Coordination rule                                       |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Shared API     | `src/shared/contracts.ts`                                    | Agree on schema changes before parallel implementation. |
| Backend        | `src/server/`, `fixtures/`, server tests                     | Reuse independently of the React UI.                    |
| Reference UI   | `src/client/`, `index.html`, `vite.config.ts`, browser tests | Optional when an existing frontend already exists.      |
| Shared tooling | `package.json`, lockfile, root configs, CI                   | Have one branch resolve dependency and script changes.  |

For an empty destination, cherry-pick the backend commit first, then the UI commit if needed. For an existing application, review the backend commit and port its server, contracts, fixtures, and relevant tests. Reconcile dependencies and scripts with that application's package files. Do not replace its package files or frontend as a bulk copy. Add the reference UI only after that boundary works.

## Client contract

Use a same-origin `/api` proxy. `GET /api/session` establishes an HTTP-only cookie and returns `csrfToken`. Keep the cookie and send `X-CSRF-Token` on every POST. Do not send provider keys from the browser.

| Endpoint                                 | Purpose                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/session`                       | Session token, provider availability, owned jobs.                            |
| `GET /api/health`                        | Local Elasticsearch readiness. Inspect `ok`; HTTP 200 alone is insufficient. |
| `POST /api/tools/start_research`         | Start a bounded live, fixture, or import job.                                |
| `POST /api/tools/get_research_status`    | Poll an owned research job.                                                  |
| `POST /api/tools/query_feedback`         | Retrieve evidence and full-scope metrics.                                    |
| `POST /api/tools/prepare_decision_brief` | Export a brief from the same scope.                                          |
| `POST /api/research/:id/cancel`          | Cancel an owned job.                                                         |
| `POST /api/voice/session`                | Create a private text or voice connection lease.                             |
| `POST /api/voice/bind`                   | Bind that lease to the conversation.                                         |
| `POST /api/elastic/query`                | Ask Elastic Agent Builder about the configured uploaded corpus.              |

Import the schemas and types rather than copying request shapes. Research IDs alone do not grant access. Conversation requests also carry `X-Conversation-Id` after binding. Keep request IDs stable for retries of the same operation. Generate a new ID after changing the question or scope. Discard stale replies after a new job, conversation, or scope selection.

The ElevenLabs SDK receives a short-lived signed URL. Its client tools call the local backend. Send one completion message when the active research job becomes ready so the agent can retrieve and answer. See `src/client/voice.ts` and its tests for this transition.

## Parallel local sessions

Use separate checkouts, local data directories, and index names. For example, set these values in one checkout's ignored `.env`:

```dotenv
PORT=3100
APP_BASE_URL=http://127.0.0.1:3100
VITE_PORT=5174
CUA_LOCAL_DIR=.local
ELASTICSEARCH_INDEX=cua-parse-engineer-b-v1
```

A checkout's relative `.local` directory is independent. Never point two API processes at the same SQLite database. Local Elasticsearch can be shared if each checkout has a distinct index. Only one shared Docker service needs to bind port 9200.

For checks in that checkout:

```sh
API_TEST_PORT=3199 ELASTIC_API_TEST_PORT=3198 VOICE_API_TEST_PORT=3197 npm test
API_TEST_PORT=3199 ELASTIC_API_TEST_PORT=3198 npm run test:integration
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 npm run test:browser
```

Browser tests use the app you specify; start that checkout's built app first. Test indices use unique IDs. Provider keys and agent ownership files are local configuration; never copy them through a commit.
