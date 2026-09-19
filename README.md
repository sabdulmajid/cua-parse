# CUA Parse

[![Verification](https://github.com/sabdulmajid/cua-parse/actions/workflows/ci.yml/badge.svg)](https://github.com/sabdulmajid/cua-parse/actions/workflows/ci.yml)

**Turn scattered product feedback into findings you can inspect.**

One large complaint thread can dominate a product summary. CUA Parse connects each finding to original feedback, shows how much evidence supports it, and lets you remove that thread to see what changes.

[**Explore the guided demo →**](https://cua-parse-demo.vercel.app/) · [Watch the 60-second walkthrough](https://cua-parse-demo.vercel.app/#walkthrough)

[![CUA Parse research workspace: inspect feedback, change scope, and check the sources](showcase/assets/preview.gif)](https://cua-parse-demo.vercel.app/)

The guided sample uses **synthetic AcmeFlow feedback**. Its saved results come from the working research app. The walkthrough records that app; the hosted sample lets you explore those results without a live provider connection.

## Follow the evidence

Ask about pricing and onboarding. Open a citation. Exclude the largest complaint thread. Check whether the remaining feedback changes the conclusion. Then challenge it with actual opposing evidence and export the current brief.

The sample makes the effect visible: negative pricing mentions fall from **9 of 13** to **1 of 5** after one discussion is excluded. These are facts about the invented sample, not customer research results. [Read the case study](docs/PRODUCT.md).

## What the working app supports

| Research path             | Capabilities                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research jobs             | Bounded public HN collection, authorized JSON imports, synthetic fixtures, aspect analysis, scope filters, opposing evidence, and decision briefs. ElevenLabs supports text and voice conversations. |
| Uploaded YouTube comments | Typed questions, explicit product selection, Elasticsearch scope counts, Elastic Agent Builder evidence selection, original citations, and video exclusions.                                         |

The [architecture guide](docs/ARCHITECTURE.md) explains each path, its evidence contract, and current integration boundaries.

## Built for review

- **Counts come from the selected evidence scope.** Displayed examples do not become the denominator.
- **Quotes remain traceable.** Source-span checks preserve original text and context; they do not establish that an interpretation is true.
- **Changes have tests.** Synthetic fixtures, Elasticsearch integration tests, and browser regressions cover exclusions, identity, cancellation, product isolation, and late replies.

The implementation uses TypeScript, React, Express, SQLite, Elasticsearch, OpenAI, and ElevenLabs. The backend and shared schemas can support another frontend.

[Architecture](docs/ARCHITECTURE.md) · [Hosting](docs/HOSTING.md) · [Engineering setup](docs/SETUP.md) · [Verification](docs/VERIFICATION.md) · [Contributing](CONTRIBUTING.md) · [Integration handoff](docs/AGENT_HANDOFF.md)
