"""Run the controlled housing_qa eval against the deployed grounding endpoint.

Flow (headless-capable; api.py just wraps this):
  1. Load the sampled `questions` (same params used to build the eval corpus).
  2. For each question, POST it to the deployed grounding endpoint (the SAME
     pipeline the product uses), pointed at the EVAL corpus.
  3. Map the returned GroundedAnswer into a pure `ItemResult` and score it.
  4. Write out/metrics.json (3 metric families) + a human-readable out/summary.md
     that states the 2021 dataset limitation and cites RegLab.

This module performs network I/O (HTTP to the endpoint) but never imports
apps/web and never touches Cloudflare directly. All math lives in scoring.py.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import httpx

import dataset
import index_eval_corpus as corpus_mod
from config import (
    DATASET_CITATION,
    DATASET_LIMITATION_2021,
    OUT_DIR,
    HF_DATASET,
    Settings,
    require,
)
from scoring import ItemResult, RunMetrics, extract_yes_no, normalize_yes_no, score_items

# A callable that, given a question string + case id, returns a GroundedAnswer
# dict. Real default hits the HTTP endpoint; tests can inject a fake.
AnswerFn = Callable[[str, str], dict[str, Any]]

_STATUTE_IDX = re.compile(r"statute[_-](\d+)", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# Grounding endpoint client                                                   #
# --------------------------------------------------------------------------- #

def make_http_answer_fn(client: httpx.Client, settings: Settings, language: str) -> AnswerFn:
    url = require(settings.grounding_endpoint_url, "GROUNDING_ENDPOINT_URL")

    def _answer(question_text: str, case_id: str) -> dict[str, Any]:
        body = {
            "caseId": case_id,
            "questionText": question_text,
            "language": language,
            # Routing hints so the deployed endpoint can target the EVAL corpus
            # instead of production. Harmless if the endpoint ignores them.
            "evalInstance": settings.eval_instance,
            "evalNamespace": settings.eval_namespace,
        }
        resp = client.post(url, json=body, timeout=settings.grounding_timeout_s)
        resp.raise_for_status()
        payload = resp.json()
        # Endpoint returns { ok, answer: GroundedAnswer }; accept a bare
        # GroundedAnswer too for flexibility.
        if isinstance(payload, dict) and "answer" in payload and isinstance(payload["answer"], dict):
            return payload["answer"]
        return payload

    return _answer


# --------------------------------------------------------------------------- #
# Mapping GroundedAnswer -> ItemResult                                        #
# --------------------------------------------------------------------------- #

def citation_tokens(citation: dict[str, Any]) -> list[str]:
    """Best-effort comparable identifiers for one returned Citation.

    Retrieval is scored on statute idx (unambiguous; we embedded it in the
    indexed filename/text). We scan every string field for a `statute_<idx>`
    token. If none is found we fall back to a stable non-gold token (the url or
    sourceId) so the citation still counts toward the precision denominator.
    """
    fields = [
        str(citation.get("sourceId", "")),
        str(citation.get("sourceTitle", "")),
        str(citation.get("url", "")),
        str(citation.get("snippet", "")),
        str(citation.get("filename", "")),
    ]
    for f in fields:
        m = _STATUTE_IDX.search(f)
        if m:
            return [f"statute_{int(m.group(1))}"]
    fallback = citation.get("url") or citation.get("sourceId") or citation.get("sourceTitle")
    return [str(fallback)] if fallback else []


def retrieved_identifiers(answer: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for c in answer.get("citations") or []:
        if isinstance(c, dict):
            out.extend(citation_tokens(c))
    return out


def gold_identifiers(question: dict[str, Any]) -> list[str]:
    return [f"statute_{int(i)}" for i in (question.get("gold_statute_idxs") or [])]


def to_item_result(
    question: dict[str, Any],
    answer: dict[str, Any],
    *,
    indexed_idxs: Optional[set[int]],
    holdout_idxs: set[int],
) -> ItemResult:
    status = "abstained" if answer.get("status") == "abstained" else "answered"
    predicted = extract_yes_no(answer.get("answerMarkdown")) if status == "answered" else None
    gold = normalize_yes_no(question.get("answer")) or "no"

    q_idx = question.get("idx")
    gold_statute_idxs = [int(i) for i in (question.get("gold_statute_idxs") or [])]
    if indexed_idxs is None:
        # No manifest: assume everything is in-corpus (reported as a caveat).
        answerable = True
    else:
        in_holdout = q_idx in holdout_idxs
        gold_present = any(i in indexed_idxs for i in gold_statute_idxs)
        answerable = (not in_holdout) and gold_present

    return ItemResult(
        item_id=str(q_idx),
        status=status,
        gold_answer=gold,
        predicted_answer=predicted,
        retrieved_citations=retrieved_identifiers(answer),
        gold_citations=gold_identifiers(question),
        answerable=answerable,
    )


# --------------------------------------------------------------------------- #
# Eval driver                                                                 #
# --------------------------------------------------------------------------- #

def evaluate_questions(
    questions: list[dict[str, Any]],
    answer_fn: AnswerFn,
    *,
    indexed_idxs: Optional[set[int]],
    holdout_idxs: set[int],
) -> tuple[list[ItemResult], list[dict[str, Any]]]:
    """Call the endpoint per question; return (item_results, errors)."""
    items: list[ItemResult] = []
    errors: list[dict[str, Any]] = []
    for q in questions:
        case_id = f"eval-{q.get('idx')}"
        try:
            answer = answer_fn(q.get("question") or "", case_id)
        except Exception as exc:  # record honestly; never fabricate a result
            errors.append({"item_id": q.get("idx"), "error": str(exc)})
            continue
        items.append(
            to_item_result(q, answer, indexed_idxs=indexed_idxs, holdout_idxs=holdout_idxs)
        )
    return items, errors


def run(
    settings: Settings,
    *,
    k: int,
    state: Optional[str],
    subset: str,
    sample_size: Optional[int],
    seed: int,
    language: str,
    answer_fn: Optional[AnswerFn] = None,
) -> dict[str, Any]:
    """Execute a full eval run and write outputs. Returns the metrics dict.

    If a corpus manifest exists, its params override the sampling args so the
    eval set EXACTLY matches what was indexed.
    """
    manifest = corpus_mod.load_manifest()
    indexed_idxs: Optional[set[int]] = None
    holdout_idxs: set[int] = set()
    if manifest:
        p = manifest.get("params", {})
        state = p.get("state", state)
        subset = p.get("subset", subset)
        sample_size = p.get("sample_size", sample_size)
        seed = p.get("seed", seed)
        indexed_idxs = set(manifest.get("indexed_statute_idxs", []))
        holdout_idxs = set(manifest.get("holdout_question_idxs", []))

    cached = dataset.load_cached(subset, state, sample_size)
    questions = cached if cached is not None else dataset.prepare_questions(
        subset=subset, state=state, sample_size=sample_size, seed=seed
    )

    close_client = False
    if answer_fn is None:
        client = httpx.Client()
        answer_fn = make_http_answer_fn(client, settings, language)
        close_client = True
    try:
        items, errors = evaluate_questions(
            questions, answer_fn, indexed_idxs=indexed_idxs, holdout_idxs=holdout_idxs
        )
    finally:
        if close_client:
            client.close()

    metrics = score_items(items, k)
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset": HF_DATASET,
        "dataset_citation": DATASET_CITATION,
        "limitation": DATASET_LIMITATION_2021,
        "params": {
            "k": k,
            "subset": subset,
            "state": state,
            "sample_size": sample_size,
            "seed": seed,
            "language": language,
        },
        "grounding_endpoint": settings.grounding_endpoint_url,
        "eval_instance": settings.eval_instance,
        "eval_namespace": settings.eval_namespace,
        "manifest_present": manifest is not None,
        "n_questions": len(questions),
        "n_scored": len(items),
        "n_errors": len(errors),
        "errors": errors[:50],
    }
    out = {**metrics.to_dict(), "meta": meta}
    write_outputs(out, metrics)
    return out


# --------------------------------------------------------------------------- #
# Output writers                                                              #
# --------------------------------------------------------------------------- #

def _fmt(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value:.3f}"


def write_outputs(out: dict[str, Any], metrics: RunMetrics) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "metrics.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    (OUT_DIR / "summary.md").write_text(render_summary(out, metrics))


def render_summary(out: dict[str, Any], metrics: RunMetrics) -> str:
    meta = out["meta"]
    r, a, ab = metrics.retrieval, metrics.answer, metrics.abstention
    k = metrics.k
    lines = [
        "# DueProcess — housing_qa controlled RAG eval",
        "",
        f"_Generated: {meta['generated_at']}_",
        "",
        "## Dataset & limitation",
        "",
        f"- Dataset: **{meta['dataset']}** (Stanford RegLab).",
        f"- {DATASET_CITATION}",
        f"- **{DATASET_LIMITATION_2021}**",
        "",
        "## Run parameters",
        "",
        f"- Sample: subset=`{meta['params']['subset']}`, state=`{meta['params']['state']}`, "
        f"size=`{meta['params']['sample_size']}`, seed=`{meta['params']['seed']}`, k=`{k}`.",
        f"- Grounding endpoint: `{meta['grounding_endpoint']}`",
        f"- Eval corpus: instance=`{meta['eval_instance']}` namespace=`{meta['eval_namespace']}` "
        f"(manifest present: {meta['manifest_present']}).",
        f"- Questions: {meta['n_questions']} | scored: {meta['n_scored']} | "
        f"endpoint errors: {meta['n_errors']}.",
        "",
        "## 1. Retrieval (vs gold statute citations)",
        "",
        f"- Items scored (with gold): **{r['n_scored']}**",
        f"- precision@{k}: **{_fmt(r['precision_at_k'])}**",
        f"- recall@{k}: **{_fmt(r['recall_at_k'])}**",
        f"- hit-rate@{k}: **{_fmt(r['hit_rate_at_k'])}**",
        "",
        "## 2. Answer accuracy (answered items only)",
        "",
        f"- Answered: **{a['n_answered']}** (parseable yes/no: {a['n_parseable']}, "
        f"unparseable: {a['n_unparseable']})",
        f"- Accuracy: **{_fmt(a['accuracy'])}**",
        "",
        "## 3. Abstention",
        "",
        f"- Abstained: **{ab['n_abstained']}** / {metrics.n_total} "
        f"(rate **{_fmt(ab['rate'])}**)",
        f"- Out-of-corpus (not answerable) items: {ab['n_not_answerable']}",
        f"- Abstention correctness (abstained on out-of-corpus): **{_fmt(ab['correctness'])}** "
        f"({ab['n_correct_abstentions']} correct refusals)",
        f"- Over-answer rate (answered despite out-of-corpus): **{_fmt(ab['over_answer_rate'])}** "
        "(lower is safer)",
        f"- Answer coverage (answerable items that were answered): **{_fmt(ab['answer_coverage'])}**",
        "",
        "## Honesty notes",
        "",
        "- Numbers above are produced directly by `scoring.py` from this run; "
        "they are not edited or hand-tuned.",
        "- Abstention correctness is only meaningful when the corpus was indexed "
        "with a `--holdout-frac > 0` (so some questions are genuinely "
        "out-of-corpus). With no holdout, `n_not_answerable` is 0 and those "
        "ratios show `n/a`.",
        "- A high answer accuracy with a sane abstention rate is the win; "
        "low abstention paired with wrong answers is the failure mode to avoid.",
    ]
    if meta["n_errors"]:
        lines += [
            "",
            f"> WARNING: {meta['n_errors']} question(s) failed at the endpoint and "
            "were excluded from scoring. See `metrics.json` `meta.errors`.",
        ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# CLI                                                                         #
# --------------------------------------------------------------------------- #

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--state", default="California")
    parser.add_argument("--subset", default="questions", choices=["questions", "questions_aux"])
    parser.add_argument("--sample-size", type=int, default=50)
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--language", default="en")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    out = run(
        settings,
        k=args.k,
        state=args.state,
        subset=args.subset,
        sample_size=args.sample_size,
        seed=args.seed,
        language=args.language,
    )
    print(json.dumps({"retrieval": out["retrieval"], "answer": out["answer"], "abstention": out["abstention"]}, indent=2))
    print(f"\nWrote {OUT_DIR / 'metrics.json'} and {OUT_DIR / 'summary.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
