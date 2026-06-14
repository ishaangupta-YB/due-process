# DueProcess — Build Progress Tracker

> Single source of truth for **what is done, what is in flight, and what is left**.
> This file is canonical for status only — `CLAUDE.md` remains canonical for the spec,
> contracts, and invariants, and `DEVIN_PROMPTS.md` for per-task scope.

## How agents update this file

Every agent, at the **end of its task**, MUST:

1. Flip its task status (legend below) and tick the acceptance-criteria checkboxes it
   actually verified (with the command/output, not a guess).
2. Add a one-line entry to the **Verification Log** with date + branch + what was run.
3. Add anything a human still has to do (keys, dashboard, indexing) to **Human Action Items**.
4. NEVER edit another agent's row. NEVER mark a box ticked you did not verify.
5. Stay in your lane: do not change shared contracts (`lib/types.ts`, `lib/models.ts`,
   `migrations/`) — see `CLAUDE.md §5/§7`.

## Status legend

- `[ ] TODO` — not started
- `[~] WIP` — in progress / partially done
- `[c] COMMITTED` — committed to its branch, not yet reviewed/merged
- `[r] REVIEWED` — reviewed against acceptance criteria, awaiting merge
- `[x] DONE` — merged to `main` and verified
- `[!] BLOCKED` — needs a human action / external dependency (see notes)

---

## Wave 0 — P0 Scaffold

Status: `[x] DONE` — merged to `main` (`b28bb14`), bindings updated (`24d1a90`, `5e27605`).

- [x] Monorepo: `apps/web` (Next.js + OpenNext) and `apps/eval` skeleton
- [x] `apps/web/wrangler.jsonc` bindings: `DB`, `DOCS_BUCKET`, `AI`, `AI_SEARCH`, `CASE_DO`
- [x] D1 `database_id` filled in (`51a3a697-...`)
- [x] `lib/types.ts` canonical contracts (CLAUDE.md §7)
- [x] `lib/models.ts` canonical slugs (CLAUDE.md §5)
- [x] `migrations/0001_init.sql` (cases / qa_history / documents)
- [x] Stub modules + `app/api/*` 501 routes
- [x] vitest wired; smoke test passes

---

## Wave 1 — Independent modules (parallel, merge before Wave 2)

### P1-A — Corpus ingestion + AI Search index

Status: `[c] COMMITTED` (branch `p1a-corpus`, `fc2b6a6`) — reviewed, NOT merged. **Index not yet built.**
Owns: `corpus/`, `scripts/upload-corpus.ts`, `apps/web/lib/ai-search.ts`. (Lane respected — diff touches only these.)

- [x] `corpus/` has 13 real CA sources (self-help, CCP §§1167/1162/1170.5, UD-100/UD-105/SUM-130) with YAML front-matter (`title`, `url`, `retrieved_at`, `source_type`)
- [x] `corpus/MISSING.md` present (reports nothing missing + rationale for no separate form PDFs)
- [x] Source text not paraphrased; CCP §1167 carries the 10-court-day rule (AB 2347, eff. 2025-01-01)
- [x] `retrieve()` returns typed `RetrievedChunk[]`, hybrid search, reads `url`/`title` from metadata, never synthesizes
- [x] **AI Search API shapes VERIFIED against live docs** (2026-06-14): runtime `ai-search.ts` is correct (binding, `.get(instance).search({messages, ai_search_options:{retrieval}})`, response `chunks[].id/.text/.score/.item.key/.item.metadata`). Namespace `dueprocess-ca` + instance `dueprocess-prod` is the correct namespace/instance model (NOT a bug). Upload REST paths `/ai-search/namespaces/{ns}/instances/{id}/items` are correct.
- [ ] **AI Search index actually created + corpus indexed** (run `scripts/upload-corpus.ts`) — BLOCKED on human creds
- [ ] Test query "how many days to respond to an eviction in California" returns the 10-day rule with a real `.gov` URL — cannot pass until index exists
- [ ] Empirical micro-check only: confirm the per-item `metadata` multipart field actually populates `item.metadata.title/url` (run upload, then a test query). If empty, adjust the upload field per the Items API reference.

### P1-B — Deterministic deadline engine

Status: `[x] MERGED` (`c01f19d`) + amended on `main` (deadline decision applied). Tests green.
Owns: `apps/web/lib/deadline-engine.ts` + its test only. (Also touched shared `pnpm-workspace.yaml` — see merge gate.)

