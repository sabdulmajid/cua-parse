# Public demo provenance and reproduction

The public showcase uses **AcmeFlow**, an invented product with hand-authored synthetic feedback. It contains no private corpus, real customer statements, provider credentials, or paid model output.

The guided tour replays saved results. It does not start a hosted research job. The video records the original built application running with its real local API, SQLite, and Elasticsearch. It shows research, source inspection, pricing scope, exclusion of the concentrated complaint thread, opposing evidence, and the brief download. Voice and model providers are off in this recording.

## Published artifacts

- `showcase/data/demo.json`: four results exported through the real API: `overview`, `pricing`, `excluded`, and `challenge`.
- `showcase/assets/walkthrough.mp4`: actual browser recording, encoded as H.264 with fast start.
- `showcase/assets/poster.webp`: a direct screenshot of the actual app's overview findings card.
- `showcase/assets/preview.gif`: a cropped excerpt of the same recording. The crop frames the findings and source column, removes the unrelated setup banner, and keeps the actual counts, citations, and actions unchanged.
- `showcase/assets/captions.vtt`: timed text that describes each recorded action.

The exported data preserves the API's metrics, original fixture IDs, quotations, findings text, filters, and limitations. It removes session IDs, research IDs, request IDs, and runtime generation timestamps. Runtime scope and finding IDs are replaced with deterministic presentation IDs derived from the fixture version and filters. These IDs support the static tour; they are not accepted research-job credentials. The brief retains its real content and citations, with the generation timestamp removed and its scope identifier changed to the corresponding presentation ID.

Original fixture publication and collection timestamps remain as fixture data. Source links are null and are described as synthetic. `provenance.transformations` records the export changes. The actual API response is never replaced by a mock during capture.

The published recording is 59.88 seconds at 1440 × 900 pixels. FFprobe identified H.264 video. The data-only export and the recorded-flow export were compared byte for byte after formatting and matched. The pricing table, concentrated thread, and opposing quotations were checked in decoded video frames.

## Measured fixture results

| Step                        | Records in scope | Relevant records | Pricing negative | Pricing positive |
| --------------------------- | ---------------: | ---------------: | ---------------: | ---------------: |
| Overview                    |               21 |               18 |                9 |                3 |
| Pricing                     |               13 |               13 |                9 |                3 |
| Pricing after exclusion     |                5 |                5 |                1 |                3 |
| Challenge in the same scope |                5 |                5 |                1 |                3 |

The challenge returns three actual positive pricing fixture records. The initial input has 22 rows; one repeated stable ID is removed. The remaining 21 distinct records include three records that do not establish relevant product feedback. These are sample counts, not market measurements.

## Reproduce locally

Use the project's supported Node version and install dependencies. Start the pinned local Elasticsearch service described in [SETUP.md](SETUP.md). The scripts require a clean local port `3300`; they do not attach to or alter another running app.

```sh
npm ci
npm run build
npx tsx scripts/export-demo.ts
```

The data-only command creates a fresh fixture job through the actual API. It does not launch a browser or encode video. It uses `.local/showcase/server` for local state and a newly generated `cua-parse-showcase-*` Elasticsearch index. It deletes only that run's index when it finishes. Local server state and source video are ignored by Git.

To record the full walkthrough, install Playwright's small video helper and make FFmpeg and FFprobe available:

```sh
npx playwright install ffmpeg
npx tsx scripts/capture-demo.ts
```

On macOS the script uses the installed Chrome browser and finds `ffmpeg` and `ffprobe` on `PATH`. Other installations can set `FFMPEG_PATH` and `FFPROBE_PATH`. With `CI=1`, it uses Playwright's Chromium; install it with `npx playwright install chromium` first. A `--fast` rehearsal exercises the same clicks with shorter pauses and overwrites the media; run the normal command again before publishing.

The script supplies its own configuration: local Elasticsearch, fixture-only intake, BM25 retrieval, no live analysis, and disabled voice. It ignores provider settings from the shell when it creates the API service. Browser requests outside the local origin, provider-session requests, Cloud requests, and non-fixture research are blocked. The script checks original quotations, the expected pricing counts, opposing record IDs, and the actual downloaded brief. No synthetic result is presented as a live provider check.
