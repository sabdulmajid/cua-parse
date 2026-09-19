# CUA Parse backend

This commit provides the product research API, shared schemas, source adapters, and evidence tests. The separate reference UI commit consumes this API. Existing frontends can use it directly.

Use Node.js 22.22 or later and Docker. Copy `.env.example` to the ignored `.env`, then run:

```sh
npm ci
docker compose up -d --wait
npm run setup
npm run build
npm start
```

The local API listens at `http://127.0.0.1:3000`. Start with `GET /api/session` to obtain a session and CSRF token. See [integration](docs/INTEGRATION.md) for endpoint contracts, parallel checkout settings, and selective reuse. [Setup](docs/SETUP.md) describes optional providers. Credentials and research data stay outside Git.

Run `npm run check`, `npm test`, and `npm run test:integration` before integration. The tests use synthetic data; real Elasticsearch must be available for integration checks.
