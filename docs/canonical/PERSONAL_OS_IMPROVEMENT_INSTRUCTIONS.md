# PERSONAL OS IMPROVEMENT INSTRUCTIONS

Version: 1.3.2
Updated: 2026-09-06
Status: canonical engineering instructions for the Personal OS

## Purpose

Improve the Personal OS through small, measurable, reversible changes while preserving memory integrity, privacy, answer quality and production availability. The system exists to help its owner think, remember, decide and act; infrastructure is subordinate to that goal.

## Current production shape

Telegram is the primary interface. Supabase Edge Functions handle ingress and orchestration. Supabase Postgres is the operational source of truth. Retrieval combines current state, canonical records, stable entities, FTS, vectors, diversified profile retrieval and bounded historical user evidence.

The v1.3 inference plane is provider-diverse:

```text
Personal OS privacy/task/retrieval router
    ↓
healthy eligible candidate scoring
    ├── Google Gemini direct
    ├── NVIDIA hosted NIM
    └── OpenRouter openrouter/free
```

No provider is a permanent default. Selection is driven by privacy, circuit health, task fit, model capability, quota/budget headroom, quality/latency profile and recent provider share.

## Current progress — do not rebuild without evidence of regression

Already solved:

- Telegram text + voice production path
- webhook validation, owner gate and ingress idempotency
- canonical records + history + provenance
- current-state hot context with relevance gating
- stable entity graph and entity-linked relationship memory
- retrieval v4: exact/entity + FTS + pgvector + profile diversification
- bounded historical user-authored evidence; old assistant output excluded
- privacy-before-persistence policy
- persistent model/provider circuit state
- routing telemetry and audits
- deep retrieval across relevant domains without whole-archive prompt dumping
- independent-provider inference plane

Important memory lesson: canonical summaries are not a substitute for retrieval-ready historical evidence.

Important current-state lesson: global priorities are context, not a mandate to mention work/career in unrelated answers.

## Data truth rules

Precedence:

```text
newest explicit user statement
> verified current/official evidence
> durable canonical fact
> older plans/assumptions
> inference
```

Preserve fact state. Never silently convert goals, plans, assumptions, hypotheses or interpretations into facts. Never invent dates to repair conflicting history.

A person/project/org is one stable entity. Different event, decision, relationship-status and evidence records may link to the same entity. New wording is not a new entity.

## Privacy rules

Classify before persistence and before model routing.

- `personal_safe`: may be stored and may use eligible providers.
- `personal_sensitive`: may be stored when useful; direct Google is allowed; external providers remain opt-in.
- `work_safe`: only sanitized career-safe abstractions.
- `work_confidential`: never persist raw company/client-confidential content in Personal OS; only a safe abstraction if permitted.
- `restricted`: credentials, passwords, tokens, customer personal data; never persist or send through model routes.

External defaults:

```text
OPENROUTER_ALLOW_PERSONAL_SENSITIVE=false
NVIDIA_NIM_ALLOW_PERSONAL_SENSITIVE=false
```

Never weaken privacy automatically to improve availability.

## Retrieval improvement protocol

When an answer misses known memory, debug in this order:

1. Was the information imported as canonical or historical user evidence?
2. Is the entity resolved correctly?
3. Did domain/intent gating exclude the right source?
4. Did exact/FTS retrieval find it?
5. Did vector retrieval find it?
6. Was current-state context incorrectly injected?
7. Did reconciliation select stale evidence over newer evidence?
8. Was the final context budget/diversification the problem?

Do not solve retrieval gaps by blindly raising every retrieval limit.

## Routing improvement protocol

Every provider/model change must answer:

1. What measured failure mode or task gap are we solving?
2. Does the exact model pass the Personal OS structured contract?
3. What are its privacy/quota/cost boundaries?
4. How will we observe whether routing actually improved?

Router priority:

```text
privacy / safety eligibility
→ circuit availability
→ role/capability fit
→ quota/budget viability
→ quality + latency
→ recent provider balance
```

Provider balancing is not blind round-robin. v1.3 uses a target-share scoring adjustment:

```text
google:0.40,nvidia:0.40,openrouter:0.20
```

This prevents a hard Gemini default while protecting the small OpenRouter free allowance. It must never override privacy, a circuit, required capability or a known quota guard.

Default attempt caps:

```text
total       5
Google      2
NVIDIA      2
OpenRouter  1
```

A 5xx/timeout is model/endpoint-level unless evidence proves a provider-wide outage. 401/403 are provider-auth failures. 429 is quota/rate handling. Do not retry indefinitely.

Unknown quota is not unlimited quota. If a provider does not publish a stable account limit, use reactive circuits rather than inventing one.

## OpenRouter rules

Use one logical route only:

```text
openrouter/free
```

Free-model account limits are shared; multiple free slugs do not create independent quota.

Release authentication should use `/api/v1/key`, which does not consume a model call. A strict runtime request may still fail even with valid auth because `require_parameters`, `data_collection=deny` and `zdr=true` can leave zero eligible free upstreams.

Classify dynamic-router 404 as `provider_no_eligible_endpoint`, open a short route circuit and fall through to NVIDIA/Gemini. Never disable ZDR/data-collection protections just to make the free route answer.

