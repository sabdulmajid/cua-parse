# Contributing

Help make product findings easier to inspect and harder to misread. Start with a concrete failure: a wrong denominator, a missing source, a stale reply, an inaccessible control, or an integration that does not preserve evidence.

Read [AGENTS.md](AGENTS.md) and [Architecture](docs/ARCHITECTURE.md) before changing behavior. Use [Engineering setup](docs/SETUP.md) to run the app and [Integration](docs/INTEGRATION.md) when connecting another frontend.

## Keep changes bounded

- Agree on changes to `src/shared/contracts.ts`, dependencies, configuration, and CI before parallel work. One owner should resolve shared files.
- Keep collection, analysis, evidence retrieval, and UI changes separate when they can be reviewed independently.
- Preserve source identity, exact text, provenance, and session ownership. Do not collapse different records because they use the same words.
- Use full-scope counts. Keep filters, source examples, opposing evidence, and exports on the same scope.
- Use a new request ID when the product, question, or scope changes. Keep the same input and ID for an unchanged retry.

For larger integrations, use the [shared handoff](docs/AGENT_HANDOFF.md). It marks current support and proposed work separately.

## Verify the behavior

Add a regression test for a defect that affects evidence, identity, scope, or request state. Use synthetic fixtures and mocked provider responses for repeatable tests. Keep expected facts independent of the implementation under test.

Before a PR, run the checks required by [AGENTS.md](AGENTS.md): type and lint checks, unit tests, real local Elasticsearch integration tests, production build, browser tests, history secret scan, and formatting. [Verification](docs/VERIFICATION.md) gives the commands and prerequisites. Test the main user flow when an interface changes.

Paid provider checks are separate acceptance work. Run them only when authorized. A mocked response, synthetic fixture, or successful connection is not proof of a completed live conversation. State which checks you ran, what they exercised, and what remains unverified.

## Protect source data

Do not commit credentials, signed URLs, raw provider errors, runtime databases, private datasets, or session artifacts. Review both the staged paths and the diff. The secret scanner helps find known patterns; it cannot prove that every possible secret is absent.

Keep synthetic records visibly labelled and give them null source URLs. Public demo assets must contain reviewed synthetic material. Recordings must not expose provider dashboards, private source data, account details, or local session identifiers. Normal runtime receipts and research stay in ignored local storage.

## Open a reviewable PR

Describe the user-visible problem, the changed behavior, and relevant test results. Include a small before/after example when it clarifies an evidence or scope bug. List material limitations and migration needs. Do not claim support for an adapter, provider flow, or deployment that has not been implemented and checked.

Keep commits focused and use the actual Git history. Do not add invented project dates, private conversation links, or AI coauthor tags. Document shared decisions where the next engineer can find them.
