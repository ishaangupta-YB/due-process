# CLAUDE.md — apps/eval (offline Python + FastAPI)

> Read the ROOT `CLAUDE.md` first. This file governs the offline evaluation
> subproject only. This code is NEVER deployed to Cloudflare Workers — it runs
> on the human's machine (or an EC2 box) to produce the metrics that prove the
> RAG pipeline is trustworthy.

## Purpose

Produce the headline credibility number for the project: **how faithful and how
appropriately cautious is the grounded-answer pipeline?** This directly answers
the failure that got DoNotPay fined by the FTC — they never tested whether their
AI performed accurately. We test, and we report the number.

## Dataset

`reglab/housing_qa` on Hugging Face (Stanford RegLab). Built for housing-law RAG.
- `statutes` subset — a corpus of statutes (use as the controlled eval corpus).
- `questions` subset — questions WITH gold statute annotations (use for RAG eval:
  did retrieval find the right statute, and did the answer match the gold yes/no).
- `questions_aux` — larger question set, NO statute annotations (use only for
  extra answer-accuracy sampling, not retrieval scoring).
- Known limitation: accurate **as of 2021**, and explicitly not legal advice.

## Critical eval design (avoids an apples-to-oranges mistake)

The live product corpus is CURRENT California .gov sources. `housing_qa` gold
answers reference 2021 multi-state statutes. Do NOT score the live CA corpus
against 2021 gold — that measures the wrong thing.

Instead run a **controlled eval**:
1. Index the `housing_qa` `statutes` subset into a SEPARATE, throwaway AI Search
   instance (the eval namespace — never the production one).
2. Run the `questions` subset through the SAME grounding pipeline the product
   uses (`grounding.ts`), pointed at the eval namespace, via the deployed API or
   a thin eval endpoint.
3. Measure, per question:
   - **Retrieval hit:** did retrieved citations include the gold statute citation?
     (report precision@k / recall@k)
   - **Answer accuracy:** for `answered` cases, does the yes/no match gold?
   - **Abstention rate + abstention correctness:** how often it abstained, and
     whether abstentions were on genuinely unanswerable/out-of-corpus questions.
4. Report all three. A high answer-accuracy with a sane abstention rate is the
   win. Over-answering (low abstention, wrong answers) is the failure to avoid.

Also run a small **California spot-check** set (≈20 hand-written CA questions,
including the 5-day-vs-10-day deadline trap) against the PRODUCTION corpus, and
report it separately and honestly as a qualitative check, not a benchmark.

## Tech

- Python 3.11, `uv` or `pip` + `pyproject.toml`.
- `datasets` (HF) to load `reglab/housing_qa`.
- `httpx` to call the deployed grounding endpoint.
- `pandas` for scoring; write metrics to `apps/eval/out/metrics.json` + a
  markdown summary.
- **FastAPI** app (`api.py`) exposing:
  - `POST /eval/run` — trigger an eval run (params: subset, k, sample size).
  - `GET /eval/metrics` — return latest metrics.
  - `POST /dataset/prepare` — download, filter (e.g. CA rows), sample, cache to
    `data/`.
  This is for convenience/inspection; the core logic lives in plain scripts so it
  can run headless.

## Files

```
apps/eval/
  CLAUDE.md            # this file
  pyproject.toml
  api.py               # FastAPI: dataset ops + eval endpoints
  dataset.py           # load/filter/sample/cache housing_qa
  index_eval_corpus.py # push housing_qa statutes -> eval AI Search namespace
  run_eval.py          # call grounding endpoint, score, write metrics
  scoring.py           # retrieval/answer/abstention metrics (pure, unit-tested)
  data/                # cached dataset (gitignored)
  out/                 # metrics.json + summary.md
```

## Rules

- Never point the eval at the PRODUCTION AI Search namespace. Use a separate
  eval namespace and tear it down after.
- `scoring.py` is pure and unit-tested — the numbers must be reproducible.
- Do not fabricate metrics or "expected" numbers anywhere. Report what the run
  produces, including bad results. If a run fails, say so.
- Respect the dataset license; cite RegLab/housing_qa and note the 2021 limitation
  in any output summary.
- This subproject must not import from or modify `apps/web`. It only calls the
  deployed HTTP endpoint.