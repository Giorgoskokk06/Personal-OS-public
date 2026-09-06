# Changelog

## 1.3.2 — 2026-09-06

Privacy-audit completion patch.

- Removed organization-specific career aliases from public retrieval source.
- Added optional `PERSONAL_OS_CAREER_ALIASES` private configuration.
- Passed `PERSONAL_OS_PRIVATE_MARKERS` into the GitHub Actions audit step.
- Added Deno 2-compatible owned `ArrayBuffer` inputs for uploads and SHA-256 hashing.

## 1.3.1 — 2026-09-06

Privacy, validation and automated-verification hardening.

- Removed personal names and organization-specific terms from public source files.
- Moved entity seeds and transcription vocabulary to ignored/private configuration.
- Added shared local schema validation for Gemini and OpenAI-compatible providers.
- Added Node and Deno unit tests, portable syntax checks, public/secret audit and pull-request CI.
- Removed duplicated `.gitignore` entries.

## 1.3.0 — 2026-09-06

Production tri-provider orchestration, provider-contract hardening and Telegram output-quality release.

### Routing

- Gemini, NVIDIA hosted NIM and OpenRouter are peer routes inside one adaptive scorer; there is no permanent Gemini-first path.
- Added target-share balancing (`google:0.40,nvidia:0.40,openrouter:0.20`) instead of blind equal round-robin. Privacy, capability, quota and circuits still outrank balance.
- Bounded request attempts: total 5, Google 2, NVIDIA 2, OpenRouter 1.
- Provider-interleaved fallback prevents one provider from consuming the retry budget first.
- OpenRouter dynamic-router 404 is classified as `provider_no_eligible_endpoint` with a short model-level circuit rather than an auth/provider-wide failure.
- OpenRouter proactive free guard defaults to 50/day with 5 requests reserved.
- `served_model` telemetry is preserved for OpenAI-compatible routes.

### OpenRouter

- Kept exactly one logical route: `openrouter/free`.
- Release verifies the key with `/api/v1/key` without consuming a model request.
- Strict runtime route retains `require_parameters=true`, `data_collection=deny` and `zdr=true`.
- Strict free-router availability is opportunistic; no compliant upstream means fallback to NVIDIA/Gemini, not privacy weakening.
- Any key exposed in chat or another untrusted surface must be rotated before release.

### NVIDIA NIM

- Canonicalized runtime credential to `NVIDIA_NIM_API_KEY`; legacy `NVIDIA_API_KEY` is only a release-time migration alias.
- Replaced prompt-only JSON with native OpenAI-compatible `response_format={"type":"json_object"}` plus strict local schema validation.
- Disabled visible reasoning for structured NIM calls where supported; this avoids reasoning traces consuming the output budget or corrupting JSON.
- Live calibration enables only NVIDIA models that pass the real Greek + JSON contract with the production key.
- Current calibration candidates: Nemotron 3.5 Lightning, DeepSeek V4 Flash 0731, DeepSeek V4 Pro 0813, Nemotron 3 Super, Nemotron 3 Ultra and Kimi K3.
- No fabricated NVIDIA RPD/RPM limit is configured; unknown provider quotas are handled conservatively by reactive circuits.

### Telegram UX

- System prompt explicitly rejects report-like AI output, fake enthusiasm, repetitive headings, Markdown emphasis and generic filler.
- Fast/normal/deep length expectations remain bounded.
- Final normalizer removes accidental presentation noise without a second semantic rewrite.

### Memory / retrieval

- Preserves hardened v1.1 retrieval v4, stable entity graph, historical user-evidence layer and current-state relevance gating.
- No schema reset or destructive migration.

### Release operations

- Self-contained finalizer backs up touched files, validates providers, syncs secrets, audits, deploys, checks health, scans staged changes for credentials, commits, tags `v1.3.0` and pushes without force.

## 1.2.0 — unreleased intermediate

Experimental tri-provider work only. Superseded by v1.3.0; no v1.2 production tag is required.

## 1.1.1-hardened

- Entity-linked canonical memory and relationship reconciliation.
- Historical user-evidence layer and retrieval v4/deep retrieval.
- Current-state relevance gating.
- Multi-model Google routing, persistent model/provider circuits, quota telemetry and routing audits.
