# Personal OS: a portfolio case study

## The problem

Long-running conversations accumulate goals, decisions and useful evidence. A full archive is expensive context, and an old statement is not necessarily still true. I wanted an assistant that could retrieve a relevant piece of history while keeping current priorities separate from historical material.

The public result is a single-user Telegram assistant with structured memory, hybrid retrieval and several inference adapters. It is a learning project developed with substantial AI assistance. This case study describes the code, not a verified production deployment.

## What the repository demonstrates

| Engineering concern | Evidence in the public code |
| --- | --- |
| Request lifecycle | [Telegram entrypoint](../supabase/functions/telegram/index.ts): acceptance, ingress records, background work and outcome status |
| Memory model | [Base migration](../supabase/migrations/20260905130000_personal_os_v1.sql): records, sources, messages and current state |
| Entity and history retrieval | [Hardening migration](../supabase/migrations/20260906093000_personal_os_v1_1_memory_routing_hardening.sql): entity tables and hybrid retrieval |
| Query planning | [Retrieval module](../supabase/functions/_shared/retrieval.ts): domains, depth, relevance and bounded results |
| Provider selection | [Router](../supabase/functions/_shared/model-router.ts): eligibility, scoring, usage, circuits and fallback |
| Response checks | [Shared validator](../supabase/functions/_shared/schema-validation.ts) and its [tests](../supabase/functions/_shared/schema-validation.deno.ts) |
| Public release hygiene | [Audit script](../scripts/audit-public.mjs), [ignore rules](../.gitignore) and [CI workflow](../.github/workflows/ci.yml) |

## Design decisions

### Keep the interface small

Telegram supplies text and voice input. A webhook checks the configured secret and owner account, then inserts an ingress event. A duplicate key identifies an already-accepted update. The handler acknowledges acceptance while the Edge Function continues processing in the background.

This reduces repeat processing caused by webhook redelivery. It does not provide a durable queue: a worker interruption can still leave incomplete processing, and the acceptance error path returns HTTP 200. Recovery needs its own integration tests.

### Separate kinds of memory

Current state holds compact working context. Canonical records represent durable items such as goals and decisions. Source documents and chunks preserve evidence, with entity links providing stable identity anchors.

Historical user evidence can help explain a change over time. Quarantined material has different retrieval permissions. These distinctions help prevent an old assistant suggestion from being treated as a current user fact, but source labels and extraction decisions still need validation.

### Combine lexical and semantic retrieval

The planner detects domains and determines how much context to request. It can combine exact/entity matching, full-text search and pgvector similarity. If query embedding fails, the code continues with lexical/entity retrieval.

The trade-off is complexity. Domain detection includes keyword heuristics, thresholds need evaluation, and relevance is not proved by an attractive answer. A hand-checked synthetic question set is the next useful measurement.

### Route by policy and availability

The registered inference adapters are Google, NVIDIA and OpenRouter. Selection accounts for configured sensitivity eligibility, task fit, quota counters, circuit state and provider-share targets.

At the router level, default limits allow at most five attempts: two Google, two NVIDIA and one OpenRouter. Adapters can also retry transport failures, so these are not a strict maximum of five outbound HTTP requests. Quality and speed values are configured scores, not benchmark results.

Transcription and embeddings use separate Google calls. Choosing NVIDIA for a reply does not mean the whole request used only NVIDIA.

### Validate before using model output

Provider adapters parse JSON and run shared checks for required fields, nested types and enums. The application then interprets the response and proposed memory operations.

This validator is small. It does not implement every JSON Schema keyword or prove factual correctness. For example, the local validator does not enforce `additionalProperties`, even though the lowered provider schema can request it. Stronger validation and operation-level tests are planned.

### Send the reply before enrichment

The worker sends the reply before record persistence, state updates and embedding enrichment finish. A delivered answer is therefore not proof that memory was updated.

The code records some enrichment errors and can send a warning. Several database operations log and continue, so a future status model should report partial success more explicitly.

## Development lessons

The public repository starts with a sanitized snapshot. These lessons come from the development/release work and are not presented as a complete public Git history.

| Problem encountered | Lesson carried into the public project |
| --- | --- |
| A copied update was incomplete and npm scripts/files were missing | A release must include verification files and dependencies, not just a README |
| Test discovery entered a nested update payload | Restrict Node tests to the intended directory |
| Privacy checks found owner-specific words in source | Keep personal vocabulary in private configuration and scan tracked files |
| Deno rejected typed-array inputs accepted elsewhere | Test in the deployment toolchain, not only one local runtime |
| Local and remote branches diverged | Inspect state and preserve work before reconciling branches |
| Earlier release notes describe HTTP success with malformed JSON | Transport success and application-contract success are different checks |

The source contains the fixes or supporting controls, but this portfolio preparation did not repeat live provider calls.

## Privacy boundaries worth explaining

The project is privacy-aware, not a promise of complete privacy.

- Text checks reject certain recognizable secrets before conversational inference.
- Voice audio reaches cloud transcription before equivalent text checks.
- Semantic retrieval can send query text for embedding before final route-sensitivity classification.
- `/nostore` suppresses raw content, while metadata and canonical changes may remain.
- Some error paths include excerpts of provider output in diagnostics; logs need their own retention and redaction review.
- Ignoring private files and passing a pattern scan do not prove that history, images or every credential format are safe.

A public demo should use synthetic input in an isolated environment.

## Ownership and learning

I used ChatGPT and GitHub Copilot extensively to help generate, explain and revise code. I defined the use case, made product choices, worked through setup and debugging with assistance, ran checks and managed the public-release workflow.

That gave me practical exposure to:

- following a request across webhook, retrieval, inference and storage;
- distinguishing raw data from structured memory and source evidence;
- reading logs and separating environment problems from application failures;
- Git branches, merges, CI checks and release packaging;
- thinking about privacy as a data-flow issue.

It does not mean I can already design every part independently. My next milestone is to explain one path without AI, add a regression test and make a small change without relying on a full generated rewrite.

## What remains unproven

The repository does not publish a retrieval benchmark, calibrated privacy-classification accuracy, independent security audit, latency distribution, cost analysis or multi-user deployment evidence. Its small suite covers helpers and part of the schema contract.

Useful measurements include retrieval recall on known examples, correct memory updates, duplicate-event behavior, provider failures and persistence under each mode. Those belong in the [roadmap](ROADMAP.md), with datasets and test instructions.

## A short interview walkthrough

Start with the [architecture](../assets/personal-os-architecture.svg), then trace one text message through the entrypoint. Explain the memory layers and how a provider becomes ineligible. Finish with one boundary: raw-message suppression is not the same as disabling every database write.

This is useful software built with AI assistance, accompanied by evidence about how it works and clarity about what still needs work.
