# Hosting without added paid services

The public OverHeard-style dashboard is a static personal project at [cua-parse-demo.vercel.app](https://cua-parse-demo.vercel.app/). Its overview, issue categories, evidence, imports, and typed Vox search run in the browser. The release contains no research API, server functions, provider credentials, database, or private corpus.

The existing hosting account was confirmed active on Vercel Hobby on 22 September 2026. The release procedure does not add a payment method, upgrade the plan, or provision a paid service. Recheck the plan before later releases. Account-specific settings and history belong in private operations notes.

## Public data and resource limits

The build enforces a 5 MiB public artifact budget, including media. It rejects backend and provider modules and does not load environment files. Public response headers disable API connections, camera, microphone, and geolocation access. Local imports are limited to 5 MiB and 5,000 records. File contents stay in browser memory; they are not uploaded to Vercel or a research provider. A reload clears the imported dataset. The included sample is synthetic and must remain labelled as such.

As checked on 22 September 2026, Vercel documents these Hobby allowances:

| Resource           | Included allowance  |
| ------------------ | ------------------- |
| Fast Data Transfer | 100 GB per month    |
| Edge Requests      | 1,000,000 per month |
| Deployments        | 100 per day         |

Hobby is for personal, non-commercial use. Most exhausted limits require waiting until 30 days have passed before the feature can be used again. It is not an unlimited-availability promise. These limits and the use restriction come from the [official Hobby plan documentation](https://vercel.com/docs/plans/hobby).

If a free allowance is exhausted, allow hosting to pause and use the local static build until service resumes. Do not automatically upgrade, add a card, start a paid fallback, or change providers in response to a quota error. Keep the application usable without an API connection. An unavailable static host cannot display an in-app error before its files load; availability notices must not promise otherwise.

## Manual release

Start from the reviewed `main` revision after verification passes. Inspect the public files and confirm that imported user data is absent. Link only the generated artifact to the existing `cua-parse-demo` project:

```sh
npm run build:showcase
npm exec --yes --package=vercel@59.23.2 -- vercel link --cwd .site --project cua-parse-demo --scope sabdulmajids-projects --yes
rm -f .site/.env.local
npm exec --yes --package=vercel@59.23.2 -- vercel deploy --cwd .site --scope sabdulmajids-projects --prod --yes
```

The build replaces `.site/`, so relink after each build. This Vercel CLI version can download an identity token into `.env.local`; remove that generated file before deployment. The static app does not use it. Deploy from `.site/`, not the repository root. Keep generated Vercel project metadata in ignored output storage.

Confirm that the returned deployment and production alias serve the reviewed revision. Then run the hosted browser checks:

```sh
SHOWCASE_BASE_URL=https://cua-parse-demo.vercel.app/ npm run test:showcase
```

Verify the shared scope, issue and evidence views, typed search, valid and invalid imports, reset/reload behavior, keyboard use, and mobile layout. Confirm that imports and typed questions make no provider or upload requests. Check that environment and deployment metadata paths are not served. Record the release revision and measured results; passing a local test alone does not prove a public release works.

For rollback, use an existing reviewed Vercel deployment or rebuild and deploy an earlier reviewed static revision. Recheck the production alias after rollback. No backend state needs migration for a static release.

## Local preview and optional Pages

```sh
npm run build:showcase
node scripts/serve-showcase.mjs
```

The preview checks relative assets under `/cua-parse/`. The Vercel site serves the same static artifact from its root. `npm run test:showcase` starts an isolated preview when `SHOWCASE_BASE_URL` is unset.

The `Publish optional Pages demo` workflow remains disabled unless `ENABLE_GITHUB_PAGES` is exactly `true`. If enabled, it publishes only a verified current `main` revision or an explicit reviewed recovery dispatch. Its revision guard prevents an older workflow rerun from replacing newer source. It is separate from the manual Vercel release.

## Preserved research service

The existing research app remains available at `/research` in local service mode. It uses SQLite, Elasticsearch, and optional external providers. Its API accepts local HTTP origins and is not deployed with this dashboard.

Keep that service private or local. Supabase, an Elastic subscription, a model key, and a new paid host are not prerequisites for the public browser product. Optional live provider use can have separate charges and needs explicit configuration and authorization. No new full-service deployment is recommended or provisioned by this revision.

Any future public research service needs its own design review for authentication, durable budgets, source access, data retention, recovery, and provider costs. It must not silently change the free browser path. See [Setup](SETUP.md) for the local service and [OverHeard alignment](OVERHEARD_ALIGNMENT.md) for the integration boundary.