- [x] Pure function, imports only `./types`; UTC-only, reads no clock
- [x] Personal service = 10 court days from day after service, excl. weekends + CA holidays
- [x] `unknown`/missing/invalid date|method → `null` + assumption; `mustVerify` always true; ≥1 assumption
- [x] `HOLIDAYS_CA` constant (2026–2027, observed dates w/ CRC 1.11 shifts) + `holidayCalendarVersion`; out-of-range coverage flagged
- [x] Non-personal extra-days flagged `VERIFY`; surfaces earliest personal-service date as a safety target
- [x] Both `computeResponseDeadline` + `computeDeadline` alias exported (no importer breaks)
- [x] **DECISION APPLIED (2026-06-14):** non-personal headline now shows the EARLIEST defensible date (= personal baseline, 10 court days). Possible extra time is surfaced as a VERIFY assumption ("you MAY have more time"). Added a test asserting non-personal is never later than personal. Removed the unused `EXTRA_CALENDAR_DAYS_NON_PERSONAL` constant.
- [ ] Attorney should still confirm the real extension values (CCP §1167(b) / §415.20 / §1162) for the assumption wording
- [ ] Confirm `HOLIDAYS_CA` dates against courts.ca.gov before demo

### P1-C — Multimodal notice extraction

Status: `[x] MERGED` (`dc111af`). Tests green.
Owns: `apps/web/lib/extraction.ts` + its test only. (Also touched shared `pnpm-workspace.yaml` — see merge gate.)

- [x] Uses `MODELS.VISION` (no hardcoded slug)
- [x] Strict structured output (`guided_json`), low temperature, zod-validated
- [x] Perception only — no legal conclusions, no deadline math; `jurisdiction` fixed to `CA` in code
- [x] Unreadable/invalid date → `serviceDateISO: null` + field in `unreadableFields`; never guesses
- [x] Bad/invalid model output → low-confidence safe fallback, never throws raw model text
- [x] Injectable `ai` dep for testability (signature preserved)
- [x] **GAP RESOLVED (2026-06-14):** `app/api/intake/route.ts` now wired to `extractNoticeFacts` (JSON `{imageBase64,text,language}` + multipart `image`) on `main`.

### P1-D — Python eval harness + FastAPI

Status: `[x] MERGED` (`48ad30f`). Isolated in `apps/eval/`; runtime (pytest/run_eval) still to be exercised in Wave 3.
Owns: `apps/eval/` only.

- [x] `pyproject.toml` (py3.11): datasets, httpx, pandas, fastapi, uvicorn, pytest
- [x] `dataset.py`, `config.py`, `scoring.py` (+ tests), `index_eval_corpus.py`, `run_eval.py`, `api.py` present
- [x] Uses a SEPARATE eval namespace (default `"eval"`); explicit guard REFUSES to run if eval namespace == production
- [x] No imports from `apps/web` (verified via grep)
- [ ] Runtime verification (human): `pip install -e .` + `pytest` pass; `run_eval.py` produces `out/metrics.json` against the deployed endpoint (Wave 3)

### Wave 1 merge gate

- [x] All four branches committed, reviewed, lane-checked
- [x] Shared contracts (`types.ts`, `models.ts`, schema) untouched by Wave 1 agents
- [x] Merged A, B, C, D into `main` (`83f8cfe`, `c01f19d`, `dc111af`, `48ad30f`) — no conflicts
- [x] `tsc --noEmit` clean + `pnpm test` green on the merged tree (**26/26 tests pass**, 2026-06-14)
- [x] Fixed `pnpm-workspace.yaml` — removed the broken `allowBuilds` placeholder block (resolves the old deps-status failure)
- [x] Committed + pushed merged `main` (`e045411`, 2026-06-14)

---

## Wave 2 — Dependent modules (after Wave 1 merge)

**Wave 2 launch prep (done 2026-06-14):**
- `scripts/setup-worktrees-wave2.sh` + `scripts/launch-wave2.sh` created (3 locked worktrees: `p2e-grounding` / `p2f-documents` / `p2g-persistence`; opus, P2-E at xhigh).
- Deps pre-seeded on `main`: **`pdf-lib`** (P2-F, pure-JS Workers-OK). **`mem0ai` was tried and REVERTED** — it pulls native `better-sqlite3` which won't run on Workers. **P2-G must use the mem0 platform REST API via `fetch`** (verify endpoints/auth at docs.mem0.ai), not the SDK.
- Lockfile: agents should add NO new deps; if one must, regenerate `pnpm-lock.yaml` via `pnpm install` at merge.

