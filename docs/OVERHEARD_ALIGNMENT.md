# Alignment with the OverHeard team project

CUA Parse brings the OverHeard team's feedback workflow to a browser dashboard: review a product, find repeated issues, inspect the original comments, and search the same evidence with typed Vox. The public path needs no account, research service, or provider key.

The design reference is the [OverHeard team repository](https://github.com/tyseer2335/OverHeard) at [revision d35ca5b](https://github.com/tyseer2335/OverHeard/tree/d35ca5b). Credit for that project's product direction and dashboard belongs to its contributors. This revision implements its own browser workflow and accepts the team's export formats. It does not imply a connection to the team's running backend.

## Browser capabilities

| Area           | Public browser dashboard                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feedback input | Included synthetic sample, plus local JSON/JSONL files in the normalized OverHeard record shape or its raw collector shape.                                              |
| Shared scope   | Overview, Pain points, Evidence, and typed Vox search use the selected dataset and filters.                                                                              |
| Analysis       | Counts and category summaries are calculated from selected records. Imported labels remain supplied metadata.                                                            |
| Evidence       | Inspect complete accepted text and available public source links. Synthetic records are identified and have no public source URL.                                        |
| Vox            | Typed retrieval over current feedback. No hosted model or voice service is called.                                                                                       |
| Data handling  | Imports stay in browser memory. Selecting a file does not upload its contents. Reloading clears the imported dataset. Explicit downloads save a copy chosen by the user. |
| Bounds         | Import limit: 5 MiB and 5,000 records, with 20,000 characters per comment. Public artifact budget: 5 MiB.                                                                |

No public-path feature requires Supabase sign-in, Elasticsearch, OpenAI, ElevenLabs, or a paid collection service. The preserved CUA Parse research app is available at `/research` in local service mode. Its service integrations are separate from the public dashboard.

## Portable import contract

A normalized OverHeard record uses `source`, `external_id`, `content`, `url`, `published_at`, `engagement`, `sentiment`, `is_complaint`, `issue_categories`, and `source_metadata`. Its product name comes from `source_metadata.product_name`, `product`, or `product_id`. Raw collector records use `id`, `source`, `product`, `text`, `url`, `created_at`, `score`, and thread context. Use JSON arrays or JSONL with one record per line.

The importer requires a source, native ID, product, and non-empty original text. Labels and publication dates can be absent. It reports rejected rows, duplicate identities, and removed unsafe links. Records with the same text and different native IDs remain distinct. Identity includes organization, product, source, and native ID; a repeated identity keeps its first accepted record. Raw source-prefixed IDs are normalized before comparison. Inspect the import report before using its counts.

The browser preserves accepted text. It does not import raw author fields or fetch source URLs. A link that fails validation is removed while its comment remains available. Dates must use an unambiguous supported format; records with missing dates do not enter a date-bounded scope.

An import proves format compatibility. It does not verify collection history, label accuracy, or a connection to the team's live index. The included sample is explicitly synthetic. A team export can replace it in browser memory without becoming a public asset.

## Analysis choices

Missing sentiment and relevance remain unknown. Category counts show supplied labels; they do not establish severity or product relevance. A source recommendation or a keyword match is useful context, but it is not a verified opinion about every aspect of a product.

Counts describe the loaded sample, not customers or market prevalence. Engagement measures from different platforms are not interchangeable. This revision does not present upstream throughput or accuracy claims as independently measured results.

The reference has no-key components, including a rule-based planner, VADER sentiment scoring, and keyword categories. Those are separate from this dashboard's calculations and from model analysis. Typed Vox here searches loaded evidence; it does not run the reference voice integration.

## Team credit and integration boundary

This revision credits the OverHeard team and uses new implementation and recording assets. It does not assign a license to upstream files or copy a private team corpus. Source links and imported provenance stay visible; sharing an export remains a separate choice from inspecting it locally.

The Python backend, Supabase tenancy, Elasticsearch corpus, live collection, model classification, and ElevenLabs service are not integrated into the static path. No live team service was tested for this alignment. The reference includes five source adapters, but this dashboard imports records; it does not run those collectors or add direct X/Reddit collection.

See [Setup](SETUP.md) for the browser path and a bounded collector export procedure. See [Hosting](HOSTING.md) for the free static-hosting boundary and its limits.
