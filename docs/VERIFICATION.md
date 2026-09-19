# Verification

The default checks use synthetic records, local Elasticsearch, and mocked cloud providers. They do not establish live provider availability or physical microphone quality.

```sh
npm run check
npm test
npm run test:integration
npm run build
npm run secret-scan -- --history
npm run format:check
```

Integration tests need Elasticsearch. They create uniquely named test indices and remove those indices. HTTP test ports are configurable; see the integration guide.

Start the built app in another terminal, then run:

```sh
npm run test:browser
```

The browser suite checks the synthetic research flow through real local storage and search. Mocked Elastic cases cover product catalog recovery, product isolation, answers, citation inspection, exclusions, stale responses, cancellation, retry, session startup recovery, source persistence, and mobile layout. Research browser cases also cover a delayed new start, failed-start recovery, and invalid-date recovery. Session tests exercise cookies across local app ports. Local runs use Chrome; CI installs Playwright Chromium. Set `PLAYWRIGHT_BASE_URL` to test a separate app instance.

CI runs these checks with provider credentials absent. It uses the same pinned local Elasticsearch version as Compose. It does not upload runtime artifacts or provider data.

## Optional live checks

Run these only when provider use is intended. They are excluded from CI.

| Command                           | External work                                                     |
| --------------------------------- | ----------------------------------------------------------------- |
| `npm run smoke:live-source`       | Bounded HN collection and local Elasticsearch; no model analysis. |
| `npm run smoke:analysis`          | Potentially billable OpenAI analysis of synthetic records.        |
| `npm run smoke:live-analysis`     | HN collection plus model analysis.                                |
| `npm run smoke:conversation`      | ElevenLabs text conversation over the synthetic demo.             |
| `npm run smoke:voice`             | ElevenLabs audio with synthetic microphone input.                 |
| `npm run smoke:live-conversation` | Bounded live HN research and a complete provider conversation.    |

Reports remain under ignored `.local/`. Keep live research and receipts out of public commits. A successful mock, fixture, setup request, or signed connection does not prove a completed real conversation. Physical microphone and speaker checks require a separate manual run.

The secret scanner checks files and Git history for known patterns. `--secrets-file` can compare against a local environment file without printing values. No pattern scanner guarantees the absence of every possible secret; review the staged file list and diff before publishing.

## Integration-readiness review: 19 September 2026

The follow-up passed TypeScript/ESLint, 288 unit tests, 21 real local Elasticsearch integration tests, and the production build. All 18 browser cases passed across a full run and one focused rerun after a test selector correction. The browser checks used an isolated fixture API and mocked Cloud responses. Formatting and the working-tree/full-history secret scan also passed; the scan compared against local configured values without printing them.

Independent code review covered backend product isolation, frontend stale-response handling, and the shared handoff. These checks establish this reference implementation's behavior. They do not certify another frontend, X/Reddit collector, a changing live dataset, or physical microphone quality. Read the PR checks for the final pushed revision.
