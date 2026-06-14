# DueProcess — Agent Handoff

> Purpose: hand a fresh agent the **full working context** to continue Wave 3.
> Canonical status always lives in `TASKS.md`; this file is the narrative + the
> "what to do next" map. When in doubt, trust `CLAUDE.md` (product invariants)
> and `SETUP_AND_OPS.md` (ops) over this file.

Last updated: 2026-06-14 (after infra unblock + P3-I/P3-J launched).

---

## 0. TL;DR — read this first

- **Product:** an AI tool that helps California tenants understand + respond to an
  eviction (unlawful-detainer) lawsuit: extract facts from the notice/summons,
  compute the response **deadline deterministically**, answer questions with
  **cited .gov sources or abstain**, draft a **watermarked UD-105 Answer**, and
  refer to legal aid. It gives **legal information, not legal advice.**
- **Repo:** `/Users/ishaan/Desktop/projs/Projs/MERNProjs/steminate-hackathon/due-process`
  (corpus `ishaangupta-YB/due-process`).
- **Where we are:** Waves 0/1/2/3 **all merged into `main`** (not yet pushed).
  Wave 3 = P3-H frontend, P3-I enhancements (Composio + voice/multilingual),
  P3-J eval/README/demo-proofing. `tsc` clean, **92/92 web tests**; P3-J reports
  35 eval tests + real eval metrics.
- **Infra is unblocked:** AI Search corpus uploaded + indexing; D1 migrated.
- **Immediate next action:** push `main` (ahead, unpushed); clean up the
  `p3i`/`p3j` worktrees + the `dueprocess-w3` tmux session; then deploy + run the
  live spot-check + full eval (needs a deployed endpoint).

---

## 1. Architecture (monorepo)

Single Git monorepo, pnpm workspaces, pnpm pinned to **11.5.1** (`packageManager`).

- `apps/web` — **Next.js (App Router)** deployed to **Cloudflare Workers via
  OpenNext** (`@opennextjs/cloudflare`). All bindings accessed through
  `getCloudflareContext()`. This is the product.
- `apps/eval` — **Python** offline RAG-evaluation harness. **Never deployed**,
  never imports `apps/web`. Calls the deployed grounding endpoint over HTTP +
  the AI Search REST API for a throwaway eval corpus.
- `corpus/` — the CA `.gov` source docs (13 markdown files) indexed into AI Search.
- `scripts/` — worktree setup + tmux launch scripts per wave, plus
  `upload-corpus.ts` (AI Search uploader).

### Cloudflare bindings (in `apps/web/wrangler.jsonc` — DO NOT edit casually)
- **Workers AI** — perception (vision/STT), reasoning, drafting. Open models only.
- **AI Search** (formerly AutoRAG) — RAG for grounded answers.
- **D1** (`DB`, database `dueprocess`, id `51a3a697-340c-4c42-8db2-dc9c90365b6c`) —
  cases / qa_history / documents.
- **R2** (`DOCS_BUCKET`) — generated PDFs + uploaded images.
- **Durable Object** `CaseDO` (binding `CASE_DO`) — per-case state + deadline
  reminder alarms.

---

## 2. Non-negotiable invariants (from CLAUDE.md — never violate)

1. **Deadlines are deterministic code, never an LLM.** `lib/deadline-engine.ts`
   computes the response deadline (CA UD: personal service = +5 calendar days,
   non-personal handled conservatively). LLMs may *read* facts but never *compute*
   the date.
2. **Cite-or-abstain.** Every legal claim in a grounded answer must carry a real
   `.gov` citation rebuilt **in code** from retrieved chunks; on zero citations or
   low retrieval confidence the pipeline **abstains** with a distinct UI. The model
   returns source numbers only — it cannot fabricate URLs.
3. **Safety bias.** When service type / dates are ambiguous, bias to the
   **earliest** (safer) deadline. Show the `VERIFY_NOTE`.
4. **Not-a-lawyer.** Persistent footer disclaimer; every drafted document is
   **watermarked** "DRAFT - NOT FILED..."; the tool never claims to file anything.
