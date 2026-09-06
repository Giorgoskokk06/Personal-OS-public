# Roadmap

This is a proposed backlog, not a list of shipped features. Work on one small item at a time and keep application changes separate from presentation changes.

## Priority order

| Priority | Change | Evidence needed to call it done |
| --- | --- | --- |
| 1 | Mock webhook/provider boundaries | Tests for invalid secret, wrong owner, duplicate event, valid response, timeout and invalid JSON |
| 2 | Specify storage modes | Tests showing what raw content, metadata, records and state changes each mode permits |
| 3 | Review every outbound data path | Policy for transcription, query embeddings, replies, record embeddings and logs, with negative tests |
| 4 | Build a synthetic retrieval evaluation set | At least 20 hand-checked queries covering known facts, corrections, unrelated domains, missing evidence and quarantine |
| 5 | Test memory operations | Duplicate capture, correction, supersession, invalid targets and partial database failures |
| 6 | Improve response-contract validation | Tests for unsupported fields, length/range limits and operation semantics |
| 7 | Make worker recovery explicit | Tests/status transitions for interruption after acceptance and after reply delivery |
| 8 | Measure routing | Reproducible eligible-provider, quota and fallback experiments; actual latency/cost measurements |
| 9 | Package an isolated live demo | Documented setup with a separate bot, synthetic database and explicit credential requirements |

## First small engineering task

Add mocked tests for the webhook secret and owner gate without calling Telegram or Supabase. Explain the boundary, show a failing test, then make it pass. Do not start by adding another provider.

After that, write down the intended meaning of `/nostore`. The current implementation suppresses raw text while other writes can continue. Choose and test a precise contract before changing its name or behavior.

## How to track changes

1. Create a GitHub Issue for one concrete problem.
2. Include observed/desired behavior, evidence, acceptance tests and privacy implications.
3. Make a branch and a focused Pull Request.
4. Keep this file as the priority summary; use Issues for detail.
5. Add measured outcomes to the case study only after the experiment exists.

## Issue template

```text
Problem:
Observed behavior:
Desired behavior:
Relevant files/functions:
Acceptance tests:
Data/privacy implications:
Out of scope:
Evidence required before closing:
```

Do not put private names, credentials, user-content logs or production identifiers in public Issues.

## Not a current priority

A frontend, more providers, multiple autonomous agents and a larger model catalog should wait until existing paths are easier to test and explain. Multi-user support needs a separate authorization and tenant-isolation design.
