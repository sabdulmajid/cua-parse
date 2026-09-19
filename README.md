# CUA Parse

CUA Parse connects product research questions to original feedback and scoped evidence counts. Type or speak to an ElevenLabs analyst, inspect its sources, and exclude a large discussion to see how the findings change.

For an existing YouTube feedback index, choose **YouTube comments · Elastic**, select a product, and ask a question such as “What do people dislike about Microsoft Teams?” Elasticsearch calculates the counts. Elastic Agent Builder selects supporting source passages. The app verifies each passage against the original comment and assigns its citation.

## Run locally

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

Open [localhost:3000](http://127.0.0.1:3000). Select **Try demo** for synthetic AcmeFlow feedback. This path uses real SQLite and Elasticsearch but needs no provider keys. Stop Elasticsearch with `docker compose stop` to preserve its data.

For development, use `npm run dev` and open [localhost:5173](http://127.0.0.1:5173). Run one API process per local database. The app supports local use only.

## Enable providers

Store keys only in the ignored `.env` file. Restart the API after changes.

- **ElevenLabs text and voice:** set `ELEVENLABS_API_KEY` and `VOICE_MODE=enabled`, then run `npm run setup:voice`. Setup creates a dedicated private agent and saves its ID locally. The agent ID is an identifier, not a second key.
- **Live feedback analysis:** set `OPENAI_API_KEY` and `ANALYSIS_MODE=openai`. Without this, live and imported records remain unlabelled. Fixture labels are always synthetic.
- **Uploaded Elastic corpus:** copy the four `ELASTIC_CLOUD_*` settings from `.env.example` into your ignored `.env` and enter their values there. This is a separate, read-only source. It uses direct typed questions. The live discussion source supports ElevenLabs text and voice.

See [setup](docs/SETUP.md) for configuration, [integration](docs/INTEGRATION.md) for reuse in another frontend, and [verification](docs/VERIFICATION.md) for tests. For coordination across separate frontend, backend, and collection teams, use the [shared agent handoff](docs/AGENT_HANDOFF.md).

## Evidence rules

Counts cover the full filtered scope, not only displayed examples. Collected records, relevant records, and aspect mentions have different denominators. One record can mention several aspects. Excluding a thread updates both counts and sources. Challenge mode searches for actual opposing sentiment; no opposing example does not prove agreement.

Live collection is a bounded public HN sample. It does not establish market prevalence or verified customer opinion. Imported sentiment labels can be wrong. Exact quote validation proves that the text exists, not that a model interpretation is correct. Read the full linked source before making a decision.

The repository contains synthetic fixtures. Runtime research, provider receipts, browser recordings, and credentials stay outside Git. [Fixture and source notes](fixtures/README.md) describe collection limits.