5. **Lane discipline.** Each parallel agent edits only its assigned files. **Never
   change shared contracts:** `lib/types.ts`, `lib/models.ts`, `migrations/`,
   `wrangler.jsonc`, `worker.ts`. Changing these breaks every other lane's merge.

---

## 3. AI Search namespaces (verified — common confusion)

| Purpose | Namespace | Instance | Where defined |
| --- | --- | --- | --- |
| **Production** (the product) | `dueprocess-ca` | `dueprocess-prod` | `scripts/upload-corpus.ts`, `apps/web/lib/ai-search.ts` |
| **Eval** (throwaway) | `eval` (default) | `dueprocess-housingqa-eval` (default) | `apps/eval/config.py` env `EVAL_AISEARCH_NAMESPACE` / `EVAL_AISEARCH_INSTANCE` |

- There is **no `dueprocess-eval` namespace.** `dueprocess-eval` is the **Python
  package name** in `apps/eval/pyproject.toml`. Do not confuse it with AI Search.
- **Critical for the eval safety guard:** when running the eval, set
  `PROD_AISEARCH_NAMESPACE=dueprocess-ca` and `PROD_AISEARCH_INSTANCE=dueprocess-prod`
  so `config.assert_not_production` can actually refuse to touch production.
  (The unit test in `apps/eval/tests/test_config.py` uses placeholder prod values;
  the real denylist comes from env.)

---

## 4. Infra status (as of 2026-06-14)

- **AI Search — DONE:** `scripts/upload-corpus.ts` created instance `dueprocess-prod`
  in namespace `dueprocess-ca`, set the custom_metadata schema, and uploaded all
  **13 corpus files** (queued for indexing). **Verify indexing finished** in the
  dashboard (AI → AI Search → `dueprocess-prod`) before trusting grounded answers.
  Spot-check: *"how many days to respond to an eviction in California"* should
  return the 10-day rule with a real `.gov` URL.
- **D1 — DONE:** `0001_init.sql` applied to remote `dueprocess` (5 commands ✅):
  `cases`, `qa_history`, `documents`.
- **Secrets:** `MEM0_API_KEY` reported set in the CF dashboard by the user.
  `COMPOSIO_API_KEY` (+ optional `COMPOSIO_USER_ID`, `COMPOSIO_CONNECTED_ACCOUNT_ID`)
  still needed for **live** P3-I actions. Optional `NEBIUS_API_KEY` for vision fallback.
- **Local creds:** real values live in `.dev.vars` / `.dev.vars.local` (both
  **gitignored**). `.dev.vars.example` is the committed template (empty values).
  For local `pnpm preview` the worker reads `apps/web/.dev.vars` — copy with
  `cp .dev.vars apps/web/.dev.vars`.

> ⚠️ **SECURITY:** an earlier `cfut_…` Cloudflare token and the `m0-…` mem0 key were
> pasted into chat and must be **rotated/revoked**. The current working CF token can stay.

---

## 5. Wave / branch status

Waves 0, 1, 2: **done, merged, pushed** (origin/main at `2c04d56`).
- Wave 1: P1-A corpus+AI Search, P1-B deadline engine, P1-C extraction, P1-D eval harness.
- Wave 2: P2-E grounding/abstention, P2-F UD-105 draft (`pdf-lib`), P2-G persistence (D1 + CaseDO + mem0).

Wave 3 (current) — fully merged; `main` is **ahead of origin (UNPUSHED)**:

| Task | Branch / worktree | Status |
| --- | --- | --- |
| **P3-H** frontend demo flow | `p3h-frontend` (merged `3bf4029`, worktree removed) | **MERGED.** In-lane (`app/` only), `api/deadline` thin pass-through, no contract change. tsc clean, 77/77 tests, `next build` OK. |
| **P3-I** enhancements | merged `755fc32` (branch `p3i-enhancements` `497690e`) | **MERGED.** Composio actions (`lib/actions.ts` + `app/api/actions/*` + `ActionsStep.tsx`) + voice/multilingual STT (`lib/stt.ts` + intake route + `IntakeStep.tsx`). No shared-contract changes. 92/92 tests. Live actions need `COMPOSIO_API_KEY` + connected Gmail/Calendar. |
| **P3-J** eval + README + Devpost + demo-proofing | merged `1767636` (branch `p3j-eval-readme` `eed6d89`) | **MERGED.** Demo-proofed CORE path on real models; `demo/` dataset; real controlled eval (answer 0.65 / abstention 0.60 / citation hit@5 0.24, caveated); README + DEVPOST. Uses thin `apps/web/scripts/eval-endpoint.ts` (not the product path). | 

