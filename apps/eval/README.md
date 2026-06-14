# apps/eval — offline RAG evaluation (never deployed)

Produces the project's credibility metric: **how faithful and how appropriately
cautious is the grounded-answer pipeline?** This is the answer to the DoNotPay /
FTC failure — they never tested whether their AI was accurate. We test, and we
report the number, including bad results.

This subproject runs on the operator's machine. It is **never** deployed to
Cloudflare Workers, and it never imports from or modifies `apps/web`. It only
calls the deployed grounding endpoint over HTTP and the Cloudflare AI Search
REST API for the throwaway eval corpus.

## Dataset

[`reglab/housing_qa`](https://huggingface.co/datasets/reglab/housing_qa) (Stanford
RegLab, CC-BY-SA-4.0).

> **Limitation:** accurate only **as of 2021**, multi-state, and explicitly NOT
> legal advice. The controlled eval therefore measures the *grounding pipeline's
> faithfulness against a 2021 corpus*, not the correctness of current California
> law. Every output file restates this.

Subsets used:
- `statutes` — the controlled eval corpus.
- `questions` — yes/no questions **with** gold statute citations (retrieval + answer).
- `questions_aux` — larger question set, **no** annotations (answer sampling only).

## Controlled-eval design (avoids apples-to-oranges)

The live product corpus is *current* CA `.gov` sources; housing_qa gold is 2021
multi-state. Scoring the live corpus against 2021 gold would measure the wrong
thing. Instead:

1. Index the housing_qa `statutes` (the gold statutes for the sampled questions,
   plus optional same-state distractors) into a **separate, throwaway** AI Search
   instance (`index_eval_corpus.py`). Never the production instance — guarded by
   `config.assert_not_production`.
2. Run the `questions` through the **same** grounding pipeline the product uses,
   pointed at the eval corpus, via the deployed endpoint (`run_eval.py`).
3. Score three families (`scoring.py`, pure + unit-tested):
   - **retrieval** — precision@k / recall@k / hit-rate vs gold statute citations
   - **answer** — yes/no accuracy on answered items
   - **abstention** — abstention rate + correctness (was a refusal on a genuinely
     out-of-corpus question?) + over-answer rate (answered despite out-of-corpus)

To get genuine out-of-corpus questions for abstention-correctness, index with
`--holdout-frac > 0`: that fraction of questions' gold is deliberately left out
of the corpus, recorded in `data/eval_corpus_manifest.json`.

## Files

| File | Role |
| --- | --- |
| `config.py` | env config + the production-namespace safety guard |
| `dataset.py` | load / filter / sample / cache housing_qa |
| `index_eval_corpus.py` | push statutes → separate eval AI Search instance (REST) |
| `scoring.py` | pure, unit-tested retrieval / answer / abstention metrics |
| `run_eval.py` | call grounding endpoint, score, write `out/metrics.json` + `out/summary.md` |
| `api.py` | FastAPI: `/dataset/prepare`, `/eval/run`, `/eval/metrics` |

## Setup

```bash
cd apps/eval
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
```

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `GROUNDING_ENDPOINT_URL` | run_eval | deployed endpoint that runs the grounding pipeline against the eval corpus |
| `GROUNDING_TIMEOUT_S` | run_eval | per-request timeout (default 60) |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | index_eval_corpus | AI Search REST creds (token needs AI Search:Edit + AI Search:Run) |
| `EVAL_AISEARCH_INSTANCE` | index_eval_corpus | throwaway eval instance id (default `dueprocess-housingqa-eval`) |
| `EVAL_AISEARCH_NAMESPACE` | index_eval_corpus | eval namespace (default `eval`) |
| `PROD_AISEARCH_INSTANCE`, `PROD_AISEARCH_NAMESPACE` | guard | denylist so the eval can never write to production |

Secrets come from the environment only; nothing is committed.

## Usage

```bash
# 1. Cache a sample of CA questions
python dataset.py  # or via API: POST /dataset/prepare

# 2. Build + index the eval corpus (separate instance), with a 20% out-of-corpus holdout
python index_eval_corpus.py --state California --sample-size 50 --holdout-frac 0.2

# 3. Run the eval against the deployed endpoint
GROUNDING_ENDPOINT_URL=https://<your-app>/api/answer python run_eval.py --k 5

# 4. Inspect
cat out/metrics.json
cat out/summary.md

# Tear down the throwaway eval instance when done
python index_eval_corpus.py --teardown
```

FastAPI (convenience/inspection):

```bash
uvicorn api:app --port 8000
# POST /dataset/prepare, POST /eval/run, GET /eval/metrics
```

## Tests

```bash
pytest
```

`scoring.py` is pure and its numbers are pinned in `tests/test_scoring.py`.

## Honesty rules (non-negotiable)

- Never fabricate metrics or "expected" numbers. `out/` is gitignored — we ship
  code, not numbers — so stale/synthetic results can't be committed by accident.
- Never point the eval at the production AI Search instance.
- Report what the run produces, including bad results. If a run fails, say so.

## California spot-check

The design also calls for a small (~20) hand-written CA spot-check (including the
5-day-vs-10-day deadline trap) run against the **production** corpus and reported
**separately** as a qualitative check — not a benchmark. That runs against the
live app, so it is intentionally kept out of the automated controlled-eval path
above to avoid any chance of mixing it into the benchmark numbers.
