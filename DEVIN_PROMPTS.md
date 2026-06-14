# DEVIN_PROMPTS.md — parallel build prompts for DueProcess

How to use this file:
- Each block below is ONE self-contained task to hand to a Devin/Claude Code agent.
- **Run waves strictly in order.** Within a wave, prompts marked "parallel-safe"
  can run concurrently. **Merge and verify the whole wave before starting the next.**
- Every prompt assumes the agent will first read the root `CLAUDE.md` (and, for the
  eval task, `apps/eval/CLAUDE.md`). That is stated in each prompt — do not remove it.
- The guardrail block at the end of each prompt is load-bearing. Keep it.
- Before Wave 1, the human verifies the model slugs in `lib/models.ts` against the
  Workers AI catalog and confirms the Kimi K2.7 slug.

Global guardrails (apply to EVERY task; repeated in each prompt for safety):
- Read `CLAUDE.md` first. It wins over your assumptions.
- Edit ONLY the files your task assigns. Need a shared-file change? STOP and ask.
- Never invent identifiers: statute numbers, form codes, URLs, model slugs, API
  signatures, SDK method names. Read the pinned docs in `CLAUDE.md §9` or STOP and ask.
- Honor the legal invariants in `CLAUDE.md §1`. Cite-or-abstain; LLM never computes
  deadlines; not a lawyer; drafts only.
- All code is net-new, written now. Never copy a pre-existing codebase.
- When unsure, STOP and ask the human. Do not fabricate to keep moving.

================================================================================
# WAVE 0 — Contracts & scaffold  (ONE agent, blocking. Merge before Wave 1.)
================================================================================

## P0 — Repo scaffold + the contract (NOT parallel; everything depends on this)

You are setting up the foundation that every other agent will build against.
Read the root `CLAUDE.md` completely before doing anything.

Goal: produce a deployable-empty Next.js app on Cloudflare with all bindings,
the canonical shared types, the central model config, the D1 schema, and stub
modules with correct signatures — so parallel agents can build without colliding.

Do exactly this:
1. Scaffold a Next.js (App Router, TypeScript strict) app at `apps/web/`.
2. Add the Cloudflare OpenNext adapter (`@opennextjs/cloudflare`). Follow
   https://opennext.js.org/cloudflare — do not guess imports. Make `pnpm build`
   and a local `wrangler`/OpenNext preview run with an empty home page.
3. Create `apps/web/wrangler.jsonc` with bindings declared (names exactly):
   - D1: `DB`
   - R2: `DOCS_BUCKET`
   - Workers AI: `AI`
   - AI Search: binding for the production namespace (confirm the current binding
     shape against https://developers.cloudflare.com/ai-search/ — if it differs
     from what you expect, follow the docs and note it).
   - Durable Object: `CASE_DO` (class `CaseDO`, stubbed).
   Leave secrets (`MEM0_API_KEY`, `COMPOSIO_API_KEY`) as documented placeholders.
4. Create `apps/web/lib/types.ts` with the EXACT types from `CLAUDE.md §7`. This
   is canonical; do not add or rename fields.
5. Create `apps/web/lib/models.ts` with the EXACT shape from `CLAUDE.md §5`,
   reading slugs from env with the documented defaults. Add a one-line comment on
   each slug: "VERIFY against Workers AI catalog."
6. Create the D1 schema migration `apps/web/migrations/0001_init.sql` for:
   `cases` (id, created_at, language, notice_facts_json, deadline_json),
   `qa_history` (id, case_id, question, result_json, at),
   `documents` (id, case_id, r2_key, created_at). Foreign keys on `case_id`.
7. Create STUB files (correct exported signatures, bodies `throw new Error("not
   implemented")`) so imports resolve: `lib/ai-search.ts`, `lib/extraction.ts`,
   `lib/deadline-engine.ts`, `lib/grounding.ts`, `lib/documents.ts`,
   `lib/memory.ts`, `lib/db.ts`, `lib/actions.ts`, `durable-objects/case-do.ts`.
   Each stub's signatures must match the contracts in `CLAUDE.md §6/§7/§8`.
8. Create stub route handlers under `app/api/` matching `CLAUDE.md §8`, each
   returning `501 not implemented`.
9. Add zod, set up a test runner (vitest), add one trivial passing test.
10. Write a top-level `README.md` skeleton (sections: problem, what it does,
    architecture, stack, how to run, eval results [TBD], disclaimers).