Recent main commits (newest first): `1767636` merge p3j, `755fc32` merge p3i,
`452686f` docs (AI Search indexed + D1 migrated), `366aa28` docs, `65bac58`
next.config dev-init guard, `3bf4029` merge p3h, `03492a6` wave3 scripts.

---

## 6. Parallel-agent workflow (how merges happen)

- Each task = its own **git worktree** under `../dp-trees/<branch>` (sibling of the
  repo), created + **git-locked** off `main`. Scripts:
  `scripts/setup-worktrees-wave3.sh <branch...>` (creates+locks) and
  `scripts/launch-wave3.sh <branch...>` (one tmux window, one labeled pane per
  agent running `devin --model <slug> --permission-mode auto`; prompts pasted manually
  from `DEVIN_PROMPTS.md`).
- **The reviewing agent (you) usually CANNOT read `../dp-trees` directly** (macOS TCC
  "Operation not permitted"). Review a branch with `git show <branch>:<path>` from the
  main repo **after the user commits the worktree.** That is why uncommitted worktree
  work can't be reviewed yet.
- **Merge flow:** user commits the worktree (`git -C ../dp-trees/<b> add apps/web && git commit -m "..."`)
  → you `git merge --no-ff <b> -m "<minimal msg>"` → run `pnpm -C apps/web exec tsc --noEmit`
  + `pnpm -C apps/web exec vitest run` → update `TASKS.md` → commit.
- **Cleanup after merge** (worktrees are **locked**, so `--force` alone fails — use
  double-force or unlock first):
  ```bash
  git worktree remove -f -f ../dp-trees/<branch>
  git branch -d <branch>
  tmux kill-session -t dueprocess-w3 2>/dev/null
  ```
- **Commit messages must be minimal** (user requirement). No co-author/footer noise.

---

## 7. Remaining tasks (what's left)

**Code / merge**
1. ~~Commit + review + merge P3-I~~ **DONE** (`755fc32`). No shared-contract changes; 92/92 tests.
2. ~~Merge P3-J~~ **DONE** (`1767636`). Add/add conflict on `.devin/config.local.json` was resolved by untracking it + gitignoring `.devin/` (machine-local Devin tooling — never commit it again).
3. **Push `main`** (ahead, unpushed): `git push`.
4. **Worktree + tmux cleanup** (section 6): `git worktree remove -f -f ../dp-trees/p3i-enhancements ../dp-trees/p3j-eval-readme && git branch -d p3i-enhancements p3j-eval-readme && git worktree prune && tmux kill-session -t dueprocess-w3`.

**Runtime / verification**
5. **Confirm AI Search indexing completed** + run the spot-check query (section 4).
6. **Deploy `apps/web`** to Cloudflare Workers (OpenNext) so there's a live
   `GROUNDING_ENDPOINT_URL` for the eval + a demo URL.
7. **Set prod secrets** in CF dashboard: confirm `MEM0_API_KEY`; add
   `COMPOSIO_API_KEY` (+ optional `COMPOSIO_USER_ID`, `COMPOSIO_CONNECTED_ACCOUNT_ID`);
   **connect Gmail + Google Calendar in the Composio dashboard** for live actions.
8. **Run the controlled eval** (`apps/eval`) — see section 8. Produces
   `out/metrics.json` + `out/summary.md`. Report real numbers (good or bad).
9. **CA spot-check (~20 hand-written cases incl. the 5-day-vs-10-day deadline trap)**
   against the **production** corpus, reported **separately** from the benchmark.

