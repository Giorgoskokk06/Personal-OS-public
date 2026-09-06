# Personal OS v1.3.2

Personal OS is a private, single-user, Telegram-first memory, retrieval and reasoning system. Supabase Postgres is the operational source of truth; Telegram is the primary interface.

v1.3.2 completes the privacy and verification hardening release for the v1.3 multi-provider architecture. Google Gemini, NVIDIA hosted NIM and OpenRouter are independent inference routes inside one adaptive router. There is no permanent Gemini-first path.

## Architecture

```text
Telegram text / voice
    ↓
Supabase Edge Function
    ↓
webhook validation + owner gate + ingress idempotency + privacy routing
    ↓ immediate ACK / background processing
retrieval planner
    ↓
current_state only when relevant
canonical records + stable entity graph
exact/entity matching + PostgreSQL FTS + pgvector
profile retrieval + bounded historical user-authored evidence
    ↓
adaptive inference router
    ├── Google Gemini direct
    ├── NVIDIA hosted NIM
    └── OpenRouter openrouter/free
    ↓
structured Personal OS response
    ↓
plain Telegram reply + canonical memory operations
    ↓
Supabase Postgres + provenance/history/entities/model telemetry
```

## Memory layers

1. Current State — tiny hot context: season, priorities, bottlenecks, obligations and defer list.
2. Canonical Records — reconciled durable facts, decisions, goals, skills, relationships and projects.
3. Historical Evidence — bounded user-authored evidence with timestamps/provenance for deep retrieval.
4. Quarantine — old assistant/generated material; never automatically treated as user truth.

Canonical memory is not the same thing as full retrievable history. Retrieval v4 combines stable entities, exact/FTS search, vectors, profile diversification and historical evidence without loading whole archives into prompts.

## Adaptive tri-provider routing

For each request, candidate selection considers:

```text
privacy eligibility
→ circuit availability
→ fast / normal / deep / capture fit
→ model capability
→ quota/budget headroom
→ quality + latency profile
→ recent provider share vs target share
→ provider-interleaved bounded fallback
```

Default request attempt budget:

- total: 5
- Google: 2
- NVIDIA: 2
- OpenRouter: 1

The provider-balance target is intentionally not equal round-robin:

```text
Google      0.40
NVIDIA      0.40
OpenRouter  0.20
```

This is a scoring target, not a hard allocation. Privacy, circuits, task fit and quota guards always win. The lower OpenRouter target preserves its small free-tier allowance while still making it a real peer route rather than an emergency-only path.

## OpenRouter policy

The only logical OpenRouter route is:

```text
openrouter/free
```

The free router selects from the current free pool and filters for required capabilities. The Personal OS sends strict provider preferences when it uses this route:

```text
allow_fallbacks=true
require_parameters=true
data_collection=deny
zdr=true
```

Because the free pool changes dynamically, a strict request may occasionally return 404 when no currently free upstream satisfies all capability/privacy requirements. That is treated as a short `provider_no_eligible_endpoint` circuit and the request falls through to NVIDIA/Gemini. It is not treated as an authentication failure.

Current free-tier guard:

```text
OPENROUTER_DAILY_LIMIT=50
OPENROUTER_QUOTA_RESERVE_REQUESTS=5
MODEL_OPENROUTER_MAX_ATTEMPTS=1
```

The account/key is verified through `/api/v1/key` during release without consuming a model call. Do not repeatedly preflight `openrouter/free`: failed free-model requests still consume the account request allowance.

Any OpenRouter key that has ever been pasted into chat, a ticket, a commit or another untrusted surface must be rotated before production use.

## NVIDIA hosted NIM policy

Runtime uses the canonical secret name:

```text
NVIDIA_NIM_API_KEY
```

`NVIDIA_API_KEY` is accepted only as a local migration alias by the release script; the script normalizes the final configuration to `NVIDIA_NIM_API_KEY` so stale aliases cannot silently win.

Current hosted candidates verified against NVIDIA Build on 2026-09-06:

| Model | Intended role |
|---|---|
| `nvidia/nemotron-3.5-lightning-30b-a3b` | fast / capture / normal |
| `deepseek-ai/deepseek-v4-flash-0731` | fast / normal / deep |
| `deepseek-ai/deepseek-v4-pro-0813` | normal / deep |
| `nvidia/nemotron-3-super-120b-a12b` | normal / deep |
| `nvidia/nemotron-3-ultra-550b-a55b` | deep |
| `moonshotai/kimi-k3` | normal / deep |

The release script live-tests every candidate using the production key and enables only models that pass the real Greek + structured-JSON contract. A model that is currently unavailable, rate-limited or contract-incompatible is simply left out of `NVIDIA_NIM_ENABLED_MODELS`.

### Structured output rule

NVIDIA Nemotron 3.5 Lightning documents OpenAI-compatible JSON mode:

```json
{"response_format":{"type":"json_object"}}
```

For Personal OS structured calls, visible model thinking is disabled where the model exposes a supported switch. The returned JSON is then validated locally against the full Personal OS schema. We do not regex-repair malformed canonical-write output.

This fixes the failure mode observed during v1.3 testing where Lightning returned HTTP 200 but prompt-only JSON contained a literal newline inside a string and therefore failed `JSON.parse()`.

## Privacy routing

Privacy classification happens before provider scoring.

- Google direct: `personal_safe`, `personal_sensitive`, `work_safe`
- NVIDIA hosted NIM: `personal_safe`, `work_safe` by default
- OpenRouter: `personal_safe`, `work_safe` by default
- `work_confidential` and `restricted`: never sent through the normal Personal OS inference path