### P2-E — Grounded answer + abstention pipeline (depends on P1-A)
Status: `[x] DONE` — merged to `main` (`e7e7d76`, branch `p2e-grounding` `a947244`). 12 tests green; reviewed in-lane.
Owns: `lib/grounding.ts`, `app/api/answer/route.ts` + test only.

- [x] `retrieve()` top-k (lazy import; injectable for tests); retrieval/model errors → abstain
- [x] Confidence gate: no usable chunk (real url+text) OR `bestScore < GROUNDING_MIN_SCORE` (0.5) → abstain WITHOUT calling the model
- [x] REASONING model with strict system prompt (answer only from sources, no outside knowledge, no computed dates, reply in user language)
- [x] **Citations enforced in code** — model returns only source NUMBERS; every `Citation` is rebuilt from retrieved-chunk metadata, so a URL can never be model-fabricated (CLAUDE.md §1.4); snippets ≤25 words
- [x] Downgrade rule: `answered` with zero valid citations (or non-JSON / out-of-range / error) → forced `abstained`; `referral` + not-a-lawyer note ALWAYS present
- [x] `response_format` JSON-mode shape VERIFIED vs Cloudflare docs; `extractResponseText` handles the `{response:{...}}` wrapper
- [ ] **Runtime (Wave 3):** confirm the `answered` path fires with the live AI Search index + deployed model. If `kimi-k2.6` over-abstains, set `MODEL_REASONING=@cf/meta/llama-3.3-70b-instruct-fp8-fast` (env-only, no code change).

### P2-F — UD-105 Answer draft generation (depends on P1-A)
Status: `[x] DONE` — merged to `main` (`0517d95`, branch `p2f-documents` `39d1a35`). 17 tests green; reviewed in-lane.
Owns: `lib/documents.ts`, `app/api/document/route.ts` + test only.

- [x] `generateAnswerDraft({caseId})` → `{r2Key, downloadUrl}`; deps (`getCase`/`retrieve`/`ai`/`bucket`) injectable, resolve from CF context in prod
- [x] `getCase` consumed read-only; signature matches `db.getCase(id):Promise<CaseRecord|null>` (cross-lane contract OK)
- [x] Caption mapping pure; unknowns → `BLANK_MARKER`; court case number ALWAYS blank (never in NoticeFacts); nothing fabricated (CLAUDE.md §1.4)
- [x] Defenses: REASONING phrases only; a defense is kept ONLY if its `sourceId` matches a retrieved chunk with a real URL; labeled "potential defense to discuss with a legal-aid attorney"
- [x] `pdf-lib` render; "DRAFT - NOT FILED..." watermark on every page; clean plain-language draft (does NOT reproduce the copyrighted form layout); stored in R2 `DOCS_BUCKET`; GET `?key=` streams it back
- [ ] Verify `OFFICIAL_FORM_URL` (`courts.ca.gov/documents/ud105.pdf`) resolves before demo (reference link only, not a citation)

### P2-G — Case persistence: D1 + Durable Object alarm + mem0 (depends on P0)
Status: `[x] DONE` — merged to `main` (`35f6abe`, branch `p2g-persistence` `9aaaa37`). 22 tests green (8 db + 7 mem0 + 7 DO); reviewed in-lane.
Owns: `lib/db.ts`, `lib/memory.ts`, `durable-objects/case-do.ts`, `app/api/case/route.ts` + tests.

- [x] `db.ts` typed CRUD (`createCase`/`getCase`/`updateCase` + `addQAEntry`/`addDocument`), zod-validated, multi-table writes in one `DB.batch`; binding via `getCloudflareContext` (injectable `db?`). Back-compatible with the P0 stub.
- [x] `memory.ts` mem0 Platform v3 REST via `fetch` (no SDK); scoped `user_id=caseId`; `infer:false` (verbatim facts); never logs key/bodies/PII
- [x] `case-do.ts` `CaseDO` (exported; matches `worker.ts` re-export) with pure `computeReminderAt` — never schedules in the past (null for passed/invalid; clamps to now); `alarm()` marks reminder due; Composio best-effort + `COMPOSIO_API_KEY`-gated (not hard-coupled)
- [x] `app/api/case/route.ts` POST creates (D1 authoritative) then best-effort mem0 seed + DO schedule; GET `?id=` returns case + reminder state; enhancement failures never break CRUD
- [ ] **Runtime:** needs D1 migration applied + `MEM0_API_KEY` set to exercise live (see Human Action Items)