**Hygiene / decisions**
10. **Rotate the leaked `cfut_…` CF token and `m0-…` mem0 key.**
11. **Open legal decision:** non-personal-service extra days — engine currently
    biases to the earliest (safer) date; CCP §1167(b) text says +5 **court** days for
    mail/SoS while the headline used +10 calendar. A licensed attorney must confirm.
    See P1-B notes in `TASKS.md`.

---

## 8. Python eval — use `uv` ONLY (user requirement)

`apps/eval` is Python 3.11. **Do not use pip/conda/poetry directly — use `uv`.**

```bash
cd apps/eval
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"

# tests (pure scoring numbers are pinned)
uv run pytest          # or: pytest  (inside the activated venv)

# full controlled eval (needs a deployed grounding endpoint + AI Search creds)
export CF_ACCOUNT_ID=...                 # 32-char account id
export CF_API_TOKEN=...                   # token: AI Search:Edit + AI Search:Run
export PROD_AISEARCH_NAMESPACE=dueprocess-ca      # denylist guard
export PROD_AISEARCH_INSTANCE=dueprocess-prod     # denylist guard
python dataset.py
python index_eval_corpus.py --state California --sample-size 50 --holdout-frac 0.2
GROUNDING_ENDPOINT_URL=https://<deployed-app>/api/answer python run_eval.py --k 5
cat out/metrics.json && cat out/summary.md
python index_eval_corpus.py --teardown   # tear down the throwaway eval instance
```

Honesty rules (non-negotiable): never point the eval at the production instance;
never fabricate metrics; report failures as failures. `out/` is gitignored.

---

## 9. Key commands (apps/web)

```bash
pnpm install                                  # pnpm 11; build scripts gated by allowBuilds
pnpm -C apps/web exec tsc --noEmit            # typecheck
pnpm -C apps/web exec vitest run              # unit tests (77/77 on merged main)
pnpm -C apps/web build                        # next build (works w/o CF auth — see §10)

# Re-run infra if needed (sources gitignored .dev.vars; never echoes secrets):
set -a; . ./.dev.vars; set +a
npx -y tsx scripts/upload-corpus.ts                                  # AI Search upload
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  pnpm -C apps/web exec wrangler d1 migrations apply dueprocess --remote
```

---

## 10. Gotchas / decisions already made (don't re-litigate)

- **pnpm 11 build scripts:** use `allowBuilds: { esbuild: true, sharp: true, workerd: true }`
  in `pnpm-workspace.yaml`. `onlyBuiltDependencies` is **removed** in v11 and silently
  ignored; `strictDepBuilds` defaults true (unreviewed build scripts hard-fail install).
  Validate fixes with a COLD `rm -rf node_modules && pnpm install --frozen-lockfile`.
- **mem0 via Platform v3 REST API (fetch), NOT the `mem0ai` SDK** — the SDK pulls
  native deps (better-sqlite3/pg/redis) that don't run on Workers. See `lib/memory.ts`.
- **`pdf-lib`** is pure-JS and Workers-safe (used by P2-F for the UD-105 draft).
- **`next.config.ts` guards `initOpenNextCloudflareForDev()` to `NODE_ENV==='development'`**
  so `next build` runs without `wrangler login` / CF token. Don't remove the guard.
- **Reasoning model uses JSON mode (`response_format`).** If it over-abstains in a
  demo, set env `MODEL_REASONING=@cf/meta/llama-3.3-70b-instruct-fp8-fast` — no code
  change needed.
- **Citations are enforced in code**, the model only returns source numbers.
- **Deadline:** non-personal service biases to the **earliest** date for safety
  (decision applied in Wave 1; still flagged for attorney confirmation — §7.11).

---

## 11. Source-of-truth files to read on arrival

- `CLAUDE.md` — product invariants, architecture, contracts, build priorities.
- `SETUP_AND_OPS.md` — bindings, agent orchestration, build/test/deploy.
- `DEVIN_PROMPTS.md` — the exact per-task prompts (P3-I, P3-J) + global guardrails.
- `TASKS.md` — canonical live status + verification log.
- `apps/eval/README.md` + `apps/eval/CLAUDE.md` — eval design + rules.
