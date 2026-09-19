# Public access and full-service hosting

CUA Parse has two publication targets: a public guided demo for immediate access, and the research service for authenticated use. They have separate operating needs.

## Public guided demo

The guided demo contains the research flow, source cards, downloadable brief, and a recording of the working app. The records are explicitly synthetic AcmeFlow feedback. Its four evidence states are exported from the real research API and checked against the fixture oracle. It does not accept arbitrary questions or initiate a live model conversation.

The canonical public URL is [cua-parse-demo.vercel.app](https://cua-parse-demo.vercel.app/). For each release, confirm that this production alias serves the reviewed revision before announcing it.

Vercel serves only the reviewed `showcase/` assets assembled into `.site/`. No API, environment file, credential, database, or private corpus is deployed. Releases use the Vercel CLI manually. The static site remains useful when research providers are unavailable.

### Release the reviewed main revision

Start from the reviewed `main` revision after its `Verify` checks pass. Review the public asset list and confirm that the video and JSON contain synthetic data only. Use the authenticated Vercel account with access to the dedicated `cua-parse-demo` project in `sabdulmajids-projects`.

```sh
npm run build:showcase
npm exec --yes --package=vercel@59.23.2 -- vercel link --cwd .site --project cua-parse-demo --scope sabdulmajids-projects --yes
rm -f .site/.env.local
npm exec --yes --package=vercel@59.23.2 -- vercel deploy --cwd .site --scope sabdulmajids-projects --prod --yes
```

The build deletes and recreates `.site/`. **Run the link command again after every rebuild.** Its project metadata stays inside the ignored output directory. This CLI version can also download a short-lived Vercel identity token into `.env.local`; remove that generated file before publication, as shown above. The static demo does not use it. Deploy from `.site/`, not from the repository root. Do not place application configuration or provider credentials in that directory.

Check the deployment URL returned by Vercel and its production alias. Run the public browser suite against the confirmed alias:

```sh
SHOWCASE_BASE_URL=https://cua-parse-demo.vercel.app/ npm run test:showcase
```

Keep the trailing slash. The suite checks the guided states, source inspection, brief export, recovery, controls, mobile layout, captions, and video playback. Record the reviewed Git revision and the deployed URL in the release notes. See [demo production](DEMO.md) for reproduction and media checks. Re-record if app behavior or fixture facts change.

### Preview and optional GitHub Pages

To preview the static artifact for development:

```sh
npm run build:showcase
node scripts/serve-showcase.mjs
```

The preview uses `/cua-parse/` to check relative assets under a repository subpath. `npm run test:showcase` starts an isolated preview server when `SHOWCASE_BASE_URL` is unset. The same assets can be served from the root path on Vercel.

The `Publish optional Pages demo` GitHub Pages workflow is an optional alternative. It is disabled unless the repository variable `ENABLE_GITHUB_PAGES` is exactly `true`. When enabled, it publishes only the selected current `main` revision after a successful `Verify` push or an explicit main-branch recovery dispatch. PR workflows cannot publish. A revision check prevents a historical rerun from replacing newer `main` content. Action versions are pinned to commit IDs. This workflow does not release to Vercel.

For rollback, use Vercel's rollback operation for an existing reviewed deployment, or rebuild and redeploy a reviewed earlier static revision with the same CLI steps. Verify the production URL again after rollback. The research service and its data are separate from these static releases.

## Full research service: recommended next deployment

The current API intentionally accepts loopback HTTP origins and binds to `127.0.0.1`. It uses SQLite and an in-process research queue. It is not ready to become an anonymous public API by changing a hostname. No full-backend deployment is included in this publication.

A feasible first hosted version is **one paid Render web service with a persistent disk**, managed Elasticsearch, and sign-in restricted to invited users. Keep one process and one instance while SQLite and the in-memory queue remain authoritative. Put SQLite, its WAL files, and app-owned persistent state under the mounted data directory. Keep source collection workers separate from the reader service.

Render's default filesystem is ephemeral. Persistent disks are attached to paid services, are available to one instance, and change deployment/scale behavior. This fits a first single-instance research service. It does not provide horizontal scaling or a high-availability claim. See [persistent disks](https://render.com/docs/disks).

The launch work is concrete:

1. Add an explicit hosted mode with an exact HTTPS origin allowlist, secure cookies, and a configurable listen address. Preserve the existing local mode and its tests.
2. Require sign-in before creating sessions, jobs, or provider leases. Assign research ownership to an authenticated user. Do not treat an anonymous cookie as a spending entitlement.
3. Add durable per-user and global provider budgets, concurrency limits, and an operator stop control. Process-memory limits reset on restart and are insufficient as a public spending control.
4. Provision separate source-reader and evidence-writer Elasticsearch roles. Test the internal mapping against the selected service version. Agent Builder access needs its own checked permissions.
5. Put secrets in the host's secret store. Retain one stable session secret across restarts. Configure and test the private ElevenLabs agent for the hosted origin and real browser transport.
6. Verify database backup/restore, index recovery, interrupted jobs, cancellation, source deletion policy, sanitized logs, and provider outages.
7. Run one bounded signed-in acceptance flow: research → evidence → exclusion → challenge → matching brief. Check text and real microphone behavior separately. Load-test before selecting final memory and concurrency limits.

As of 19 September 2026, Render lists a 512 MB / 0.5 CPU service at **US$7/month** and persistent disks at **US$0.25/GB/month**. Thus a service plus a 1 GB disk starts at **US$7.25/month for those two components only**. This is not the full product cost or a measured sizing recommendation. Add Elasticsearch, model/voice usage, bandwidth, applicable workspace charges, and tax. Verify [current pricing](https://render.com/pricing) before purchasing. No paid infrastructure or subscription is created by this change.

Move to a shared database and durable queue before adding API replicas. The public demo can keep the same URL while the authenticated service is introduced behind a separate explicit entry point.
