# SETUP_AND_OPS.md — DueProcess

Final answers to the structural questions, plus the exact checklists to run before
and during the build. Read `CLAUDE.md` first; this file is operations only.

---

## 1. Monorepo? Yes — one repo, one deployed app

**Decision: single Git monorepo, single deployment.** Not two repos.

- One GitHub repo. Layout:
  ```
  dueprocess/
    CLAUDE.md              # canonical context
    SETUP_AND_OPS.md       # this file
    DEVIN_PROMPTS.md       # the build prompts
    package.json           # pnpm workspace root
    pnpm-workspace.yaml     # workspaces: ["apps/*"]
    corpus/                # CA .gov source texts (committed)
    apps/
      web/                 # Next.js (frontend + API). THE ONLY DEPLOYED UNIT.
      eval/                # Python + FastAPI. Dev-time only. Never deployed.
    scripts/
  ```
- **Why monorepo, not two repos:** one context file, one Git history (matters for
  the "all code written during the window" rule — easy to show), and the eval is
  loosely coupled (it calls the deployed API over HTTP, doesn't import the app).
  Two repos would buy you nothing here and double the bookkeeping near a deadline.
- **Why it's still "single deployment":** only `apps/web` ships to Cloudflare.
  `apps/eval` is Python you run locally; Cloudflare never sees it. So there is
  exactly one build artifact and one deploy target.
- **pnpm workspaces, not Turborepo.** With one JS app, Turborepo's caching/orchestration
  earns nothing. Keep it light. (`apps/eval` is Python and sits outside the JS
  workspace graph entirely.)

---

## 2. Cloudflare Agents SDK? No — call the LLMs directly

**Decision: direct Workers AI calls + Durable Objects + AI Search. No Agents SDK.**

Reasoning:
- Our flow is a fixed, auditable pipeline (extract → compute deadline → retrieve →
  answer/abstain → draft). The Agents SDK is for open-ended, self-directing,
  long-horizon agents. We deliberately do NOT want a legal tool improvising its own
  control flow — determinism is a safety property and a Q&A talking point.
- Adding the SDK = more abstraction + learning curve + failure surface near the
  deadline, for zero rubric points. The grade rewards the working pipeline,
  grounding, abstention, and the eval number — not the framework.
- The "agentic" qualities judges value, we already have without the SDK:
  tool-calling models (Kimi/gpt-oss support tool calls), mem0 memory, Composio
  actions, and a Durable Object alarm that *proactively* watches the deadline.
- We DO use Cloudflare's agent **primitives** — AI Search (retrieval) and Durable
  Objects (state) — so "built on Cloudflare's agent platform" is honestly true.

If a judge asks "is this an agent?": yes — it perceives (vision), retrieves (AI
Search), reasons with tools, remembers (mem0), and acts (Composio + scheduled
reminders). It just doesn't need a heavyweight framework to do it.

---

## 3. Confirmed model slugs (verified against the live catalog)

Put these in `apps/web/lib/models.ts` (already specified in CLAUDE.md §5).

| Role | Slug | Status / notes |
|---|---|---|
| Vision (notice extraction) | `@cf/meta/llama-4-scout-17b-16e-instruct` | Confirmed. Natively multimodal. **Verify image input shape on the model page before coding.** |
| Reasoning (answers + drafting) | `@cf/moonshotai/kimi-k2.6` | Confirmed. 1T MoE, vision + tool calling + structured outputs. |
| Reasoning upgrade | `@cf/moonshotai/kimi-k2.7` | Only if a NON-code k2.7 slug is confirmed. `…/kimi-k2.7-code` exists but is coding-tuned — don't use it for legal prose. |
| Reasoning fallback | `@cf/openai/gpt-oss-120b` | Confirmed. TEXT-ONLY. Accepts Chat Completions `messages` and Responses API. |
| STT (voice) | `@cf/openai/whisper` | Confirmed. Enhancement tier. |
| STT multilingual | `@cf/deepgram/nova-3` | Confirmed. Better for Hindi/Spanish/etc. than Whisper. |
| Translate | `@cf/meta/m2m100-1.2b` | Confirmed. Enhancement tier. |
| Vision fallback (external) | Nebius AI Studio (e.g. a Qwen-VL) | Optional, ~$26 credit. Use only if Workers AI vision is finicky. Confirm exact id. |

Verification checklist (do this once, by hand, before Wave 1):
1. Open `https://developers.cloudflare.com/workers-ai/models/` and confirm each
   slug above still resolves to a live model page.
2. Open the `llama-4-scout-17b-16e-instruct` page (append `index.md` for clean
   markdown) and note the **exact image input format** — paste it into the P1-C
   prompt so the extraction agent uses the right shape.
3. Check whether a non-code `@cf/moonshotai/kimi-k2.7` exists. If yes, set
   `MODEL_REASONING` to it; if not, stay on `kimi-k2.6`.
4. Decide STT: ship Whisper for the demo unless you're doing multilingual voice,
   then use Nova-3.

---

## 4. Cloudflare setup (via the dashboard, as you wanted)

Create these in the Cloudflare dashboard (or note them; some are easier via
`wrangler`). All binding NAMES must match `wrangler.jsonc` exactly.

1. **Workers AI** — nothing to create; the `AI` binding is enabled by adding it in
   `wrangler.jsonc`. (Costs come from your account credit.)
2. **D1 database** — create one (e.g. `dueprocess`); bind as `DB`. Run the
   `migrations/0001_init.sql` against it (`wrangler d1 migrations apply`).
3. **R2 bucket** — create one (e.g. `dueprocess-docs`); bind as `DOCS_BUCKET`.
4. **AI Search** — create a production instance/namespace; index `corpus/`
   (direct upload, or point it at the .gov pages to crawl — follow the AI Search
   docs). Create a SEPARATE `*-eval` namespace for the eval harness; never mix them.
5. **Durable Objects** — declared in `wrangler.jsonc` (class `CaseDO`, binding
   `CASE_DO`) with a migration; created on first deploy.
6. **Secrets** (Worker settings → never in Git): `MEM0_API_KEY`, `COMPOSIO_API_KEY`,
   and (if used) `NEBIUS_API_KEY`. Set with `wrangler secret put` or in the dashboard.

### Deploy: GitHub → Cloudflare Workers Builds
- Push the monorepo to GitHub.
- In the dashboard: **Workers & Pages → create → connect to Git → select the repo**,
  and set the **root directory to `apps/web`** (so the monorepo's Python dir is
  ignored). Build command runs the OpenNext build; Workers Builds deploys on every
  push to the production branch and per-PR previews.
- **The #1 OpenNext deploy gotcha — env vars:** Cloudflare Worker runtime variables
  are NOT available at Next.js *build* time. Any var Next.js needs during build must
  be provided as a Workers Builds *build* variable (or be a public `NEXT_PUBLIC_*`),
  separately from runtime secrets. Many OpenNext deploys fail because a build-time
  var was only set in runtime settings. Keep build-time vs runtime vars straight.
- Use the **Node.js runtime**, not Edge. Before deploying, remove any
  `export const runtime = "edge"` from route/page files (OpenNext uses Node compat).
- Run `cf-typegen` to generate `cloudflare-env.d.ts` so binding types are correct.
- Local dev: `initOpenNextCloudflareForDev()` in `next.config.ts` exposes local
  bindings; `pnpm preview` runs the app in the real Workers runtime before you push.

---

## 5. Parallel agents: tmux + git worktrees + Devin CLI (Mac)

The rule that prevents chaos: **one agent per git worktree, one tmux pane per agent.
Never run two agents in the same working directory.** Worktrees give each agent its
own checkout of a different branch off the same repo, so parallel edits can't clobber
each other; you merge branches between waves.

Setup once:
```bash
# from the repo root, after Wave 0 (P0) is committed to main
git switch main && git pull
mkdir -p ../dp-trees
```

Per parallel task (example for Wave 1's four tasks):
```bash
for t in p1a-corpus p1b-deadline p1c-extraction p1d-eval; do
  git worktree add ../dp-trees/$t -b $t main
done
```
Then in tmux, one pane per worktree:
```bash
tmux new -s dueprocess
# Ctrl-b "  (split) ... or create windows; in each pane:
cd ../dp-trees/p1a-corpus && devin   # paste the P1-A prompt
# pane 2: cd ../dp-trees/p1b-deadline && devin  -> paste P1-B
# pane 3: cd ../dp-trees/p1c-extraction && devin -> paste P1-C
# pane 4: cd ../dp-trees/p1d-eval && devin       -> paste P1-D
```
Between waves:
```bash
# review each branch, then merge into main in dependency order
git switch main
git merge --no-ff p1b-deadline   # pure module, merge first
git merge --no-ff p1a-corpus
git merge --no-ff p1c-extraction
git merge --no-ff p1d-eval
# resolve any conflicts (should be near-zero if agents stayed in their lanes)
git worktree remove ../dp-trees/p1b-deadline   # clean up after merge
```

Discipline that makes this work:
- **Do not start a wave until the previous wave is merged into `main`.** Each new
  worktree branches from the updated `main`, so Wave 2 agents see Wave 1's code.
- Each prompt already says "edit ONLY your files; STOP and ask before touching a
  shared file." That is what keeps merges trivial. The only shared files
  (`types.ts`, `models.ts`, schema) are frozen in P0 and changed only by you.
- Wave 0 (P0) and Wave 3 integration (P3-H/J) run in a SINGLE worktree/pane — they
  are not parallel.
- Keep `CLAUDE.md` at the repo root; every worktree inherits it, so every agent
  loads the same context. Context stays king across all panes.

Parallelism map:
- Wave 0: 1 pane (P0). Merge.
- Wave 1: 4 panes (P1-A/B/C/D) in parallel. Merge.
- Wave 2: 3 panes (P2-E/F/G) in parallel. Merge.
- Wave 3: 1–2 panes (P3-H, then P3-I/J). Merge. Deploy.

---

## 6. P0 expected output — sanity-check the foundation before fanning out

After P0, before you create any Wave 1 worktree, verify the tree looks like this and
the gates pass. If P0 produced extra business logic or changed these contracts,
send it back — do not build on a bad foundation.

```
dueprocess/
  package.json                 # pnpm workspace root
  pnpm-workspace.yaml
  CLAUDE.md  SETUP_AND_OPS.md  DEVIN_PROMPTS.md
  corpus/                      # (may be empty until P1-A)
  scripts/
  apps/
    web/
      package.json
      next.config.ts           # has initOpenNextCloudflareForDev()
      open-next.config.ts
      wrangler.jsonc           # bindings: DB (D1), DOCS_BUCKET (R2), AI, AI Search, CASE_DO (DO)
      migrations/0001_init.sql # cases, qa_history, documents (+ FKs)
      vitest.config.ts
      app/
        page.tsx               # empty placeholder home
        api/
          intake/route.ts      # 501
          deadline/route.ts    # 501
          answer/route.ts      # 501
          document/route.ts    # 501
          case/route.ts        # 501
          actions/email-clinic/route.ts   # 501
          actions/reminder/route.ts       # 501
      lib/
        types.ts               # EXACT contract from CLAUDE.md §7
        models.ts              # EXACT config from CLAUDE.md §5 (confirmed slugs)
        ai-search.ts           # stub: retrieve() throws "not implemented"
        extraction.ts          # stub
        deadline-engine.ts     # stub
        grounding.ts           # stub
        documents.ts           # stub
        memory.ts              # stub
        db.ts                  # stub
        actions.ts             # stub
      durable-objects/
        case-do.ts             # stub CaseDO class, alarm() stub
      __tests__/
        smoke.test.ts          # one trivial passing test
    eval/
      CLAUDE.md                # (already provided)
```

Gates that must pass on P0:
- `pnpm install && pnpm -C apps/web build` succeeds; `pnpm -C apps/web preview`
  serves an empty page in the Workers runtime.
- `pnpm -C apps/web exec tsc --noEmit` is clean; `pnpm -C apps/web test` passes.
- `types.ts` and `models.ts` match CLAUDE.md exactly (no added/renamed fields, the
  confirmed slugs present).
- Every `lib/*` and route is a stub — NO real logic yet.
- `wrangler.jsonc` binding names exactly: `DB`, `DOCS_BUCKET`, `AI`, the AI Search
  binding, `CASE_DO`.

If all gates pass, freeze `main` and start Wave 1.

---

## 7. One-line reminders that protect the grade

- Cite-or-abstain and the deterministic deadline are not optional polish — they are
  the pitch. Don't let any agent "simplify" them out under time pressure.
- Run the eval (P1-D + P3-J). The measured number is what makes the trust claim real.
- "Prepare + hand off," never "files your case." CA-only, drafts only, not legal advice.
