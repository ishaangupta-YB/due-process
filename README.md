# DueProcess

> Legal **information and document preparation** for California tenants who have been
> served an eviction lawsuit (unlawful detainer). **Not legal advice. Not a lawyer.**

## Problem

In eviction court the sides are wildly unequal: across the U.S., landlords have a lawyer
in the large majority of cases (commonly reported around **80%**) while only a small
fraction of tenants do (often cited at roughly **3%**). In California, a tenant served
with a Summons + Complaint for unlawful detainer then has a hard, short window to file a
response (an Answer) or lose by **default judgment** — often without ever being heard.

The deadline rules also **changed in 2025**: **AB 2347** amended Code of Civil Procedure
§ 1167 to give tenants **10 court days** to respond (effective 2025-01-01), doubling the
old **5-day** window. Most web pages — and most LLMs trained before the change — still
give the **outdated 5-day answer**. Missing the deadline is the single most common way a
winnable case is lost, so getting this one number right matters.

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

## Demo

A scripted, fully **synthetic** demo set lives in [`demo/`](demo/):

- `demo/ca-summons-sum130.png` — a realistic but invented California SUM-130 summons
  (personal service on 2026-06-08 → the engine computes a 2026-06-23 deadline).
- An **in-corpus** question ("How many days do I have to file my Answer…") → a grounded,
  cited answer giving the current **10 court days**.
- An **out-of-corpus** question ("How do I get my security deposit back…") → the system
  **abstains** and refers the user to legal aid.

See `demo/demo-data.json` for the exact inputs and expected behavior.

## Eval results (real numbers)

We ran the controlled `reglab/housing_qa` RAG eval (`apps/eval`) against the **production
grounding pipeline** (`grounding.ts`) pointed at a separate, throwaway AI Search corpus —
the test DoNotPay never did. **50 California questions, k=5, seed 1234, 0 endpoint
errors.** Full output: `apps/eval/out/metrics.json` + `summary.md`.

| Metric | Value | What it measures |
| --- | --- | --- |
| Citation precision@5 / recall@5 / hit-rate@5 | **0.21 / 0.10 / 0.24** | Did the sources the answer **cited** include the gold statute? (abstentions cite nothing, so they score 0 here) |
| Answer accuracy | **0.65** (11/17 parseable) | yes/no correctness on the items it chose to answer |
| Abstention rate | **0.60** (30/50) | how often it refused rather than guess |
| Abstention on out-of-corpus Qs | **7/10 correct refusals; 0.30 over-answer** | on genuinely unanswerable (held-out) questions, it refused 70% and over-answered 30% |
| Answer coverage | **0.43** | of answerable items, the share it actually answered |

**Honest read:** the pipeline is **deliberately conservative** — it abstains a lot (good
for a legal-safety tool: 70% correct refusal on out-of-corpus questions), trading coverage
for safety, and is ~65% accurate when it does answer. The citation precision/recall look
low partly *because* of that high abstention (refusals contribute zero citations) and
partly because the gold is **2021 multi-state** statute law matched against a small open
embedding model — see the caveats below.

**Caveats (do not over-read these numbers):**
- `reglab/housing_qa` is accurate only **as of 2021** and is **multi-state**. The eval
  measures the grounding pipeline's *faithfulness against a controlled 2021 corpus*, **not**
  the correctness of current California law. (The live product corpus is current CA `.gov`
  sources; scoring it against 2021 gold would be apples-to-oranges, which is why the eval
  uses a separate throwaway corpus.)
- The "retrieval" family scores the **citations in the final answer**, not the raw
  retriever, so the 60% abstention rate mechanically depresses it.
- This run used the configured **fallback** reasoning model (`@cf/openai/gpt-oss-120b`)
  because the primary (`@cf/moonshotai/kimi-k2.6`) returned intermittent capacity errors
  during the eval window. Both are open Workers AI models.
- Numbers come straight from `apps/eval/scoring.py` (pure, unit-tested) — not hand-edited.

### Reproduce the eval

```bash
# 1) index the throwaway eval corpus (needs CF_ACCOUNT_ID / CF_API_TOKEN)
cd apps/eval && uv venv && source .venv/bin/activate && uv pip install -e ".[dev]"
EVAL_AISEARCH_NAMESPACE=dueprocess-eval EVAL_AISEARCH_INSTANCE=dueprocess-housingqa-eval \
PROD_AISEARCH_INSTANCE=dueprocess-prod \
python index_eval_corpus.py --state California --sample-size 50 --holdout-frac 0.2 \
  --distractors-per-state 20 --seed 1234 --no-sync

# 2) start the thin eval endpoint (runs the real grounding.ts on the eval corpus)
cd ../web && MODEL_REASONING=@cf/openai/gpt-oss-120b \
EVAL_AISEARCH_NAMESPACE=dueprocess-eval EVAL_AISEARCH_INSTANCE=dueprocess-housingqa-eval \
PROD_AISEARCH_INSTANCE=dueprocess-prod pnpm dlx tsx scripts/eval-endpoint.ts

# 3) run the eval against it
cd ../eval && GROUNDING_ENDPOINT_URL=http://127.0.0.1:8787/api/answer python run_eval.py --k 5
```

## Disclaimers

DueProcess provides legal **information and document preparation**, not legal advice, and is
**not a lawyer**. It does not represent users or file anything with a court. It can **prepare
a draft and hand you off** to legal aid — it never files your case. Generated documents are
unsigned **drafts** to review with a licensed attorney or legal-aid clinic. California only.
If the system is not confident, it abstains and refers the user to legal aid.

## AI tool usage disclosure

This project was built end-to-end with AI coding assistants (Devin / Anthropic Claude
models) under human direction, and it uses AI at runtime: Cloudflare Workers AI (Llama 4
Scout for notice reading; Kimi K2.6 / gpt-oss-120b for grounded answers and drafting) with
Cloudflare AI Search for retrieval. All legally consequential steps (deadline math,
citation enforcement, form-field mapping) are deterministic code, not model output. The
eval numbers above were produced by the code in `apps/eval`, not written by hand.
