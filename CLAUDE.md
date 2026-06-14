# CLAUDE.md — DueProcess

> This file is the single source of truth for every agent working in this repo.
> Read it fully before writing any code. If anything here conflicts with your
> own assumptions, THIS FILE WINS. If something you need is not defined here,
> STOP and ask the human — do not invent it.

---

## 0. What this project is (one paragraph, memorize it)

DueProcess is an AI tool that helps a California tenant who has been served an
eviction lawsuit (an "unlawful detainer") understand what is happening and act
before the legal deadline. The user uploads a photo of their court papers or
describes their situation (by text or voice, in their language). The system:
(1) extracts the key facts from the notice, (2) computes the hard deadline to
respond using deterministic code, (3) answers their questions about their rights
using only grounded, cited California legal sources — and refuses to answer when
it is not certain, (4) drafts the official Answer form for them to review and
file, and (5) hands them off to a real legal-aid clinic. It is a hackathon
project for "AI × Social Good" (Equity & Justice track). It is NOT a lawyer and
must never present itself as one.

---

## 1. NON-NEGOTIABLE INVARIANTS (legal safety — never violate, in any file)

These are the core of the product and the core of the grade. Any code that
breaks one of these is wrong even if it "works."

1. **Not a lawyer, ever.** The UI and every generated text must state this is
   legal *information and document preparation*, not legal advice, and direct
   the user to a licensed attorney / legal-aid clinic. Never claim to "represent"
   the user or to "file" anything with a court.

2. **Cite or abstain. No ungrounded legal claims.** Every substantive legal
   statement returned to the user MUST be backed by a citation to a retrieved
   source (statute, official court self-help page, or official form). If
   retrieval confidence is low, the question is outside the indexed corpus, or
   the sources conflict, the system MUST return `status: "abstained"` with a
   referral to legal aid. It must NOT guess. Showing the system correctly
   refuse is a demo feature, not a failure.

3. **The LLM never computes the deadline.** The response deadline is computed in
   `lib/deadline-engine.ts` by deterministic code from extracted facts. The LLM's
   only job around deadlines is to extract the service date and service method
   from the notice. Never let model output set a date the user relies on.

4. **No fabricated identifiers.** Never invent statute numbers, court-form codes
   (e.g. UD-105, SUM-130), case citations, deadlines, URLs, model IDs, or API
   signatures. If you don't have the real value, read the pinned docs (§9) or
   STOP and ask.

5. **Generated documents are DRAFTS.** Any generated court document is an
   unsigned draft watermarked "DRAFT — review before filing." The system never
   submits to a court e-filing system. "Action" = draft + email to a clinic +
   set a reminder. Nothing more.

6. **Minimize sensitive data.** Tenant situation data is sensitive. Store the
   minimum needed. Never log full notice contents or PII to stdout.

---

## 2. The eviction-law facts the product depends on (verified)

Use these exactly. Do not "improve" them from training memory — training data on
this is frequently outdated (see the deliberate-error note below).

- Jurisdiction: **California** only (corpus and logic are CA-specific).
- After being served a Summons (SUM-130) + Complaint (UD-100), the tenant files
  an **Answer (form UD-105)** to avoid a default judgment.
- **Response deadline (current law): 10 COURT days** after personal service of
  the Summons & Complaint. This is per **CCP § 1167 as amended by AB 2347,
  effective 2025-01-01**, which doubled the old 5-court-day window.
  - "Court days" exclude Saturdays, Sundays, and California court holidays.
  - The clock starts **the day AFTER** service, not the day of service.
  - For **non-personal service** (substituted service, or post-and-mail under
    CCP § 1162), additional time applies — the engine adds extra days AND raises
    an uncertainty flag telling the user to confirm with the court.
- If the tenant does not respond by the deadline, the landlord can take a
  **default judgment** and the tenant loses without a hearing. Missing the
  deadline is the single most common way a winnable case is lost.

**Deliberate-error awareness (this is our headline pitch):** Many web sources,
and likely your training data, still say the deadline is "5 days." That is
OUTDATED for California as of 2025-01-01. The whole point of grounding to current
.gov sources is to NOT repeat that stale answer. The deadline engine encodes 10
court days; the grounded-answer corpus uses current California Courts self-help
text. If you ever find yourself about to output "5 days," stop — you are
hallucinating from stale memory.

---

## 3. Architecture (high level)