### Wave 2 merge gate

- [x] All three branches committed, reviewed, lane-checked (only `apps/web` files; no `types.ts`/`models.ts`/`wrangler.jsonc`/`worker.ts`/`package.json` touched)
- [x] Cross-lane contracts verified: `documents.ts`→`db.getCase`, `case-do.ts` exports `CaseDO` (matches `worker.ts`), mem0 via REST
- [x] Root housekeeping committed (`b9aadb9`): gitignore agent transcripts; launch-wave2 single-window panes
- [x] Merged G→E→F into `main` (`35f6abe`, `e7e7d76`, `0517d95`) — no conflicts
- [x] `tsc --noEmit` clean + full `vitest run` green on merged tree (**77/77 tests pass**, 2026-06-14)
- [ ] Push `main` to origin

---

## Wave 3 — Integration

### P3-H — Frontend flow (the demo path)
Status: `[x] DONE` — merged to `main` (`3bf4029`, branch `p3h-frontend` `497a5ce`). In-lane (only `app/`); `tsc` clean, 77/77 tests, `next build` succeeds.
Owns: `app/` UI (page/layout/globals + 6 components) + the in-lane `app/api/deadline/route.ts` wire-up.

- [x] 4 CORE steps as components: `IntakeStep`, `NoticeFactsStep` + `DeadlineCountdown`, `RightsChat` (+ safe `Markdown` renderer w/ clickable .gov citations + distinct abstention UI), `DocumentStep` (watermarked UD-105 download). Orchestrated in `page.tsx`.
- [x] `layout.tsx` skip-link + persistent footer disclaimer (not a lawyer / drafts only); `globals.css` calm high-contrast accessible theme (18px, focus rings, mobile-first, reduced-motion).
- [x] In-lane backend wire-up: `app/api/deadline/route.ts` (was 501) → thin zod-validated pass-through to `computeResponseDeadline`. NO `lib/*` signature/contract change (verified: shared-contract diff empty); LLM still never computes the deadline.
- [x] Foundation fix applied separately (`65bac58`): `next.config.ts` guards `initOpenNextCloudflareForDev()` to `NODE_ENV==='development'` so `next build` runs without CF auth (P3-H flagged it; standard OpenNext pattern, zero dev-behaviour change).
- [ ] Full Q&A citations + PDF download need the deployed env (AI Search index + D1 + R2); locally they degrade gracefully by design.

### P3-I — Enhancements: Composio actions + voice/multilingual (cuttable)
Status: `[x] DONE` — merged to `main` (`755fc32`, branch `p3i-enhancements` `497690e`). In-lane, **no shared-contract changes**, `tsc` clean, 92/92 tests.
- [x] Composio actions `lib/actions.ts` (+ `app/api/actions/email-clinic`, `reminder`, `ActionsStep.tsx`): `emailClinic` (GMAIL_SEND_EMAIL) + `createReminder` (GOOGLECALENDAR_CREATE_EVENT). Double consent (zod `consent:true` + UI checkbox); env-configurable slugs/accounts/base-URL/timezone; status-only logging. Live demo needs `COMPOSIO_API_KEY` + connected Gmail/Calendar.
- [x] Voice + multilingual intake `lib/stt.ts` (+ intake route + `IntakeStep.tsx` "Speak it"): `transcribeAudio` via `MODELS.STT` (Whisper) default, opt-in `MODELS.STT_MULTILINGUAL` (Deepgram nova-3) via `STT_ENGINE`. Perception-only; feeds transcript into the same extraction → multilingual NoticeFacts → same-language answers. Graceful failure when unconfigured (no 500s on CORE path).

