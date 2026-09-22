# Engineering setup

The [public browser dashboard](https://cua-parse-demo.vercel.app/) works without a login, database, or provider key. Open its included synthetic sample or import a local OverHeard JSON/JSONL file. Overview, Pain points, Evidence, and typed Vox search share one selected scope. Imports stay in browser memory; they are not uploaded. Reloading clears imported data. The limit is 5 MiB and 5,000 records.

Vox on this path performs typed retrieval. It does not call an LLM or provide an ElevenLabs voice conversation. Imported sentiment and categories remain supplied labels. Missing labels must not be presented as completed model analysis.

## Develop the browser path

Use Node.js 22.22 or later and npm. Docker and provider configuration are not needed for the static dashboard.

```sh
npm ci
npm run build:showcase
node scripts/serve-showcase.mjs
```

The preview serves the public artifact under `/cua-parse/`. See [Hosting](HOSTING.md) for release commands and [OverHeard alignment](OVERHEARD_ALIGNMENT.md) for upstream credit and data compatibility.

## Optional local research service

The remaining service instructions are for the preserved CUA Parse research app at `/research`. They are not prerequisites for the public browser dashboard.

### Install and run

Use Node.js 22.22 or later, npm, and Docker. Elasticsearch needs about 2 GB of memory.

```sh
git clone https://github.com/sabdulmajid/cua-parse.git
cd cua-parse
npm ci
cp .env.example .env
docker compose up -d --wait
npm run setup
npm run build
npm start
```

Open [localhost:3000/research](http://127.0.0.1:3000/research). Select **Try demo** for synthetic AcmeFlow feedback. This path uses real SQLite and Elasticsearch and needs no provider keys. Stop Elasticsearch with `docker compose stop` to preserve its data.

For development, use `npm run dev` and open [localhost:5173/research](http://127.0.0.1:5173/research). Run one API process per local database. The app supports local use only; publishing the static sample does not expose the research API.

## Configure providers

`.env.example` lists the settings. Store credentials only in the ignored `.env` file. Never use frontend variables for credentials. Restart the API after changes. The app binds to localhost and requires a local HTTP `APP_BASE_URL`.

| Capability                       | Required configuration                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Synthetic research               | No provider keys. Use **Try demo**.                                                            |
| ElevenLabs text and voice        | `ELEVENLABS_API_KEY`, `VOICE_MODE=enabled`, and voice setup below.                             |
| Live or imported feedback labels | `OPENAI_API_KEY` and `ANALYSIS_MODE=openai`. Without these, records remain unlabelled.         |
| Uploaded YouTube corpus          | The four `ELASTIC_CLOUD_*` settings listed below. This is a separate path for typed questions. |

## Local evidence store

`ELASTICSEARCH_URL` defaults to `http://127.0.0.1:9200`. Compose pins Elasticsearch 8.19.13 with a 2 GB memory cap. Security is disabled only for this localhost-bound development service. Use HTTPS and `ELASTICSEARCH_API_KEY` for an authenticated remote cluster.

`npm run setup` creates local storage and checks the evidence index mapping. `npm run providers` checks configured providers without starting a model request or conversation. Missing credentials keep the relevant provider disabled or unverified.

Use `ELASTICSEARCH_INDEX` with the `cua-parse-` prefix. The app creates immutable research snapshots there. `CUA_LOCAL_DIR` holds SQLite, the generated session secret, and agent ownership records. Preserve this directory when restarting. Interrupted research jobs fail explicitly after a restart.

BM25 keyword search is the default. Optional hybrid search requires `RETRIEVAL_MODE=hybrid`, `OPENAI_API_KEY`, and a new dedicated index. It uses `text-embedding-3-small`. Set `OPENAI_EMBEDDING_DIMENSIONS` before creating that index. An incompatible mapping is rejected; embedding failure is reported as a keyword-search fallback.

## ElevenLabs analyst

Set `ELEVENLABS_API_KEY` and `VOICE_MODE=enabled`. Run `npm run setup:voice` to create or update a dedicated private agent and its four client tools. The key needs permission to read, create, and update the relevant Agents resources. The script does not change an account plan.

The saved agent ID is not a key. Normal setup reads it from `.local/voice-agent.json`; manual `ELEVENLABS_AGENT_ID` entry is optional. Setup rejects unrelated agents. If creation times out, resolve the uncertain operation in the provider before removing its local marker or retrying. This prevents duplicate resources.

Text uses the ElevenLabs conversation service without microphone access. Voice adds microphone input and audio output. Both use a signed WebSocket connection and session-bound local tools. When research finishes, the client sends one completion message to request the answer. **Read findings** retries the answer after a failed or replaced connection.

Set `OPENAI_API_KEY` and `ANALYSIS_MODE=openai` for live feedback labels. Schema, identity, and source-span validation run before labels count as findings. Failed records remain available for inspection. No model key is needed for the synthetic demo.

## Uploaded comments and Elastic Agent Builder

The separate settings `ELASTIC_CLOUD_URL`, `ELASTIC_CLOUD_KIBANA_URL`, `ELASTIC_CLOUD_API_KEY`, and `ELASTIC_CLOUD_INDEX` connect an existing YouTube comment corpus. The first URL is the Elasticsearch HTTPS origin. The second is the Kibana HTTPS origin used by Agent Builder. The key needs index read access and Agent Builder access.

Select a product before submitting an uploaded-corpus question. The product catalog is read from Elasticsearch without a model call. Every scoped query includes the selected `product`; the wording of the question does not change this selection. The adapter reads product labels, original comment IDs and text, publication dates, like counts, video context, and uploaded sentiment, complaint, and category fields. It does not request author data. Category keywords may be one string or an array; supported string boolean values are normalized. Other malformed label types are rejected. See `src/server/elastic-cloud.ts` for mapping and aggregation details. The default index name is `youtube-product-comments`.

The app reads counts and originals from Elasticsearch, verifies fixed-index ES|QL counts through Agent Builder, then asks the agent to select evidence. The explanation step has tools and Elastic capabilities disabled. The server renders verified source sentences and assigns citations. It does not write to the uploaded index or create remote agents.

Questions have a 150-second provider deadline and no automatic retry. Local limits permit one active request per session, two globally, and 30 per hour. Completed request IDs can replay the same answer for 30 minutes. Model context is limited to 500 complete comments and 100,000 characters; counts still cover the full scope. Ingestion must give each native comment one stable Elasticsearch document ID. The reader rejects duplicate native IDs it observes, but it does not audit uniqueness beyond the retrieved originals. Uploaded labels are metadata, not independently validated opinions.

## Export records from the OverHeard collector without provider keys

This optional command runs in the [team repository at d35ca5b](https://github.com/tyseer2335/OverHeard/tree/d35ca5b), after its Python dependencies are installed. It is not a public-dashboard requirement. It performs bounded network reads from Hacker News and Lemmy, whose adapters do not require an API key. No collection was run as part of this documentation change.

The upstream CLI calls `load_dotenv()`. Merely unsetting a shell key can let a local `.env` load it again. This POSIX wrapper starts with an empty environment apart from executable/module paths and disables dotenv loading before entering the collector. It selects only the two named sources and does not enable planning or proxies:

```sh
env -i PATH="$PATH" PYTHONPATH=src python - <<'PY'
import dotenv

dotenv.load_dotenv = lambda *args, **kwargs: False
from product_voice.collect_cli import main

raise SystemExit(main([
    "Notion",
    "--sources", "hackernews,lemmy",
    "--limit", "50",
    "--out", "data/notion.jsonl",
]))
PY
```

Run it from the upstream repository root using the Python environment where its base dependencies are installed. The command avoids keyed collectors and model calls; it does not guarantee that a public source is available or that its records may be republished. Respect source access conditions. Keep the output local.

The collector writes raw records and a separate rejects file. Import the records file into the dashboard. Do not import the rejects file as feedback. Review the output before sharing: raw records can include author names, source account IDs in URLs, and arbitrary source text. The dashboard does not convert a successful import into proof of provenance or semantic accuracy.

The upstream no-key analyzer is VADER plus keyword rules. Its fallback leaves relevance unknown. That analysis is separate from raw collection and is not requested by this command. Do not describe an unlabelled import as model-classified feedback.

## Troubleshooting

| Symptom                                   | Action                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Session loading failed                    | Use **Retry server connection**. Check that the API for this checkout is running. |
| Elasticsearch unavailable                 | Start Docker and the Compose service, then rerun setup.                           |
| Authentication or Agents permission error | Check the server-side key and provider permissions, then restart.                 |
| Agent configuration error                 | Rerun voice setup and preserve its ownership file.                                |
| No model labels                           | Check analysis mode, provider status, and the job's failed-record details.        |
| Microphone blocked                        | Enable browser microphone access or use text mode.                                |
| Wrong app receives requests               | Check the API URL and ports in the integration guide.                             |

## Primary references

- [ElevenLabs React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react) and [client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools).
- [Elastic Agent Builder API](https://www.elastic.co/docs/api/doc/kibana/group/endpoint-agent-builder).
- [HN API](https://github.com/HackerNews/API).
