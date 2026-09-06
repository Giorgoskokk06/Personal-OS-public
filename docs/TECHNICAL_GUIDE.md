# Technical guide

This guide describes the public v1.3.2 source. It does not certify a live deployment or current model availability.

## Source map

| Area | Read first |
| --- | --- |
| Webhook acceptance and worker | [telegram/index.ts](../supabase/functions/telegram/index.ts) |
| Defaults and model pool | [config.ts](../supabase/functions/_shared/config.ts) |
| Retrieval planning | [retrieval.ts](../supabase/functions/_shared/retrieval.ts) |
| Prompt, commands and memory | [os.ts](../supabase/functions/_shared/os.ts) |
| Ranking, circuits and fallback | [model-router.ts](../supabase/functions/_shared/model-router.ts) |
| Active adapters | [providers/registry.ts](../supabase/functions/_shared/providers/registry.ts) |
| Google generation, embeddings and voice | [gemini.ts](../supabase/functions/_shared/gemini.ts) |
| Schema and retrieval SQL | [migrations](../supabase/migrations) |
| Import and audit helpers | [scripts](../scripts) |

The `omniroute.ts` file is not registered in the active provider registry. It is not a fourth active route.

## Request walkthrough

1. The endpoint checks the method, Telegram webhook-secret header and owner account.
2. It gets/creates the application user and conversation, then inserts an ingress event. A unique-constraint violation returns a duplicate acknowledgement.
3. It acknowledges acceptance and uses `EdgeRuntime.waitUntil` for the worker.
4. Voice is downloaded from Telegram and transcribed by Google; text enters parsing directly.
5. Help, state and a small deterministic response path can bypass conversational inference.
6. Other messages are checked for recognizable hard-secret patterns. The worker creates a placeholder with a hash and no raw text.
7. Retrieval gathers recent messages, relevant current state, records and source chunks. Optional query embeddings have a lexical fallback.
8. Sensitivity heuristics inspect the text and retrieved context. The router ranks eligible models and applies bounded fallback.
9. The provider parses the result and validates supported schema fields.
10. The worker decides whether raw text can be persisted and sends the reply.
11. Record operations, guarded current-state changes and eligible embeddings run afterward. Telemetry and ingress state record the outcome.

These steps are not one database transaction. Error and partial-success paths need separate tests.

## Provider routing

Defaults in [config.ts](../supabase/functions/_shared/config.ts):

| Control | Default | Interpretation |
| --- | --- | --- |
| `MODEL_MAX_ROUTE_ATTEMPTS` | 5 | Router attempts, excluding adapter-internal retries |
| Per-provider caps | Google 2, NVIDIA 2, OpenRouter 1 | Candidate-attempt limits |
| `MODEL_TIMEOUT_MS` | 45000 | Used by provider requests; not a total request deadline |
| Provider target weights | 0.40 / 0.40 / 0.20 | Google/NVIDIA/OpenRouter scoring targets |
| `OPENROUTER_DAILY_LIMIT` | 50 | Configured guard, not verified account entitlement |
| `OPENROUTER_QUOTA_RESERVE_REQUESTS` | 5 | Reserve used outside deep mode |
| `ALLOW_PAID_FALLBACK` | false | Paid fallback disabled by default |
| Daily/monthly AI budgets | 0 / 0 USD | Positive budgets and known pricing required for paid routes |

The router reads model/provider circuit state and recent runs from Postgres. It distinguishes rate limits, authentication/billing errors, unavailable endpoints and some capability mismatches. Eligible providers are interleaved during fallback.

Usage and budget lookups are best-effort, not atomic quota enforcement or a billing guarantee. Some routes are configured as free; account terms must be checked separately.

Default conversational eligibility:

| Sensitivity | Google | NVIDIA / OpenRouter |
| --- | --- | --- |
| `personal_safe` | Eligible | Eligible |
| `work_safe` | Eligible | Eligible |
| `personal_sensitive` | Eligible | Ineligible unless explicitly enabled |
| `work_confidential` / `restricted` | Ineligible | Ineligible |