```
User → Next.js UI → Next.js API route handlers (the backend)
                        ├─ intake     → extraction.ts   (Llama 4 Scout, multimodal) → NoticeFacts
                        ├─ deadline   → deadline-engine.ts (PURE deterministic code) → DeadlineResult
                        ├─ answer     → grounding.ts     (AI Search retrieve → reason/abstain) → GroundedAnswer
                        ├─ document   → documents.ts     (draft UD-105 → PDF → R2)
                        ├─ case       → db.ts (D1) + Case Durable Object (alarm) + memory.ts (mem0)
                        └─ actions    → Composio (email clinic, calendar)  [enhancement]
Offline (NOT deployed):  apps/eval (Python + FastAPI) → housing_qa eval → metrics
```

**Perception vs. computation split (important):** LLMs do perception and
synthesis (read the notice, draft prose, synthesize cited answers). Deterministic
code does anything legally consequential and checkable (deadline math, citation
enforcement, form field mapping). This split is a safety property — preserve it.

---

## 4. Tech stack (fixed — do not substitute without asking)

- **Frontend + backend: one Next.js app** (App Router). UI in `app/`, backend in
  `app/api/**/route.ts` route handlers. No separate Node server.
- **Deploy target: Cloudflare Workers via OpenNext** (`@opennextjs/cloudflare`).
  Access bindings through `getCloudflareContext()`. Verify adapter usage against
  the pinned OpenNext docs (§9) — do not guess the import path.
- **RAG: Cloudflare AI Search** (formerly AutoRAG) — hybrid semantic + BM25.
  Index the CA corpus; query via the AI Search binding. Verify the current
  binding name and query API against the pinned docs (§9) before coding `ai-search.ts`.
- **Models: Cloudflare Workers AI (open-source models only).** All model IDs live
  ONLY in `lib/models.ts`. See §5.
- **State:** D1 (relational: cases, deadlines, documents, Q&A history),
  R2 (uploaded notice images, generated PDFs), Durable Objects (per-case state +
  deadline reminder alarm).
- **Memory: mem0** (managed/platform — the human has premium). Wrapped in
  `lib/memory.ts`. See §6.
- **Actions: Composio** (send email to a legal-aid clinic, create a calendar
  reminder). Enhancement tier. Wrapped in `lib/actions.ts`.
- **Offline eval: Python 3.11 + FastAPI** in `apps/eval/` (its own CLAUDE.md).
  Loads `reglab/housing_qa`, runs the RAG eval against the deployed API, reports
  metrics. Never deployed to Workers.
- **Orchestration: direct Workers AI calls, NOT the Cloudflare Agents SDK.** The
  flow is a fixed, auditable pipeline (extract → compute → retrieve → answer/abstain
  → draft). Determinism is a SAFETY feature for a legal tool — we do not want the
  system improvising its own steps. Stateful/proactive behavior (the deadline
  reminder) uses a Durable Object alarm. We use Cloudflare's agent *primitives*
  (AI Search for retrieval, DO for state) plus model tool-calling and Composio for
  actions — enough to be a genuinely agentic system without the SDK's extra surface.
- **Repo & deploy: single monorepo, ONE deployed app.** `apps/web` is the only
  thing deployed (Cloudflare Workers via OpenNext, connected to GitHub through
  Workers Builds). `apps/eval` (Python) lives in the same repo but never deploys.
  Full setup, dashboard steps, and the parallel-agent workflow are in
  `SETUP_AND_OPS.md`.

---

## 5. Model configuration — the ONLY place model IDs may appear

Create `apps/web/lib/models.ts` as the single source of truth. Every model call
imports from here. **Agents must NOT hardcode a `@cf/...` slug anywhere else, and
must NOT invent slugs.** The human will fill/confirm the exact strings against
the Workers AI model catalog (§9) before the run. Use this shape:

```ts
// lib/models.ts — slugs CONFIRMED against developers.cloudflare.com/workers-ai/models (re-confirm only the K2.7 upgrade).
export const MODELS = {
  // Multimodal vision: read the eviction notice image -> structured facts. CONFIRMED.
  VISION: process.env.MODEL_VISION ?? "@cf/meta/llama-4-scout-17b-16e-instruct",
  // High-reasoning grounded answers + document drafting. CONFIRMED (vision + structured outputs).
  // Upgrade to "@cf/moonshotai/kimi-k2.7" ONLY after confirming a NON-code k2.7 slug exists.
  // "@cf/moonshotai/kimi-k2.7-code" is a coding-tuned variant — do NOT use it for legal prose.
  REASONING: process.env.MODEL_REASONING ?? "@cf/moonshotai/kimi-k2.6",
  // Fallback reasoning (TEXT-ONLY; gpt-oss accepts Chat Completions `messages` and Responses API). CONFIRMED.
  REASONING_FALLBACK: process.env.MODEL_REASONING_FALLBACK ?? "@cf/openai/gpt-oss-120b",
  // Speech-to-text (enhancement). Whisper = transcription. CONFIRMED.
  STT: process.env.MODEL_STT ?? "@cf/openai/whisper",
  // Better multilingual ASR (Hindi, Spanish, etc.) for voice intake. CONFIRMED.
  STT_MULTILINGUAL: process.env.MODEL_STT_MULTI ?? "@cf/deepgram/nova-3",
  // Translation (enhancement). CONFIRMED.
  TRANSLATE: process.env.MODEL_TRANSLATE ?? "@cf/meta/m2m100-1.2b",
} as const;

// OPTIONAL external vision fallback via Nebius AI Studio (user has ~$26 credit). Use ONLY if
// Workers AI multimodal input proves finicky. Routed outside the `AI` binding via NEBIUS_API_KEY.
// Confirm the exact Nebius vision model id (e.g. a Qwen-VL) before wiring; do not assume.
export const NEBIUS_VISION_FALLBACK = process.env.NEBIUS_VISION_MODEL ?? null;
```

