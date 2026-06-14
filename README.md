# DueProcess

> Legal **information and document preparation** for California tenants who have been
> served an eviction lawsuit (unlawful detainer). **Not legal advice. Not a lawyer.**

## Problem

In California, a tenant served with a Summons + Complaint for unlawful detainer has a
hard, short window to file a response (an Answer) or lose by default judgment — often
without ever being heard. The deadline rules changed in 2025, so most web sources (and
most AI models) still give the outdated answer. Missing the deadline is the single most
common way a winnable case is lost.

## What it does

1. **Intake** — the user uploads a photo of their court papers or describes their
   situation (text or voice, in their language); the system extracts the key facts.
2. **Deadline** — deterministic code computes the response deadline from those facts
   (the LLM never computes it).
3. **Grounded Q&A** — answers questions using only cited California legal sources, and
   **abstains** (with a legal-aid referral) when it is not certain.
4. **Draft** — prepares a draft Answer (UD-105) for the user to review and file.
5. **Hand off** — points the user to a real legal-aid clinic; optionally emails a clinic
   and sets a reminder.

## Architecture

```
User → Next.js UI → Next.js API route handlers (backend)
  ├─ intake   → extraction.ts      (multimodal vision) → NoticeFacts
  ├─ deadline → deadline-engine.ts (pure deterministic) → DeadlineResult
  ├─ answer   → grounding.ts       (AI Search retrieve → answer/abstain) → GroundedAnswer
  ├─ document → documents.ts       (draft UD-105 → PDF → R2)
  ├─ case     → db.ts (D1) + Case Durable Object (alarm) + memory.ts (mem0)
  └─ actions  → Composio (email clinic, calendar reminder) [enhancement]
Offline (not deployed): apps/eval (Python + FastAPI) → housing_qa eval → metrics
```

LLMs do perception and synthesis; deterministic code does anything legally consequential
(deadline math, citation enforcement, form mapping). See `CLAUDE.md` for the full contract.

## Stack

- **App:** Next.js (App Router, TypeScript strict) — UI + API route handlers.
- **Deploy:** Cloudflare Workers via OpenNext (`@opennextjs/cloudflare`).
- **RAG:** Cloudflare AI Search. **Models:** Cloudflare Workers AI (open models only).
- **State:** D1 (relational), R2 (uploads + PDFs), Durable Objects (per-case + alarm).
- **Memory:** mem0. **Actions:** Composio. **Offline eval:** Python + FastAPI (`apps/eval`).

## How to run

```bash
pnpm install
pnpm build           # next build (apps/web)
pnpm test            # vitest
pnpm typecheck       # tsc --noEmit
pnpm -C apps/web preview   # OpenNext build + local Workers runtime preview
```

Local bindings/secrets: copy `.dev.vars.example` → `.dev.vars`. Cloudflare resource setup,
secrets, and the parallel-agent workflow are documented in `SETUP_AND_OPS.md`.

## Eval results

_TBD_ — retrieval accuracy, answer accuracy, and abstention rate from the `reglab/housing_qa`
eval (`apps/eval`). Numbers are filled in after the eval run; see `apps/eval/CLAUDE.md`.

## Disclaimers

DueProcess provides legal **information and document preparation**, not legal advice, and is
**not a lawyer**. It does not represent users or file anything with a court. Generated
documents are unsigned **drafts** to review with a licensed attorney or legal-aid clinic.
California only. If the system is not confident, it abstains and refers the user to legal aid.
