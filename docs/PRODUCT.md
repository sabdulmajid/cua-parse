# Case study: when one thread changes the conclusion

CUA Parse helps a product team examine feedback before it becomes a decision. A useful summary needs more than representative quotations. It needs a defined sample, evidence that a reader can inspect, and a way to test how much one discussion affects the result.

The [guided demo](https://cua-parse-demo.vercel.app/) asks about pricing and onboarding for AcmeFlow, an invented product. It uses synthetic records throughout. The saved responses were exported from the working app's research API. The [walkthrough](https://cua-parse-demo.vercel.app/#walkthrough) shows the working app with the same kind of synthetic research flow.

## The question

“What do people dislike about AcmeFlow, especially its pricing and onboarding?”

The sample contains praise, complaints, mixed aspects, one repeated source identity, ambiguous product references, a missing date, unrelated feedback, and an instruction embedded in source text. One discussion contains eight pricing complaints. This makes it possible to check whether the app handles a difficult sample without a changing external dataset.

## What changes when the scope changes

**Scope** means the records included in a result. A **mention** means one aspect label on a record. One record can discuss both pricing and onboarding, so mention counts are not the same as record counts.

The guided demo first filters for pricing, then excludes the dominant discussion. The table follows those same two steps.

| Measure                   | Pricing scope | Pricing scope after excluding the dominant discussion |
| ------------------------- | ------------: | ----------------------------------------------------: |
| Relevant records          |            13 |                                                     5 |
| Discussions in scope      |             4 |                                                     3 |
| Pricing mentions          |            13 |                                                     5 |
| Negative pricing mentions |             9 |                                                     1 |
| Positive pricing mentions |             3 |                                                     3 |
| Neutral pricing mentions  |             1 |                                                     1 |

The eight negative pricing mentions removed by the exclusion came from one discussion. The original result correctly shows that pricing complaints dominate this sample. The changed result shows that this conclusion depends strongly on one discussion. Neither result establishes how most customers feel.

These values come from the pricing and exclusion responses in [the exported demo data](../showcase/data/demo.json). The [independent fixture expectations](../fixtures/acmeflow.expected.json) define the pricing counts. The working app calculates metrics from stored evidence. The hosted guided sample displays those exported responses and does not run a new search.

## The research flow

1. **Inspect the finding.** Open a citation and read the full synthetic record. The displayed quote must occur in that record.
2. **Focus on an aspect.** Select pricing. The result now measures pricing evidence, rather than treating every product comment as a pricing opinion.
3. **Exclude the dominant discussion.** Both the counts and the displayed evidence must change. An example from the excluded discussion cannot remain in the answer.
4. **Challenge the conclusion.** A negative conclusion calls for positive opposing evidence. The app uses actual records from the current scope. It does not invent an opposing argument.
5. **Export the brief.** The brief records the current scope, findings, evidence references, and limitations.

The hosted sample offers these prepared steps, citation inspection, and a brief download. It is a guided exploration of saved results. It does not accept arbitrary live research questions or connect a microphone to an agent.

## Why this is an engineering problem

A source ID must identify the same record across repeated collection. Equal wording alone is not enough: two distinct comments that say the same thing must remain distinct. Product identity, parent context, source dates, and provenance must survive normalization.

Counts and quotations also need a common scope. Returning a plausible quote from an old request can mislead a reader even when the quote itself is accurate. CUA Parse tracks request and scope versions, rejects conflicting identities, and discards responses that arrive after the user starts different research.

The fixture provides a repeatable test of these rules. Live provider checks establish a different fact: whether a provider connection and tool flow completed. The project reports these forms of verification separately. See [Verification](VERIFICATION.md).

## Current limits

The research-job path supports bounded public Hacker News collection, authorized imports, and synthetic fixtures. It supports ElevenLabs text and voice, aspect analysis, scope changes, challenge, and brief export. Public discussions are not a representative customer survey. The sample may contain unrelated, historical, ambiguous, or missing evidence.

Uploaded YouTube research is a separate path. It reads an existing Elasticsearch corpus, filters the selected product, and uses Elastic Agent Builder to select source passages. Uploaded labels remain unverified metadata. It does not collect YouTube comments, and it is not connected to the research-job voice tools or shared brief.

Exact quote checks show that a passage exists in the supplied source. They do not prove that a product claim is true. Physical microphone quality still requires a manual check. X and Reddit collection, source-deletion synchronization, and a unified multi-source conversation remain unimplemented. The working backend is intended for local operation; the public guided sample is static.

See [Architecture](ARCHITECTURE.md) for the current system and [Agent handoff](AGENT_HANDOFF.md) for proposed integration work.