### P3-J — End-to-end pass, eval run, README + Devpost
Status: `[x] DONE` — merged to `main` (`1767636`, branch `p3j-eval-readme` `eed6d89`). 77 web + 35 eval tests, `tsc`/`next build` clean.
- [x] Demo-proofed the full CORE path against REAL models/services (intake→deadline→grounded Q&A): real Llama 4 Scout extraction, real deadline engine (2026-06-08 personal → 2026-06-23, skips Juneteenth), real AI Search grounding (in-corpus answers w/ citations, out-of-corpus abstains).
- [x] Scripted demo dataset `demo/` (watermarked synthetic CA SUM-130 svg+png + `demo-data.json` with expected facts + in/out-of-corpus questions).
- [x] Real controlled eval (reglab/housing_qa, 50 CA Qs, k=5, 20% holdout, 0 endpoint errors) — answer acc **0.65**, abstention **0.60** (0.30 over-answer), citation hit@5 **0.24**. Honestly modest + caveated (2021 dataset; run used fallback `gpt-oss` because kimi-k2.6 was capacity-flaky). README + DEVPOST (495 words) carry the numbers + disclosures. Throwaway eval instance torn down; production untouched.
- [x] **Decision (approved):** used the thin eval endpoint `apps/web/scripts/eval-endpoint.ts` (sanctioned by `apps/eval/CLAUDE.md`) instead of adding eval routing to `/api/answer` + `ai-search.ts` — keeps the safety-critical product path + shared contract untouched and all 77 tests valid. Keep as-is.
- [x] Merge gotcha fixed: both P3-I/P3-J committed `.devin/config.local.json` (machine-local Devin tooling) → add/add conflict on the P3-J merge. Resolved by untracking it + adding `.devin/` to `.gitignore`.

---

## Human Action Items (blockers)