Keep one OpenRouter attempt per user request. Current free guard:

```text
OPENROUTER_DAILY_LIMIT=50
OPENROUTER_QUOTA_RESERVE_REQUESTS=5
```

Any API key pasted into chat, a commit, a ticket or another untrusted surface is compromised for operational purposes. Rotate it; do not debate whether it still works.

## NVIDIA NIM rules

Canonical runtime secret:

```text
NVIDIA_NIM_API_KEY
```

Do not maintain competing live aliases. The release tool may accept `NVIDIA_API_KEY` only as a migration input, then normalize to `NVIDIA_NIM_API_KEY`.

Current candidate catalog is verified against NVIDIA Build, but live account calibration is the final enablement gate:

```text
nvidia/nemotron-3.5-lightning-30b-a3b
deepseek-ai/deepseek-v4-flash-0731
deepseek-ai/deepseek-v4-pro-0813
nvidia/nemotron-3-super-120b-a12b
nvidia/nemotron-3-ultra-550b-a55b
moonshotai/kimi-k3
```

Only models that pass the real Greek + structured JSON contract with the production key belong in `NVIDIA_NIM_ENABLED_MODELS`.

Observed v1.3 lesson: HTTP 200 is not enough. Lightning once returned semantically correct prompt-only JSON with a literal newline inside a string, so `JSON.parse()` correctly rejected it. Provider transport health and structured-contract health are separate concepts.

For structured Personal OS calls, use native JSON mode when available:

```json
{"response_format":{"type":"json_object"}}
```

Then validate locally against the full schema. Do not regex-repair malformed canonical-write output.

For Nemotron/DeepSeek structured calls, disable visible reasoning when the endpoint supports it. Structured reliability outranks exposing a reasoning trace. Deep mode can still use deeper retrieval and stronger models. Never expose or persist `reasoning_content`.

## Provider-contract semantics

A calibration result should distinguish:

```text
auth_ok
transport_ok
structured_ok
finish_reason
served_model
```

Examples:

- `401/403`: auth/provider credential problem.
- `200 + structured_ok=false`: model is reachable but not eligible for structured Personal OS routing.
- `404` on `openrouter/free` with valid key: dynamic capability/privacy route unavailable now; short circuit + fallback.
- `429`: quota/rate circuit; do not treat as bad credentials.
- `5xx/timeout`: transient model/endpoint failure; keep healthy siblings/providers eligible.

## Telegram response-quality standard

A technically correct answer is still a bad Personal OS answer if it sounds synthetic.

Default output:

- start with the answer
- natural Greek when the user writes Greek
- plain text; no Markdown bold/headings/decorative separators
- no generic praise, fake excitement or sycophancy
- no restating the prompt
- no narration of retrieval/model choice/internal process
- cohesive paragraphs; one short list maximum when useful
- `/fast` usually <=120 words
- normal/capture usually <=300 words
- `/deep` usually <=700 words unless more depth is actually needed

The final normalizer is a presentation guard, not a substitute for good prompting. Do not add a second semantic rewrite pass without evidence it improves output enough to justify extra latency/quota.

## Definition of done

A change is done only when:

- the problem is reproduced or evidenced
- the smallest safe implementation is applied
- static checks pass
- relevant memory/retrieval/routing audits pass
- privacy behavior is unchanged or explicitly approved
- observability exists for the new behavior
- production health passes after deploy
- docs/config match runtime behavior
- no secret/private file is staged
- release uses normal commit/tag and no force-push

For model/provider work, require a real contract preflight. For retrieval work, require a real query regression. For schema work, use forward-only migrations and a restore plan.

## Production safety

Never run `supabase db reset --linked` now that production contains real user data. Never truncate or bulk-delete as an upgrade shortcut. Never force-push a release branch. Never commit `.dev.vars`, private imports, export dumps or API keys.

Before replacing files, back up only the touched release surfaces. Preserve unrelated dirty work.

## Observability

Prefer evidence from:

- `model_runs`
- `model_route_state`
- `provider_route_state`
- message routing metadata
- retrieval diagnostics
- `npm run audit:routing`
- `npm run audit:memory`
- `npm run check:os`

For OpenRouter, preserve both requested logical route (`openrouter/free`) and returned `served_model` when available. The circuit key remains the logical route.

## Anti-overengineering rule

Do not add providers/gateways/databases/agents because they are interesting. Add them only when they reduce a measured failure domain, materially improve quality/cost or unlock a necessary capability with acceptable operational burden.

The current target is a small maintainable Personal OS, not a model marketplace.

## Improvement loop

```text
USE → OBSERVE → MEASURE → TEST → IMPROVE
```

Prefer production behavior over architectural aesthetics.

## Next improvement candidates

Only when telemetry justifies them:

- calibrate quality/latency scoring from actual routed traffic
- add provider-quota snapshots if stable APIs become available
- build a small golden-set regression suite for retrieval + Telegram style
- add controlled canary routing when introducing a new model slug
- evaluate personal-sensitive external routing only through an explicit privacy decision

Do not reopen solved historical-ingestion/entity/current-state work unless a regression test fails.
