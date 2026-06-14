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
- [ ] **GAP:** `app/api/intake/route.ts` is NOT wired to `extractNoticeFacts` (out of P1-C's lane). No wave task currently owns this wiring — assign in Wave 2/3.

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
- [ ] Commit + push the merged `main` (amended deadline engine + pnpm fix + TASKS.md)

---

## Wave 2 — Dependent modules (after Wave 1 merge)

**Wave 2 launch prep (done 2026-06-14):**
- `scripts/setup-worktrees-wave2.sh` + `scripts/launch-wave2.sh` created (3 locked worktrees: `p2e-grounding` / `p2f-documents` / `p2g-persistence`; opus, P2-E at xhigh).
- Deps pre-seeded on `main`: **`pdf-lib`** (P2-F, pure-JS Workers-OK). **`mem0ai` was tried and REVERTED** — it pulls native `better-sqlite3` which won't run on Workers. **P2-G must use the mem0 platform REST API via `fetch`** (verify endpoints/auth at docs.mem0.ai), not the SDK.
- Lockfile: agents should add NO new deps; if one must, regenerate `pnpm-lock.yaml` via `pnpm install` at merge.

### P2-E — Grounded answer + abstention pipeline (depends on P1-A)
Status: `[ ] TODO` — owns `lib/grounding.ts`, `app/api/answer/route.ts` + tests.

### P2-F — UD-105 Answer draft generation (depends on P1-A)
Status: `[ ] TODO` — owns `lib/documents.ts`, `app/api/document/route.ts` + tests.

### P2-G — Case persistence: D1 + Durable Object alarm + mem0 (depends on P0)
Status: `[ ] TODO` — owns `lib/db.ts`, `lib/memory.ts`, `durable-objects/case-do.ts`, `app/api/case/route.ts` + tests.

---

## Wave 3 — Integration

### P3-H — Frontend flow (the demo path)
Status: `[ ] TODO` — owns `app/` UI; wires existing routes; 4 CORE features.

### P3-I — Enhancements: Composio actions + voice/multilingual (cuttable)
Status: `[ ] TODO` — owns `lib/actions.ts`, `app/api/actions/*`, voice intake.

### P3-J — End-to-end pass, eval run, README + Devpost
Status: `[ ] TODO` — demo-proof + real metrics in README/DEVPOST.

---

## Human Action Items (blockers)

- [x] **Commit P1-B/C/D worktrees** (done: `87cb7e1`, `7badfa7`, `892e16a`).
- [x] **Fixed `pnpm-workspace.yaml` build-scripts config** (2026-06-14): the Cloudflare deploy failed with `ERR_PNPM_IGNORED_BUILDS` (esbuild/sharp/workerd). Root cause: this repo pins **pnpm 11** (`packageManager`), which **removed `onlyBuiltDependencies`** and replaced it with **`allowBuilds`** (a `pkg: true|false` map); with `strictDepBuilds` defaulting to `true`, unreviewed build scripts hard-fail the install. Fix = `allowBuilds: { esbuild: true, sharp: true, workerd: true }`. Verified with a COLD `pnpm install --frozen-lockfile` (build scripts run, exit 0).
- [x] **Wired `app/api/intake/route.ts`** → `extractNoticeFacts` (2026-06-14): handles JSON `{imageBase64,text,language}` + multipart `image` upload; extraction self-resolves the AI binding. tsc clean, tests green.
- [ ] **Create + index AI Search** for production: run `scripts/upload-corpus.ts` with
  `CF_ACCOUNT_ID` + `CF_API_TOKEN` (AI Search Edit+Run). Confirm in dashboard
  (AI → AI Search → namespace `dueprocess-ca` → instance `dueprocess-prod` → indexing complete).
- [x] **AI Search naming reconciled** (verified 2026-06-14): `dueprocess-ca` is the namespace, `dueprocess-prod` is the instance inside it. Correct, no change needed.
- [ ] **Add secrets** in Cloudflare dashboard (prod) + local `.dev.vars`:
  `MEM0_API_KEY`, `COMPOSIO_API_KEY`, optional `NEBIUS_API_KEY`.
- [ ] **Apply D1 migration** `0001_init.sql` to the `dueprocess` DB.

## Risks / things to verify (not from memory — confirm against live docs)

1. ~~AI Search runtime API~~ — **RESOLVED 2026-06-14**: `ai-search.ts` verified correct against live docs.
2. ~~AI Search REST API~~ — **RESOLVED 2026-06-14**: namespaced endpoints `/ai-search/namespaces/{ns}/instances/...` confirmed to exist; `custom_metadata` schema shape correct (≤5 fields, no reserved names). Only the per-item `metadata` multipart field name needs an empirical check on first upload.
3. **Deadline non-personal extra days** — engine uses +10 calendar days (flagged VERIFY);
   CCP §1167(b) text in `corpus/statute-ccp-1167.md` states +5 **court** days for mail/SoS.
   Substituted service (§415.20) differs again. A licensed attorney must confirm.
   **OPEN DECISION:** whether the hero countdown shows the EARLIEST (personal-service) date for safety vs the current extended date. See P1-B.

## Verification Log

| Date | Branch | What was verified | By |
|------|--------|-------------------|----|
| 2026-06-14 | `p1a-corpus` | Reviewed corpus (13 files + MISSING.md), `ai-search.ts`, `upload-corpus.ts` via git; lane respected; index NOT yet built; AI Search API shapes flagged for verification | Cascade |
| 2026-06-14 | `p1b-deadline` | Reviewed `deadline-engine.ts` (`87cb7e1`): pure, holiday table 2026–27, invariants hold. Flagged non-personal +10 calendar-day headline-date bias vs corpus §1167(b) +5 court days. In-lane (+ shared pnpm line). | Cascade |
| 2026-06-14 | `p1c-extraction` | Reviewed `extraction.ts` (`7badfa7`): MODELS.VISION, guided_json, zod, safe fallbacks, perception-only. In-lane (+ shared pnpm line). Noted `/api/intake` wiring gap. | Cascade |
| 2026-06-14 | `p1d-eval` | Reviewed `apps/eval/` (`892e16a`): separate `"eval"` namespace + anti-production guard, no `apps/web` imports. In-lane. | Cascade |
| 2026-06-14 | (docs) | Verified AI Search API against developers.cloudflare.com: runtime binding/search/response shapes + namespaced REST upload endpoints + custom_metadata schema all match `ai-search.ts`/`upload-corpus.ts`. Retracted earlier naming-mismatch concern. | Cascade |
| 2026-06-14 | `main` | Merged all 4 Wave 1 branches (no conflicts). Applied deadline decision (non-personal = earliest date). Fixed pnpm-workspace.yaml. `tsc --noEmit` clean, `pnpm test` 26/26 pass. | Cascade |