- [x] **Commit P1-B/C/D worktrees** (done: `87cb7e1`, `7badfa7`, `892e16a`).
- [x] **Fixed `pnpm-workspace.yaml` build-scripts config** (2026-06-14): the Cloudflare deploy failed with `ERR_PNPM_IGNORED_BUILDS` (esbuild/sharp/workerd). Root cause: this repo pins **pnpm 11** (`packageManager`), which **removed `onlyBuiltDependencies`** and replaced it with **`allowBuilds`** (a `pkg: true|false` map); with `strictDepBuilds` defaulting to `true`, unreviewed build scripts hard-fail the install. Fix = `allowBuilds: { esbuild: true, sharp: true, workerd: true }`. Verified with a COLD `pnpm install --frozen-lockfile` (build scripts run, exit 0).
- [x] **Wired `app/api/intake/route.ts`** → `extractNoticeFacts` (2026-06-14): handles JSON `{imageBase64,text,language}` + multipart `image` upload; extraction self-resolves the AI binding. tsc clean, tests green.
- [x] **Create + index AI Search** — DONE 2026-06-14: with a correctly-scoped token, `scripts/upload-corpus.ts` created instance `dueprocess-prod` in namespace `dueprocess-ca`, set the custom_metadata schema, and uploaded all **13 corpus files** (queued for indexing). Confirm indexing completed in the dashboard (AI → AI Search → `dueprocess-prod`) before relying on grounded answers. (Earlier `cfut_…` token 401'd and must still be rotated.)
- [x] **AI Search naming reconciled** (verified 2026-06-14): `dueprocess-ca` is the namespace, `dueprocess-prod` is the instance inside it. Correct, no change needed.
- [ ] **Add secrets** in Cloudflare dashboard (prod) + local `.dev.vars`:
  `MEM0_API_KEY`, `COMPOSIO_API_KEY`, optional `NEBIUS_API_KEY`.
- [x] **Apply D1 migration** — DONE 2026-06-14: `wrangler d1 migrations apply dueprocess --remote` applied `0001_init.sql` to remote `dueprocess` (`51a3a697-…`), 5 commands ✅ (cases / qa_history / documents).
- [x] **`next build` without CF auth** — fixed via the `next.config.ts` dev-init guard (`65bac58`).

## Risks / things to verify (not from memory — confirm against live docs)

1. ~~AI Search runtime API~~ — **RESOLVED 2026-06-14**: `ai-search.ts` verified correct against live docs.
2. ~~AI Search REST API~~ — **RESOLVED 2026-06-14**: namespaced endpoints `/ai-search/namespaces/{ns}/instances/...` confirmed to exist; `custom_metadata` schema shape correct (≤5 fields, no reserved names). Only the per-item `metadata` multipart field name needs an empirical check on first upload.
3. **Deadline non-personal extra days** — engine uses +10 calendar days (flagged VERIFY);
   CCP §1167(b) text in `corpus/statute-ccp-1167.md` states +5 **court** days for mail/SoS.
   Substituted service (§415.20) differs again. A licensed attorney must confirm.
   **OPEN DECISION:** whether the hero countdown shows the EARLIEST (personal-service) date for safety vs the current extended date. See P1-B.
4. **REASONING JSON mode** — `grounding.ts`/`documents.ts` use `response_format` (shape VERIFIED vs Cloudflare docs). `kimi-k2.6` is documented on the Workers AI Models page to support structured outputs but is NOT on the older JSON-Mode feature list; if it can't comply, Workers AI returns a `JSON Mode couldn't be met` error and the code safely abstains. Mitigation if over-abstaining in the demo: set `MODEL_REASONING=@cf/meta/llama-3.3-70b-instruct-fp8-fast` (env-only, no code change).

## Verification Log

| Date | Branch | What was verified | By |
|------|--------|-------------------|----|
| 2026-06-14 | `p1a-corpus` | Reviewed corpus (13 files + MISSING.md), `ai-search.ts`, `upload-corpus.ts` via git; lane respected; index NOT yet built; AI Search API shapes flagged for verification | Cascade |
| 2026-06-14 | `p1b-deadline` | Reviewed `deadline-engine.ts` (`87cb7e1`): pure, holiday table 2026–27, invariants hold. Flagged non-personal +10 calendar-day headline-date bias vs corpus §1167(b) +5 court days. In-lane (+ shared pnpm line). | Cascade |
| 2026-06-14 | `p1c-extraction` | Reviewed `extraction.ts` (`7badfa7`): MODELS.VISION, guided_json, zod, safe fallbacks, perception-only. In-lane (+ shared pnpm line). Noted `/api/intake` wiring gap. | Cascade |
| 2026-06-14 | `p1d-eval` | Reviewed `apps/eval/` (`892e16a`): separate `"eval"` namespace + anti-production guard, no `apps/web` imports. In-lane. | Cascade |
| 2026-06-14 | (docs) | Verified AI Search API against developers.cloudflare.com: runtime binding/search/response shapes + namespaced REST upload endpoints + custom_metadata schema all match `ai-search.ts`/`upload-corpus.ts`. Retracted earlier naming-mismatch concern. | Cascade |
| 2026-06-14 | `main` | Merged all 4 Wave 1 branches (no conflicts). Applied deadline decision (non-personal = earliest date). Fixed pnpm-workspace.yaml. `tsc --noEmit` clean, `pnpm test` 26/26 pass. | Cascade |
| 2026-06-14 | `main` | Reviewed + merged Wave 2 (P2-E/F/G) via git: lanes clean, contracts match (`getCase`, `CaseDO`), citations code-enforced, DO past-alarm guard, mem0 REST. Verified `response_format` shape + kimi structured-output support vs Cloudflare docs. Merged G→E→F, `tsc` clean, **77/77 tests pass**. | Cascade |
| 2026-06-14 | `main` | Reviewed + merged P3-H (`3bf4029`): in-lane (`app/` only), `api/deadline` thin pass-through, no contract change. Added `next.config.ts` dev-init guard (`65bac58`). `tsc` clean, **77/77 tests**, `next build` OK w/o CF auth. AI Search upload + D1 migration attempted but BLOCKED: CF token 403/401 (not authenticating). | Cascade |
| 2026-06-14 | `main` | Infra setup DONE with corrected token: AI Search instance `dueprocess-prod` created + 13 corpus files uploaded/queued for indexing; D1 migration `0001_init.sql` applied to remote `dueprocess` (5 cmds ✅). | Cascade |
| 2026-06-14 | `main` | Merged P3-I (`755fc32`) + P3-J (`1767636`). Resolved add/add conflict on `.devin/config.local.json` (untracked + gitignored). Verified **zero** changes to shared contracts (`types.ts`/`models.ts`/`migrations`/`wrangler.jsonc`/`worker.ts`) across all of Wave 3. `tsc` clean, **92/92 web tests**. P3-J reports 35 eval tests + real eval metrics (answer 0.65 / abstention 0.60 / hit@5 0.24). | Cascade |