Defaults remain:

```text
OPENROUTER_ALLOW_PERSONAL_SENSITIVE=false
NVIDIA_NIM_ALLOW_PERSONAL_SENSITIVE=false
```

Do not weaken these automatically to improve availability.

## Telegram output contract

Telegram should sound like a useful person, not a generated report.

Default response style:

- answer first; no generic intro
- natural Greek when the user writes in Greek
- no Markdown bold/italics/headings/decorative separators
- no fake enthusiasm, sycophancy or motivational filler
- no restatement of the user's question
- cohesive paragraphs; at most one short list when genuinely useful
- no narration of retrieval/model choice/internal reasoning
- `/fast`: usually <=120 words
- normal/capture: usually <=300 words
- `/deep`: usually <=700 words unless more depth is actually useful

A deterministic final normalizer removes accidental emphasis/headings and a small set of standalone filler openers. It is a presentation guard, not a second semantic rewriting pass.

## Retrieval behavior

The retrieval planner can combine:

- exact/entity matching
- entity-linked canonical records
- PostgreSQL full-text search
- pgvector semantic similarity
- diversified profile retrieval
- historical user evidence
- temporal/current reconciliation

Current State is context, not a topic mandate. Narrow dating, family, health or casual questions should not receive unrelated career/current-state contamination.

## Telegram commands

```text
/deep <message>     deeper retrieval + reasoning
/fast <message>     latency-oriented route
/capture <message>  concise answer + durable extraction when appropriate
/nostore <message>  process without raw-message persistence
/state               show hot current state
/help                show commands
```

Voice notes are transcribed and handled through the same retrieval/reasoning path.

## Important routing environment variables

See `.dev.vars.example` for the full set. Core v1.3 controls:

```text
MODEL_MAX_ROUTE_ATTEMPTS=5
MODEL_GOOGLE_MAX_ATTEMPTS=2
MODEL_NVIDIA_MAX_ATTEMPTS=2
MODEL_OPENROUTER_MAX_ATTEMPTS=1
MODEL_PROVIDER_BALANCE_ENABLED=true
MODEL_PROVIDER_BALANCE_WINDOW=15
MODEL_PROVIDER_BALANCE_WEIGHT=16
MODEL_PROVIDER_ROTATION_BONUS=6
MODEL_PROVIDER_TARGET_WEIGHTS=google:0.40,nvidia:0.40,openrouter:0.20
MODEL_PROACTIVE_QUOTA_ROUTING=true

OPENROUTER_DAILY_LIMIT=50
OPENROUTER_QUOTA_RESERVE_REQUESTS=5

NVIDIA_NIM_ENABLED_MODELS=<comma-separated live-calibrated models>
```

Known Gemini quotas should be configured only when verified from the actual account/dashboard. Unknown quota is not unlimited quota; reactive circuits remain active when proactive limits are unknown.

## Diagnostics

```bash
npm run check:os
npm run audit:memory
npm run audit:routing
npm run provider:catalog

# OpenRouter auth only; does not consume a model call
npm run preflight:providers -- --provider=openrouter --auth-only

# NVIDIA real structured contract
npm run preflight:providers -- --provider=nvidia --model=nvidia/nemotron-3.5-lightning-30b-a3b
```

`audit:routing` shows configured models, circuits, actual provider share vs target share, fallback successes and `served_model` for OpenAI-compatible providers when available.

## Tests and public-repository audit

```bash
npm test
npm run check:syntax
npm run audit:public
```

CI runs these checks and validates the Edge Function TypeScript on every pull request. The audit blocks committed secret files and scans known credential formats. Configure `PERSONAL_OS_PRIVATE_MARKERS` locally or as a repository secret when additional private terms must be rejected.

Personal names and organization-specific vocabulary do not belong in public source code. Optional private configuration belongs in ignored files:

```text
imports/private/entities.json
GEMINI_TRANSCRIPTION_VOCABULARY=<comma-separated private terms>
PERSONAL_OS_AUDIT_TERMS=<comma-separated private audit terms>
PERSONAL_OS_CAREER_ALIASES=<comma-separated private career terms>
PERSONAL_OS_PRIVATE_MARKERS=<comma-separated terms forbidden in tracked files>
```

## Safe deployment rule

Production contains real memory. Never use `supabase db reset --linked`, destructive truncation, bulk deletion or force-push as part of a normal upgrade.

v1.3.2 requires no database migration. It reuses the hardened v1.1 memory/routing tables.

## Current release

Version: **1.3.2**

Release scope:

- removed personal names and organization-specific terms from public source files
- moved transcription vocabulary and entity seeds to optional private configuration
- shared runtime schema validation across Gemini and OpenAI-compatible providers
- automated unit tests, syntax checks, secret/public audit and GitHub Actions CI
- cleaned duplicated ignore rules
- adaptive Gemini ↔ NVIDIA ↔ OpenRouter orchestration with no hard Gemini default
- quota-aware target-share balancing instead of blind round-robin
- OpenRouter auth validation + dynamic 404/no-route fallback semantics
- canonical NVIDIA credential handling
- live NVIDIA structured-contract calibration using native JSON mode
- model/provider circuits and bounded attempts
- served-model telemetry
- stronger anti-slop Telegram output contract
- refreshed README, CHANGELOG and canonical improvement instructions
- safe release automation with backup, secret scan, commit/tag and non-force push
