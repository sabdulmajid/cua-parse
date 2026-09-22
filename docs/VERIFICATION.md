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

## Archived public demo release: 19 September 2026

The original public showcase added an independently checked synthetic export and a recorded application flow. The complete local validation passed 304 unit tests, 21 real Elasticsearch integration tests, 18 application browser tests, and 6 public-demo browser tests. TypeScript, ESLint, both builds, formatting, and secret scans passed. The public browser suite checks source inspection, restored scope, opposing evidence, exact brief download, failed-load recovery, non-synthetic data rejection, keyboard/mobile controls, captions, and real video playback.

The 59.88-second recording runs the built application against SQLite and Elasticsearch with provider credentials absent. Its four exported states match a fresh data-only API export byte for byte. Public-data tests compare counts and original quotations with the independent fixture. These checks do not claim a hosted live backend or a provider conversation.

The public artifact is released manually to the dedicated Vercel `cua-parse-demo` project after the reviewed `main` revision passes verification. The deployment contains only `.site/`, not the research API or its runtime configuration. The builder rejects linked/hidden files, unsupported file types, non-fixture originals, and private runtime fields. Rebuild and relink the output directory before each release; the build removes the previous `.site/` directory.

The canonical public URL is `https://cua-parse-demo.vercel.app/`. After each deployment, check the published artifact with:

```sh
SHOWCASE_BASE_URL=https://cua-parse-demo.vercel.app/ npm run test:showcase
```

The initial public Vercel release also passed all six browser cases anonymously over HTTPS. Environment and Vercel metadata paths returned HTTP 404. A successful local run alone does not prove that a hosted release is accessible. Record the actual reviewed revision, deployment URL, and hosted test result before reporting publication complete. No live provider conversation is part of this static-site check.

The optional `Publish optional Pages demo` GitHub Pages workflow is disabled unless `ENABLE_GITHUB_PAGES` is exactly `true`. When enabled, it accepts only the selected current `main` revision after a successful `Verify` push or an explicit main-branch recovery dispatch. It does not publish to Vercel. See [HOSTING.md](HOSTING.md) for release and rollback commands, and [DEMO.md](DEMO.md) for reproduction steps.

## Browser workspace revision: 22 September 2026

The public entry is now the Overheard browser workspace. The prior application browser tests target `/research`, which retains the connected backend. The workspace has its own tests under `tests/showcase/` and model tests under `tests/workspace-model.test.ts`.

Local verification passed 322 unit tests, 21 real Elasticsearch integration tests, 18 connected-research browser cases, and eight workspace browser cases. TypeScript, ESLint, both builds, formatting, and working-tree/full-history secret scans passed. Desktop and mobile visual checks found no horizontal overflow. The final public artifact is 2.05 MiB including a 56.56-second recorded walkthrough.

The focused model suite checks both OverHeard export formats, import limits, duplicate reporting, product and organization isolation, strict dates, unknown labels, original quotations, source balance, credential URL removal, scoped search, and export consistency. Browser checks exercise import recovery, filters, source inspection, exclusions, product switching, Vox, pagination, mobile focus, actual downloads, and video playback. Tests use synthetic inputs; no paid provider calls are part of this release.

Build and verify the public entry with:

```sh
npm run build:showcase
npm run test:showcase
```

The compiled artifact rejects backend and provider modules and must fit within 5 MiB. The public Content Security Policy blocks service connections. A deployed check must confirm this header and repeat the browser suite over HTTPS before publication is reported complete. Record final counts and reviewed revision in the release handoff.
