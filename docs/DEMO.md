# A working evidence workspace

The [public workspace](https://cua-parse-demo.vercel.app/) runs the actual React dashboard in the browser. Imports, filters, thread exclusions, evidence search, and brief export execute locally. The walkthrough records the sample workflow and import dialog. It does not replay prepared API responses or start a provider session.

The bundled dataset contains **22 hand-authored synthetic records**: 13 for AcmeFlow and 9 for OrbitQuest. The source labels describe invented examples, not records collected from those platforms. Each sample record has explicit synthetic provenance and no source URL. No private corpus, customer statements, account data, or paid model output is published.

## Published media

- `showcase/assets/walkthrough.mp4`: a direct browser recording, encoded as H.264 with fast start.
- `showcase/assets/poster.webp`: a screenshot of the actual workspace.
- `showcase/assets/preview.gif`: a resized excerpt from the same recording.
- `showcase/assets/captions.vtt`: captions timed during the recorded actions.

The published H.264 recording is 56.56 seconds at 1440 × 1000 pixels. Decoded frames were checked against the visible flow. The recording opens the overview, inspects pricing records, opens original text, excludes the largest thread, searches positive evidence with Vox, exports a brief, shows the import dialog, and switches products. The sample begins with 13 AcmeFlow records. Excluding its largest thread leaves nine. Vox is deterministic evidence search in this surface; no microphone or model is used.

## Reproduce the recording

Use the supported Node version, installed dependencies, Chrome (or Playwright Chromium with `CI=1`), FFmpeg, and FFprobe. These engineering steps belong here, not in the product introduction.

```sh
npm run build:showcase
npx playwright install ffmpeg
npx tsx scripts/capture-workspace.ts
npm run build:showcase
npm run test:showcase
```

The script starts its own static preview on port 3311. It checks the visible workflow before it creates the media. Network requests outside that preview origin are blocked. It needs no Elasticsearch, environment file, or provider credentials. Set `FFMPEG_PATH` if FFmpeg is not on `PATH`. Raw recordings, screenshots, and the test brief remain in ignored `.local/workspace-recording/`.

The complete public build must remain within 5 MiB, including the recording. It contains no API process or provider SDK. Imported user files are never part of the published build. See [hosting](HOSTING.md) for release and free-plan boundaries.

## Archived connected-backend fixture

`showcase/data/demo.json` preserves the previous synthetic API export for independent backend regression tests. The new workspace does not load it. It contains four saved scopes: overview, pricing, excluded, and challenge. Its 21 deduplicated records are a different fixture from the 22-record workspace sample.

`scripts/export-demo.ts` can reproduce that export through the local research API and Elasticsearch. `scripts/capture-demo.ts` is the legacy backend recording tool. It now opens `/research`; it is not the public workspace capture command. Its output is kept under ignored `.local/legacy-demo-assets/` so it cannot replace the published workspace media. The older pricing fixture has 13 scoped records before exclusion and five after exclusion. See [product case study](PRODUCT.md) for the distinction.

Provider checks and recorded UI checks establish different facts. This recording proves that the displayed synthetic workflow ran. It does not prove provider availability, live collection, or a physical voice conversation.