This table applies to the default conversational pool. A custom `AI_MODEL_POOL_JSON` can change eligibility. It does not describe separate transcription/embedding calls or promise correct classification.

OpenRouter's adapter requests `require_parameters=true` and, by default, `data_collection=deny` and `zdr=true`. These are upstream preferences, not independently audited retention guarantees. A dynamic-route 404 becomes `provider_no_eligible_endpoint`.

NVIDIA uses JSON-object mode and local validation. Google uses a response schema and the same shared validator. Treat model identifiers as version-specific configuration; validate access and contracts in an isolated account before enabling them.

## Retrieval and storage

The current hybrid SQL functions are `match_records_hybrid_v4` and `match_source_chunks_hybrid_v4`. The planner also uses `profile_records_v2` and `profile_source_chunks_v1` for broader requests. Entity IDs, domains, scope and result limits constrain retrieval.

The embedding dimension is 768. Query embedding failure leaves lexical/entity retrieval available. Record embedding is best-effort and limited to selected sensitivity classes. Quarantine exclusions are in source-retrieval SQL; they do not sanitize arbitrary imports automatically.

`persistOperations` handles proposed create/update/ignore/supersede/close operations and canonical-key deduplication. `applyCurrentState` checks intent, fact state and question-like inputs. These need semantic tests in addition to schema checks.

## Local setup boundaries

The [README](../README.md#run-a-safe-local-check) has credential-free checks. A live bot needs more than installing Node packages:

| Requirement | Purpose |
| --- | --- |
| Deno/Supabase Edge runtime | Webhook execution and background work |
| Separate test Supabase project | Schema and synthetic memory |
| Separate Telegram test bot | Sample messages without changing a real bot's webhook |
| Owner ID and webhook secret | Restrict accepted requests |
| Provider credentials and validated models | Enable selected inference routes |
| Google access for voice/embeddings | Required for these paths even when replies use another provider |

Use [.dev.vars.example](../.dev.vars.example) as a variable-name reference. Values are placeholders or version-specific defaults, not a ready-to-run configuration. Put real values only in ignored local files or deployment secrets.

Node helpers load `.dev.vars`/`.env`. The Edge Function reads runtime environment variables. One does not configure the other automatically.

[supabase/config.toml](../supabase/config.toml) disables JWT verification for the Telegram function, which uses its own webhook-secret check. Preserve that check and the owner gate.

This portfolio update does not apply migrations, set webhooks, configure secrets or deploy. For a new test environment, review the three migrations in timestamp order and the deployment tooling before any setup. Never reset, truncate or import into an existing production database for a demo.

## Diagnostics and side effects

| Command | Scope / caution |
| --- | --- |
| `npm test` | Local helper tests; no credentials |
| `npm run test:deno` | Local schema tests; requires Deno |
| `npm run check:syntax` | Node scripts-directory syntax checks |
| `npm run audit:public` | Tracked working-tree files; stage new files for inclusion |
| `npm run check:os` | Configured database diagnostics |
| `npm run audit:memory` / `npm run audit:routing` | Database reads; output can be private |
| `npm run debug:retrieval` | Can use a configured database/provider; inspect flags first |
| `npm run preflight:providers -- --provider=openrouter --auth-only` | Credentialed network call, not an offline test |
| `npm run import:os -- imports/example_import.json --dry-run --no-embed` | Still resolves an owner through the database |
| Import/backfill without dry-run | Can write data and/or call embedding providers |

The public-file audit checks selected patterns and optional `PERSONAL_OS_PRIVATE_MARKERS`, not full history or image content. CI supplies the marker variable from a repository secret when available. Never print or commit its private value.

## Verification scope

Seven Node helper tests and three Deno schema tests exist in the base version. CI also checks Edge Function types. Passing checks do not prove deployment configuration, provider availability, retrieval quality, privacy correctness or complete memory persistence.

The [roadmap](ROADMAP.md) defines the missing evidence.
