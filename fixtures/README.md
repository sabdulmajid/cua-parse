# Synthetic research fixture

`acmeflow.ts` defines 22 invented records. One is an exact duplicate. Every URL is null. The declared labels support a repeatable product demonstration without model credentials. Fixture labels apply only when the product is AcmeFlow and the record text, source, provenance, ID, thread ID, and title match.

`acmeflow.expected.json` is an independent test oracle. Application code does not import its totals. It defines the exact counts before and after exclusion of the eight-record complaint thread. The fixture includes pricing praise, mixed aspect sentiment, unrelated and ambiguous products, a missing publication date, and an instruction injection. The injection is source text and has no counted aspects.

Generate records with `fixtureRecords()`; each call returns new objects. Use `npm run seed` to create a research snapshot through the normal collection, analysis, and Elasticsearch path.

## Source access and limits

Live collection uses the [documented public HN API](https://github.com/HackerNews/API) for item text. [YC announced the read-only API](https://www.ycombinator.com/blog/hacker-news-api/) as a supported alternative to HTML scraping. Discovery uses the public [Algolia HN search API](https://hn.algolia.com/api), with implementation details in [Algolia's source repository](https://github.com/algolia/hn-search). Documentation checked on 2026-09-19.

Requests use fixed API origins. Imported and discovered external story URLs are never fetched. Each job uses at most three discovery queries, ten threads, 150 records, two concurrent item requests, 190 primary item requests, and one retry per request. Each HTTP call times out after eight seconds. Live collection has a 90-second deadline. Retry-After is respected; a delay above five seconds stops that request instead of retrying early. Discovery selects the first result page and item traversal follows the API reply order. This is a bounded discussion sample, not a representative customer survey. A newer research job can collect different source text.

The [YC terms](https://www.ycombinator.com/legal/) restrict commercial reuse unless authorized. Availability of the API is not a commercial redistribution license. This adapter is for the local research demonstration. Do not publish the collected corpus or use it commercially without the required authorization. The API documents deletion flags; the collector excludes deleted/dead items on every fresh collection. Local snapshots do not poll for later deletions. Retain no public corpus, delete local research snapshots when no longer needed, and honor source removal requests. Production retention and deletion synchronization require a separate policy and implementation.

## Analysis

Live model analysis uses the official OpenAI SDK `responses.parse()` with `zodTextFormat()`, as documented in [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). It sends up to four records per request, disables response storage, uses one retry, and respects cancellation. The application validates record IDs, relevance/identity consistency, exact supporting quote spans, exact product-name identity spans, and one label per aspect. Schema and quote validation do not prove that a model interpretation is correct. Aliases without the requested product name remain ambiguous.

Validated labels are cached for 30 minutes in a bounded process cache, keyed by session, product, model, analysis version, source text and thread context. Cached labels are copied into each immutable snapshot. No cache is shared with another app session. Process restart clears the cache. Missing analysis does not trigger a hidden heuristic: unlabeled records have unknown identity and no counted sentiments.
