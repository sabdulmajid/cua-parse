# Project instructions

Use TypeScript and keep shared API schemas in `src/shared/contracts.ts`. Coordinate schema, dependency, and root configuration changes across concurrent branches. See `docs/INTEGRATION.md` before moving this code into another app.

Keep secrets, provider receipts, source datasets, and local session files out of Git. Do not log credentials, signed connection URLs, or raw provider errors. Synthetic records must have explicit provenance and null source URLs.

Use full scoped Elasticsearch counts for metrics. Keep source context and negation in quotes. Check session ownership on every evidence tool. Preserve cancellation and stale-result guards.

Before a PR, run `npm run check`, `npm test`, `npm run test:integration`, `npm run build`, `npm run test:browser`, `npm run secret-scan -- --history`, and `npm run format:check`. Browser tests require a running app; integration tests require Elasticsearch. Do not run paid smoke checks unless the task authorizes provider use. State which checks use mocks or synthetic data.