Rules:
- If a slug here is wrong, the fix happens in THIS file only.
- Vision input format differs across Workers AI models (some take `image: number[]` bytes,
  newer ones take Chat-Completions `image_url` content parts). READ the llama-4-scout model
  page before coding `extraction.ts`; do not assume the shape.
- Any agent that needs a model it cannot find here: STOP and ask. Do not add one.
- Generation calls that produce legal content MUST request structured output and
  low temperature. Never stream ungrounded legal text token-by-token to the user.

---

## 6. mem0 integration (required)

`lib/memory.ts` wraps mem0. Purpose: a case is a longitudinal relationship, not a
one-shot chat. Persist and recall case context across sessions so the tool behaves
like an ongoing caseworker.

Store, scoped by `user_id = caseId`:
- **Facts:** notice type, service date, service method, parties, stated reason.
- **The computed deadline** and which assumptions produced it.
- **Q&A history:** what the user asked and what was answered/abstained.
- **Documents generated** and their R2 keys.

Expose a thin interface (confirm exact method names against docs.mem0.ai — §9 —
do not assume):
```ts
addCaseMemory(caseId: string, items: MemoryItem[]): Promise<void>
recallCaseMemory(caseId: string, query: string): Promise<MemoryItem[]>
getAllCaseMemory(caseId: string): Promise<MemoryItem[]>
```
Never store raw images or full PII blobs in mem0 — store structured facts only.
mem0 API key is a secret (`MEM0_API_KEY`), never committed.

---

## 7. The contract — shared types (canonical; agents import, never redefine)

Create `apps/web/lib/types.ts` with exactly these. Other modules import from here.
Do not duplicate or fork these shapes.

```ts
export type ServiceMethod = "personal" | "substituted" | "posted_mail" | "unknown";

export interface NoticeFacts {
  noticeType: string;            // e.g. "Summons + Complaint (Unlawful Detainer)"
  serviceDateISO: string | null; // date served, ISO yyyy-mm-dd; null if not found
  serviceMethod: ServiceMethod;
  jurisdiction: "CA";
  parties: { landlord?: string; tenant?: string };
  statedReason: string | null;   // e.g. "nonpayment of rent"
  extractionConfidence: number;  // 0..1 from the extraction step
  unreadableFields: string[];    // fields the model could not read confidently
}

export interface DeadlineResult {
  responseDeadlineISO: string | null; // computed date, or null if inputs insufficient
  courtDaysUsed: number;               // 10 for personal service
  serviceMethod: ServiceMethod;
  assumptions: string[];               // human-readable assumptions made
  mustVerify: true;                    // ALWAYS true — user must confirm with court
  holidayCalendarVersion: string;      // e.g. "CA-courts-2026"
}

export interface Citation {
  sourceId: string;
  sourceTitle: string;
  url: string;       // must be a real indexed source URL, never fabricated
  snippet: string;   // <= 25 words, paraphrase-safe excerpt
}

export interface GroundedAnswer {
  status: "answered" | "abstained";
  answerMarkdown?: string;     // present only when status === "answered"
  citations: Citation[];       // >= 1 required when answered; [] when abstained
  abstainReason?: string;      // present only when status === "abstained"
  referral: { text: string; url: string }; // legal-aid handoff — ALWAYS present
}

export interface QAEntry { questionText: string; result: GroundedAnswer; atISO: string; }

export interface CaseRecord {
  id: string;
  createdAtISO: string;
  language: string;            // BCP-47, e.g. "en", "es"
  noticeFacts: NoticeFacts | null;
  deadline: DeadlineResult | null;
  qaHistory: QAEntry[];
  documentKeys: string[];      // R2 keys of generated drafts
}
```

---

## 8. API surface (route handler contracts — honor exactly)

All under `apps/web/app/api/`. JSON in/out unless noted. All responses include
`{ ok: boolean, error?: string }`.

