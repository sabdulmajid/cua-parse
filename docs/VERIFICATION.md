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

The browser suite checks the synthetic research flow through real local storage and search. Mocked Elastic cases cover answers, citation inspection, exclusions, stale responses, cancellation, retry, session startup recovery, source persistence, and mobile layout. Local runs use Chrome; CI installs Playwright Chromium. Set `PLAYWRIGHT_BASE_URL` to test a separate app instance.

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
