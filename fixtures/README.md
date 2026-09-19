# Synthetic research fixture

`acmeflow.ts` defines 22 invented records. One repeats the same source ID and payload as an exact duplicate. Every URL is null. The declared labels support a repeatable product demonstration without model credentials. Fixture labels apply only when the product is AcmeFlow and the record text, source, provenance, ID, thread ID, and title match.

`acmeflow.expected.json` is an independent test oracle. Application code does not import its totals. It defines the exact counts before and after exclusion of the eight-record complaint thread. The fixture includes pricing praise, mixed aspect sentiment, unrelated and ambiguous products, a missing publication date, and an instruction injection. The injection is source text and has no counted aspects.

Generate records with `fixtureRecords()`; each call returns new objects. Use `npm run seed` to create a research snapshot through the normal collection, analysis, and Elasticsearch path.

## Source access and limits

Live collection uses the [documented public HN API](https://github.com/HackerNews/API) for item text. [YC announced the read-only API](https://www.ycombinator.com/blog/hacker-news-api/) as a supported alternative to HTML scraping. Discovery uses the public [Algolia HN search API](https://hn.algolia.com/api), with implementation details in [Algolia's source repository](https://github.com/algolia/hn-search). Documentation checked on 2026-09-19.

Requests use fixed API origins. Imported and discovered external story URLs are never fetched. Each job uses at most three discovery queries, ten threads, 150 records, two concurrent item requests, 190 primary item requests, and one retry per request. Each HTTP call times out after eight seconds. Live collection has a 90-second deadline. Retry-After is respected; a delay above five seconds stops that request instead of retrying early. Discovery selects the first result page and item traversal follows the API reply order. This is a bounded discussion sample, not a representative customer survey. A newer research job can collect different source text.

The [YC terms](https://www.ycombinator.com/legal/) restrict commercial reuse unless authorized. Availability of the API is not a commercial redistribution license. This adapter is for the local research demonstration. Do not publish the collected corpus or use it commercially without the required authorization. The API documents deletion flags; the collector excludes deleted/dead items on every fresh collection. Local snapshots do not poll for later deletions. Retain no public corpus, delete local research snapshots when no longer needed, and honor source removal requests. Production retention and deletion synchronization require a separate policy and implementation.

## Analysis

Live model analysis uses the official OpenAI SDK `responses.create()` with `zodTextFormat()`, as documented in [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). It sends up to four records per request, disables response storage and SDK retries, permits one selective repair pass for locally invalid labels, and respects cancellation. The application validates record IDs, relevance/identity consistency, exact supporting quote spans, exact product-name identity spans, and one label per aspect. Schema and quote validation do not prove that a model interpretation is correct. Identity requires the requested product name or the explicit vendor-qualified Microsoft Team/Microsoft Teams spelling alias. Bare Teams is not a full identity span.

Validated labels are cached for 30 minutes in a bounded process cache, keyed by session, product, model, analysis version, source text and thread context. Cached labels are copied into each immutable snapshot. No cache is shared with another app session. Process restart clears the cache. Missing analysis does not trigger a hidden heuristic: unlabeled records have unknown identity and no counted sentiments.

## Stable source identity

Analysis deduplicates repeated records by `id`, not by text. Distinct IDs remain separate even when their text and thread context are identical. Repeated IDs must have the same source, provenance, text, URL, thread ID/title, parent ID, and publication date. Only `collectedAt` may differ; analysis keeps the first observation's collection time. Imports reject conflicting metadata before analysis. A direct analysis caller receives a failure for a conflicting occurrence, which is excluded; the first record remains. `contentHash` is a text fingerprint for change detection and caching, not the identity of a comment.

The synthetic duplicate now repeats its original ID. The fixture oracle remains 22 input records, one duplicate, and 21 unique records. Deleted or dead HN originals are not retained, but their valid descendants remain eligible within the collection limits. This traversal does not implement deletion synchronization for stored snapshots.