- `POST /api/intake` — body: image (base64 or multipart) and/or `text`, `language`.
  Returns `{ ok, noticeFacts: NoticeFacts }`. Calls `extraction.ts`.
- `POST /api/deadline` — body: `{ serviceDateISO, serviceMethod }`.
  Returns `{ ok, deadline: DeadlineResult }`. Calls `deadline-engine.ts`. No LLM.
- `POST /api/answer` — body: `{ caseId, questionText, language }`.
  Returns `{ ok, answer: GroundedAnswer }`. Calls `grounding.ts`.
- `POST /api/document` — body: `{ caseId }`.
  Returns `{ ok, r2Key, downloadUrl }`. Calls `documents.ts`.
- `POST /api/case` / `GET /api/case?id=` — case CRUD via `db.ts` + Case DO + mem0.
- `POST /api/actions/email-clinic` and `/api/actions/reminder` — Composio. Enhancement.

---

## 9. Pinned reference docs (READ these; do not trust memory for these APIs)

Before writing code that touches an external API, fetch and follow the relevant doc.
- Workers AI models + slugs: https://developers.cloudflare.com/workers-ai/models/
- Workers AI usage / bindings: https://developers.cloudflare.com/workers-ai/
- AI Search (RAG): https://developers.cloudflare.com/ai-search/
- D1: https://developers.cloudflare.com/d1/
- R2: https://developers.cloudflare.com/r2/
- Durable Objects + alarms: https://developers.cloudflare.com/durable-objects/
- OpenNext Cloudflare adapter: https://opennext.js.org/cloudflare
- mem0: https://docs.mem0.ai/
- Composio: https://docs.composio.dev/
- Dataset (eval): https://huggingface.co/datasets/reglab/housing_qa

If a doc contradicts this file on an API detail, follow the doc and flag the
conflict to the human. If a doc contradicts this file on PRODUCT behavior or the
legal invariants (§1), this file wins.

---

## 10. Directory layout

```
dueprocess/
  CLAUDE.md                      # this file
  README.md
  corpus/                        # CA .gov source texts (committed): statutes, forms, self-help
  apps/
    web/                         # Next.js app (frontend + API) — deployed to CF via OpenNext
      app/                       # routes + UI
        api/.../route.ts
      lib/
        types.ts                 # the contract (§7) — canonical
        models.ts                # model IDs (§5) — canonical
        ai-search.ts             # retrieval wrapper
        extraction.ts            # multimodal notice -> NoticeFacts
        deadline-engine.ts       # PURE deterministic deadline calc + CA holidays
        grounding.ts             # retrieve -> answer/abstain + citation enforcement
        documents.ts             # UD-105 Answer draft -> PDF
        memory.ts                # mem0 wrapper
        db.ts                    # D1 access
        actions.ts               # Composio (enhancement)
      durable-objects/case-do.ts
      wrangler.jsonc
      open-next.config.ts
    eval/                        # Python + FastAPI (offline only) — own CLAUDE.md
  scripts/upload-corpus.ts
```

---

## 11. Conventions & engineering rules (all agents)

- TypeScript strict mode. No `any` in exported signatures. Validate all external
  input (use zod) before use.
- Each `lib/*` module is independently importable and unit-testable. Pure logic
  (deadline engine, citation enforcement) has unit tests; these are mandatory for
  the deadline engine.
- Small commits, conventional messages. **All commits must be net-new code dated
  inside the hackathon window — never copy from a pre-existing repo.**
- Secrets via env/Wrangler secrets only: `MEM0_API_KEY`, `COMPOSIO_API_KEY`, any
  model gateway keys. Never commit secrets. Never log secrets or PII.
- Do not add dependencies not needed by your module. Do not upgrade shared deps.
- **Stay in your lane:** only edit files your prompt assigns you. If you need a
  change in a shared file (`types.ts`, `models.ts`, schema), STOP and ask — do not
  edit it unilaterally.
- **When unsure, STOP and ask the human. Never fabricate to keep moving.**

---

## 12. Build priority (if time runs short, cut from the bottom — never the top)

CORE (must work, in this order):
1. Intake (image) → `NoticeFacts` extraction.
2. Deterministic deadline + countdown (the hero feature).
3. Grounded Q&A with citations + working abstention on an out-of-scope question.
4. Generated UD-105 Answer draft (download).

ENHANCEMENTS (only after CORE is solid):
5. Durable Object deadline reminder alarm.
6. mem0 cross-session case memory surfaced in the UI.
7. Voice + multilingual intake.
8. Composio email-to-clinic + calendar reminder.

PROOF (do not skip — it is the grade):
9. Run the `housing_qa` eval; record retrieval accuracy, answer accuracy, and
   abstention rate. Put the numbers in the README and the pitch.