Acceptance criteria:
- `pnpm install && pnpm build` succeeds; preview serves an empty page.
- `pnpm test` passes.
- All imports resolve; `tsc --noEmit` is clean.
- No business logic implemented yet — only contracts, config, schema, stubs.

GUARDRAILS: (global guardrails above). Additionally: this task DEFINES the shared
files (`types.ts`, `models.ts`, schema). Get them right; later agents may not
change them. If a Cloudflare API detail differs from `CLAUDE.md`, follow the docs
and leave a `// NOTE:` comment + tell the human.

================================================================================
# WAVE 1 — Independent modules  (4 agents, parallel-safe. Merge wave before Wave 2.)
================================================================================

## P1-A — Corpus ingestion + AI Search index  (parallel-safe)

Read root `CLAUDE.md` first. You own: `corpus/`, `scripts/upload-corpus.ts`,
`apps/web/lib/ai-search.ts`. Touch nothing else.

Goal: build the California legal corpus and make it queryable via Cloudflare AI
Search, then implement the retrieval wrapper the answer pipeline will use.

Do this:
1. Assemble `corpus/` from CURRENT California official sources only. Fetch and
   save clean text (with source URL + title metadata per file) for:
   - California Courts self-help eviction pages (selfhelp.courts.ca.gov/eviction-tenant/*):
     respond/Answer, summons & complaint, deadlines, defenses, fee waivers.
   - Statutory text: CCP §§ 1167, 1162, 1170.5 (current, post-AB 2347).
   - Official form descriptions/instructions: UD-100, UD-105, SUM-130.
   Each file: front-matter with `title`, `url`, `retrieved_at`. Plain text/markdown.
   Do NOT paraphrase or "summarize" the law into the corpus — store source text so
   answers cite real sources. If a page can't be fetched, list it in
   `corpus/MISSING.md` and continue; do not invent content.
2. Set up a Cloudflare AI Search instance/namespace for production and index the
   corpus. Follow https://developers.cloudflare.com/ai-search/ for the current
   ingestion method (direct upload vs. R2 vs. crawl). Attach the source metadata
   so retrieval can return real `url` + `title` for citations.
3. Implement `lib/ai-search.ts`:
   ```ts
   export interface RetrievedChunk { sourceId:string; title:string; url:string; snippet:string; score:number; }
   export async function retrieve(query: string, k?: number): Promise<RetrievedChunk[]>;
   ```
   Use hybrid search. Return real source URLs/titles from metadata — never synthesize.

Acceptance criteria:
- `corpus/` contains the sources above with correct metadata, no invented text.
- A test query like "how many days to respond to an eviction in California" returns
  chunks whose text contains the current 10-court-day rule, with a real .gov URL.
- `retrieve()` returns typed `RetrievedChunk[]` with populated `url` and `title`.

GUARDRAILS: (global). The corpus is the ground truth for legal accuracy — if you
can't fetch a real source, do NOT write the law from memory. Leave it missing and
flag it.

## P1-B — Deterministic deadline engine  (parallel-safe; pure, no network, no LLM)

Read root `CLAUDE.md` first (esp. §1.3, §2). You own ONLY:
`apps/web/lib/deadline-engine.ts` and its test file. No network, no model calls.

Goal: compute the California unlawful-detainer response deadline from facts,
deterministically, with a CA court-holiday calendar. This is high-stakes; it is
tested thoroughly.

Implement:
```ts
import { DeadlineResult, ServiceMethod } from "./types";
export function computeResponseDeadline(input: {
  serviceDateISO: string;       // date served
  serviceMethod: ServiceMethod;
}): DeadlineResult;
```
Rules to encode (from `CLAUDE.md §2`):
- Personal service: **10 court days**, counting starts the DAY AFTER service,
  excluding Saturdays, Sundays, and California court holidays.
- Non-personal service (`substituted`, `posted_mail`): compute the personal-service
  date, then add extra time AND push `assumptions` + keep `mustVerify: true`.
  (Encode a clearly-commented extra-days value; mark it "VERIFY against CCP
  §1162/§1167" — do not present it as certain.)
- `unknown`/missing service date or method → `responseDeadlineISO: null` with an
  assumption explaining what's missing. Never guess a date.
- `mustVerify` is ALWAYS `true`. Always include a plain-language assumption like
  "Confirm this date with the court or a self-help center."
- Include a CA court-holiday table for the current + next year as a clearly-marked
  constant (`HOLIDAYS_CA` with `holidayCalendarVersion`). If a date is outside the
  table's coverage, add an assumption flagging reduced confidence.

Tests (mandatory, in the same PR): personal service on a Monday with no holidays;
service adjacent to a weekend; service the week of a known CA holiday; substituted
service; missing date; missing method. Assert exact ISO output dates.

Acceptance criteria:
- Pure function, no imports beyond `./types` and a date lib if needed.
- All listed test cases pass with explicit expected dates.
- Never returns a non-null deadline without `mustVerify: true` and ≥1 assumption.

GUARDRAILS: (global). This module must NEVER call an LLM or network. If the legal
counting rule is ambiguous to you, encode the conservative version, mark it
"VERIFY", and tell the human — do not silently pick a rule.

## P1-C — Multimodal notice extraction  (parallel-safe)

Read root `CLAUDE.md` first (esp. §1.3, §5, §7). You own ONLY:
`apps/web/lib/extraction.ts` and its test.

Goal: turn an uploaded eviction-notice image (and/or text) into `NoticeFacts`.

Implement:
```ts
import { NoticeFacts } from "./types";
export async function extractNoticeFacts(input: {
  imageBase64?: string; text?: string; language?: string;
}): Promise<NoticeFacts>;
```
- Use the VISION model from `lib/models.ts` (do NOT hardcode a slug).
- Request STRICT structured output matching `NoticeFacts`. Low temperature.
- The model extracts ONLY observable facts: notice type, service date, service
  method, parties, stated reason. It must NOT infer legal conclusions or compute
  deadlines (that's P1-B's job downstream).
- Populate `extractionConfidence` and list any fields it could not read in
  `unreadableFields`. If the service date is unreadable, set `serviceDateISO: null`
  — never guess a date.
- Validate the model output with zod against `NoticeFacts` before returning; on
  invalid output, return a low-confidence result with the failure noted, not a
  fabricated one.

Acceptance criteria:
- Given a sample summons image, returns valid `NoticeFacts` with a plausible
  `serviceDateISO` or `null` + the field listed in `unreadableFields`.
- Output always passes zod validation; never throws raw model text to the caller.

GUARDRAILS: (global). Extraction is perception only. No legal advice, no deadline
math, no invented dates/parties. Verify the model-call API against the Workers AI
docs (§9).

## P1-D — Python eval harness + FastAPI  (parallel-safe; separate subproject)

Read root `CLAUDE.md` AND `apps/eval/CLAUDE.md` first. You own ONLY `apps/eval/`.
Do not import from or modify `apps/web`.

Goal: build the offline evaluation that produces the project's credibility metric
on the `reglab/housing_qa` dataset, per the controlled-eval design in
`apps/eval/CLAUDE.md`.

Do this:
1. `pyproject.toml` (py3.11): `datasets`, `httpx`, `pandas`, `fastapi`, `uvicorn`,
   `pytest`.
2. `dataset.py`: load `reglab/housing_qa` (`questions`, `questions_aux`,
   `statutes`), cache to `data/`, with filter/sample helpers.
3. `index_eval_corpus.py`: push the `statutes` subset into a SEPARATE eval AI
   Search namespace (never production). Follow the AI Search docs.
4. `scoring.py` (pure, unit-tested): retrieval precision@k / recall@k vs gold
   statute citations; answer accuracy for `answered` items; abstention rate and
   abstention-correctness.
5. `run_eval.py`: for each sampled question, call the deployed grounding endpoint
   (URL from env), collect `GroundedAnswer`, score, write `out/metrics.json` and a
   human-readable `out/summary.md` (must state the 2021 dataset limitation and
   cite RegLab).
6. `api.py` (FastAPI): `POST /dataset/prepare`, `POST /eval/run`, `GET /eval/metrics`.

Acceptance criteria:
- `scoring.py` unit tests pass on synthetic inputs.
- `run_eval.py` produces `out/metrics.json` with the three metric families.
- Nothing here is deployable to Workers; it only calls the API over HTTP.

GUARDRAILS: (global). Never fabricate metrics or expected numbers. Never point at
the production namespace. Report real results, including bad ones.

================================================================================
# WAVE 2 — Dependent modules  (3 agents, parallel-safe. Merge before Wave 3.)
================================================================================

## P2-E — Grounded answer + abstention pipeline  (depends on P1-A)

Read root `CLAUDE.md` first (esp. §1.1, §1.2). You own ONLY:
`apps/web/lib/grounding.ts`, `app/api/answer/route.ts`, and their tests.
Import `retrieve()` from `lib/ai-search.ts` (P1-A) and the REASONING model from
`lib/models.ts`. Do not modify those files.

Goal: implement cite-or-abstain. This is the safety heart of the product.

Implement:
```ts
import { GroundedAnswer } from "./types";
export async function answerQuestion(input: {
  questionText: string; language?: string; priorContext?: string;
}): Promise<GroundedAnswer>;
```
Pipeline:
1. `retrieve()` top-k chunks.
2. If the best score is below a configurable threshold, OR no chunk is topically
   relevant → return `status:"abstained"` with `abstainReason` + the legal-aid
   `referral`. Do not call the model to "try anyway."
3. Otherwise, call the REASONING model with a STRICT system prompt:
   - Answer ONLY from the provided chunks. If the chunks don't contain the answer,
     say so and abstain — do not use outside/training knowledge.
   - Every claim must map to a provided chunk; return citations referencing the
     chunk `url`/`title`. Snippets ≤ 25 words.
   - Plain language; reply in the user's `language`.
   - Append the not-a-lawyer + see-legal-aid note. (Set `referral` always.)
4. Post-validate: if the model returned a legal claim with no citation, DOWNGRADE
   to `abstained` rather than show an uncited claim. Enforce in code, not trust.
5. Never fabricate a citation URL — citations must come from retrieved chunks.

Tests (mandatory): an in-corpus question returns `answered` with ≥1 real citation;
an out-of-corpus question (e.g. "can I get a divorce?") returns `abstained`; a
model response stripped of citations is forced to `abstained` by the validator.

Acceptance criteria: the three tests pass; the route returns `GroundedAnswer`;
no path can return an uncited `answered`.

GUARDRAILS: (global). The abstention path is a feature — make it robust and easy
to trigger in a demo. Citation enforcement is done in code, never by trusting the
model. Verify the model-call API against the docs (§9).

## P2-F — UD-105 Answer draft generation  (depends on P1-A, contract from P0)

Read root `CLAUDE.md` first (esp. §1.5). You own ONLY:
`apps/web/lib/documents.ts`, `app/api/document/route.ts`, and tests.

Goal: generate a DRAFT California UD-105 "Answer — Unlawful Detainer" for the user
to review and file. Draft only — never filed by us.

Implement:
```ts
export async function generateAnswerDraft(input: {
  caseId: string;
}): Promise<{ r2Key: string; downloadUrl: string }>;
```
- Pull case `NoticeFacts` (via `db.ts`/case fetch — read-only) to fill defendant,
  property, case-caption fields where known; leave unknowns clearly blank/marked.
- Use the REASONING model ONLY to phrase any free-text defenses in plain language,
  grounded in retrieved corpus chunks about common defenses — every suggested
  defense must be tied to a real source and clearly labeled "potential defense to
  discuss with a legal-aid attorney," not asserted as applicable.
- Render to PDF. Stamp a visible watermark on every page: "DRAFT — NOT FILED —
  review with a legal-aid clinic before filing." Store in R2 (`DOCS_BUCKET`),
  return the key + a download URL.
- Do NOT reproduce the official court form's copyrighted layout; generate a clean
  plain-language draft document that maps to the UD-105 fields and tells the user
  to transcribe onto the official Judicial Council form. (If unsure about form
  reproduction, STOP and ask — default to a plain-language draft + instructions.)

Tests: given a case with partial facts, produces a PDF in R2 with the watermark
and no fabricated field values (unknowns are blank/labeled).

Acceptance criteria: returns a valid R2 key + working download URL; watermark
present; unknowns not fabricated.

GUARDRAILS: (global). Drafts only, watermarked. No invented case numbers, dates,
or defenses. Defenses are "discuss with an attorney," never legal conclusions.

## P2-G — Case persistence: D1 + Durable Object alarm + mem0  (depends on P0)

Read root `CLAUDE.md` first (esp. §6). You own ONLY: `apps/web/lib/db.ts`,
`apps/web/lib/memory.ts`, `apps/web/durable-objects/case-do.ts`,
`app/api/case/route.ts`, and tests.

Goal: persist a case, remember it across sessions (mem0), and fire a reminder
before the deadline (Durable Object alarm).

Implement:
1. `db.ts`: typed CRUD over D1 for `cases`, `qa_history`, `documents` per the
   schema. Validate with zod.
2. `memory.ts`: the mem0 wrapper per `CLAUDE.md §6`. Verify exact mem0 client
   methods against https://docs.mem0.ai — do not assume signatures. Store
   structured facts only (no images/PII blobs). Key by `caseId`.
3. `case-do.ts` (`CaseDO`): holds per-case state; when a deadline is set, schedule
   an `alarm()` for a sensible lead time before `responseDeadlineISO` (e.g. 2 days
   prior, but never in the past); on alarm, mark a reminder as due (and, if
   enabled, trigger the Composio reminder via P3-I — but do not hard-depend on it).
4. `app/api/case/route.ts`: create/fetch a case, wiring D1 + mem0 + DO together.

Tests: create→fetch round-trips through D1; mem0 wrapper add/recall works against
a mock; DO schedules an alarm in the future and never in the past.

Acceptance criteria: case CRUD works; mem0 recall returns stored facts; DO alarm
scheduling is correct and guarded against past times.

GUARDRAILS: (global). Verify mem0 + DO alarm APIs against docs (§9). Store minimal
data. Never log PII. Do not hard-couple to Composio.

================================================================================
# WAVE 3 — Integration  (1–2 agents; H mostly serial, I/J after H.)
================================================================================

## P3-H — Frontend flow (the demo path)  (depends on all Wave 1–2 routes)

Read root `CLAUDE.md` first (esp. §12 priority). You own the `app/` UI (pages and
components) and may wire to the existing API routes. Do not change `lib/*`
signatures or the contracts.

Goal: one clean, accessible flow that nails the four CORE features for the demo:
1. Upload a notice photo (or paste/speak text) → show extracted `NoticeFacts`.
2. Show the computed deadline as a prominent COUNTDOWN, with the assumptions and
   the "confirm with the court" note visible.
3. A chat box for rights questions → render the grounded answer WITH visible
   inline citations (clickable to the real .gov source); render abstentions clearly
   ("I'm not sure — here's a legal-aid clinic").
4. A "Generate my draft Answer" button → produce + download the watermarked PDF.

Design rules: prioritize ACCESSIBILITY over flourish — large readable type, high
contrast, plain language, mobile-first, works in the user's language. Persistent
footer disclaimer: not legal advice / not a lawyer / drafts only. Keep it calm and
non-alarming (the user is in a stressful situation).

Acceptance criteria: a person can complete the full CORE path end-to-end in the
browser; abstention and citations are visibly demonstrable; the countdown is the
visual hero.

GUARDRAILS: (global). Don't over-build UI. The four CORE features working flawlessly
beats a fancy half-broken UI. Disclaimers always visible.

## P3-I — Enhancements: Composio actions + voice/multilingual  (after P3-H; cuttable)

Read root `CLAUDE.md` first. You own `apps/web/lib/actions.ts`,
`app/api/actions/*`, and the voice/STT bits of intake. Do not change contracts.

Goal (only if CORE is solid — these are cuttable):
- `actions.ts` via Composio: `emailClinic(caseId, clinicEmail)` (sends a summary +
  the draft link) and `createReminder(caseId, whenISO)` (calendar event). Verify
  Composio APIs against https://docs.composio.dev. Require explicit user consent
  in the UI before sending anything on their behalf.
- Voice intake: STT via the STT model in `lib/models.ts`; multilingual input/output
  end-to-end (the answer pipeline already takes `language`).

Acceptance criteria: with consent, a real email/calendar action fires; a spoken,
non-English intake produces correct `NoticeFacts` and a same-language answer.

GUARDRAILS: (global). Never send email/calendar actions without explicit user
consent. These are enhancements — if they're flaky near the deadline, disable them
cleanly; never let them break the CORE path.

## P3-J — End-to-end pass, eval run, README + Devpost copy  (last)

Read root `CLAUDE.md` first. Goal: make it demo-proof and write the proof.
1. Walk the full CORE path; fix breakages (coordinate via the human for any
   shared-file change). Add a scripted demo dataset: one realistic CA summons image
   + one in-corpus question + one out-of-corpus question (to show abstention).
2. Run the Wave-1-D eval against the deployed grounding endpoint; capture
   `out/metrics.json`. Put the real numbers (retrieval accuracy, answer accuracy,
   abstention rate) into `README.md` and a `DEVPOST.md` (≤500-word project
   description) — include the 3%-vs-80% representation gap, the AB 2347 10-day
   deadline + the stale-5-day contrast, the architecture, and the honest
   limitations (CA-only, drafts only, not legal advice, 2021 eval-dataset caveat).
3. Disclose AI-tool usage per the hackathon rules.

Acceptance criteria: CORE path runs clean start-to-finish; README + DEVPOST carry
REAL eval numbers; disclaimers and AI-use disclosure present.

GUARDRAILS: (global). Do not fabricate metrics or capabilities in the writeup.
Claim "prepare + hand off," never "files your case." Honesty about limits is part
of the grade.