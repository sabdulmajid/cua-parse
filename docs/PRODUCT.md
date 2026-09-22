# From feedback to an inspectable decision

Product feedback arrives in different formats and from different audiences. A summary becomes useful when a team can inspect its originals, see which records it measures, and test whether one discussion dominates the result.

The [public workspace](https://cua-parse-demo.vercel.app/) follows the [OverHeard team project's](https://github.com/tyseer2335/OverHeard) product direction. It provides Overview, Pain points, Evidence, and typed Vox search in one browser workspace. Open the synthetic sample or import a local team export. No account, server connection, or provider key is needed for this path.

## A usable evidence workflow

1. **Choose a product.** Review record counts, source coverage, supplied complaint labels, and unknown sentiment.
2. **Inspect an issue.** Issue rank measures the frequency of supplied labels. Read original records before treating a label as a product problem.
3. **Change the scope.** Filter by source, sentiment, dates, or text. Exclude a discussion to see whether it drives the result. These controls affect counts, evidence, Vox, and export together.
4. **Search with Vox.** Ask for an overview, an issue, positive evidence, or specific words. Vox returns deterministic matches and original records. It does not generate new labels or call a model.
5. **Export the brief.** Save current counts, supplied issue labels, selected originals, source links, and limits. The export recalculates the current scope before it chooses evidence.

A **scope** is the set of included records. Changing the issue detail view inspects that label; changing a scope filter changes the records measured across the workspace. Missing dates and labels remain explicit. The user can reset filters or restore an excluded discussion without collecting data again.

## Current public sample

The browser sample contains **22 authored records**: 13 for AcmeFlow, an invented collaboration product, and nine for OrbitQuest, an invented game. Source names illustrate different feedback formats. The records were not collected from those platforms, and their source URLs are null.

For AcmeFlow, the largest discussion contains four records. Excluding it changes the sample as follows:

| Measure                     | AcmeFlow, all records | After largest-thread exclusion |
| --------------------------- | --------------------: | -----------------------------: |
| Records in scope            |                    13 |                              9 |
| Sources represented         |                     3 |                              3 |
| Threads in scope            |                     6 |                              5 |
| Supplied complaint labels   |                     8 |                              5 |
| Supplied negative sentiment |                     7 |                              5 |
| Supplied positive sentiment |                     3 |                              2 |
| Unknown sentiment           |                     1 |                              1 |

These values were calculated from [the browser sample](../src/workspace/sample.ts) with [the scope model](../src/workspace/model.ts). The discussion contains more than one sentiment. Its removal changes both negative and positive counts. Neither view establishes how most customers feel.

A record can carry several issue labels. Complaint and sentiment labels also describe different things: a mixed comment may contain a complaint and praise. The app preserves supplied labels instead of turning every issue mention into a negative judgment.

## Import a team export

The browser accepts normalized OverHeard feedback and raw collector records in JSON or JSONL. Imports are bounded to 5 MiB and 5,000 rows. Accepted text stays intact. The import report identifies rejected rows, duplicate identities, and removed unsafe links.

Files stay in memory in the current tab. They are not uploaded, saved to browser storage, or sent to a provider. Reloading returns to the synthetic sample. Use **Export brief** to keep the current result. Import compatibility does not verify collection history or labels, and it does not connect a live team service.

## Preserved connected research

The local `/research` app remains available for separately configured services. Research jobs support bounded public Hacker News collection, authorized imports, synthetic fixtures, OpenAI aspect analysis, and ElevenLabs text or voice. The job snapshot supports scope changes, opposing evidence, and a brief.

Uploaded YouTube research is a separate local path. It reads an existing Elasticsearch corpus and uses Elastic Agent Builder with explicit product filters. Its labels remain uploaded metadata. It does not collect YouTube comments or share the job path's voice tools and brief.

These service paths are not deployed with the public workspace. See [Architecture](ARCHITECTURE.md) and [Setup](SETUP.md) for their contracts and configuration.

## Archived backend regression example

The repository retains an older AcmeFlow fixture and its saved API responses to test the connected research backend. It is separate from the current 22-record browser sample. The retired guided page displayed these saved responses; the current workspace calculates its own results from loaded records.

The older scenario filters for pricing and then excludes an eight-comment discussion:

| Measure                   | Backend pricing scope | After discussion exclusion |
| ------------------------- | --------------------: | -------------------------: |
| Relevant records          |                    13 |                          5 |
| Discussions in scope      |                     4 |                          3 |
| Negative pricing mentions |                     9 |                          1 |
| Positive pricing mentions |                     3 |                          3 |
| Neutral pricing mentions  |                     1 |                          1 |

A mention here is one aspect label, not a whole-comment sentiment. The [independent fixture expectations](../fixtures/acmeflow.expected.json) and [archived API export](../showcase/data/demo.json) define this regression case. These numbers must not be used as current public-workspace counts.

## What the evidence can establish

Exact text checks establish that a quotation occurs in the supplied original. They do not establish that the claim is true. Counts describe a selected dataset, not verified customers or market prevalence. Source engagement is not comparable across platforms. Missing positive evidence does not prove a negative conclusion.

Deterministic tests, service integration checks, and live provider checks establish different facts. See [Verification](VERIFICATION.md) for executed checks and their limits. See [OverHeard alignment](OVERHEARD_ALIGNMENT.md) for team credit and the import boundary.
