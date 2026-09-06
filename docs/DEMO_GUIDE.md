# Safe demo guide

## Start with the offline demonstration

Run from the repository root:

```bash
node docs/demo/offline-demo.mjs
node --test tests/lib.test.mjs
node scripts/check-syntax.mjs
node scripts/audit-public.mjs
```

The demo imports real local helpers and reads the committed synthetic example. It checks normalization, canonical-key stability and date-sensitive keys. It never loads environment files, calls a provider or database, or writes memory.

This is a code walkthrough, not a recorded conversation or an end-to-end bot test. Make that distinction visible in any video or caption.

## A 75-second walkthrough

| Time | Show | Say, in your own words |
| --- | --- | --- |
| 0–12s | README opening | “Personal OS is my AI-assisted project for keeping useful context across Telegram conversations.” |
| 12–28s | Architecture graphic | “A webhook accepts input, retrieval gathers relevant memory, and a router selects an eligible model. Voice and embeddings have separate cloud paths.” |
| 28–43s | Offline demo output | “These are real helpers with synthetic data. Equivalent records get the same key; changing the date changes an event's key.” |
| 43–57s | Tests and CI definition | “The project has helper and schema checks. I am still adding integration tests and retrieval evaluations.” |
| 57–75s | Case study and roadmap | “I used ChatGPT and Copilot extensively and worked through testing and release. Next I want to prove the failure and privacy paths with tests.” |

Do not replace output with a fabricated terminal screenshot or imply the offline demo called a model.

## Screenshots to capture

1. The README opening with the project name and public repository URL.
2. The architecture image, which contains no live identifiers.
3. Real offline-demo output, cropped to exclude terminal paths and account details.
4. A real passing CI run for the relevant commit, if available.

The [social preview](../assets/social-preview.png) is an illustration for sharing, not a bot screenshot. PNG and SVG alternatives are in the [asset guide](../assets/README.md).

## Optional live demonstration

Only do this after separately configuring and testing an isolated bot and database. Do not use an existing production bot, personal memory, a company account or real personal messages.

Synthetic scenario:

1. Start with `/help` to confirm the test bot can respond.
2. Send `/capture For this demo, my learning goal is to practise SQL joins for 30 minutes this week.`
3. Ask `/deep What learning goal did I mention?`
4. Check the isolated database to see whether a record persisted; a reply alone does not prove it.
5. If demonstrating voice, record only the same synthetic topic.

Do not promise exact wording or guaranteed recall. Record actual behavior and any error. Avoid presenting `/nostore` as “nothing is saved”: it suppresses raw text, not all metadata or memory writes.

Provider calls can consume quota or cost money. This guide does not authorize or automate them.

## Before publishing a recording

- Hide tokens, terminal paths, user IDs, chat names, notifications, database URLs and dashboards.
- Keep sample data obviously synthetic.
- Check audio as well as visible pixels.
- Describe whether the recording is an offline walkthrough or a live test.
- Do not use one successful run as evidence of reliability, privacy guarantees or benchmark performance.
- Preview the final file before uploading it.
