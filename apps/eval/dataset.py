"""Load, filter, sample, and cache the reglab/housing_qa dataset.

Subsets (per the dataset card):
  - "questions"     (split "test")   : yes/no Qs WITH gold statute annotations.
  - "questions_aux" (split "test")   : larger Q set, NO statute annotations.
  - "statutes"      (split "corpus") : ~1.7M statutes (the controlled corpus).

Loading reglab/housing_qa requires `trust_remote_code=True` because the repo
ships a loading script. We surface that explicitly rather than hiding it.

Nothing here scores anything; it only produces normalized python dicts and
caches normalized JSON under data/ for reproducible, offline-friendly runs.
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any, Iterable, Optional

from config import DATA_DIR, HF_DATASET

# Normalized record shapes (plain dicts so they JSON-serialize trivially):
#   question: {idx, state, question, answer, question_group, gold_citations[],
#              gold_statute_idxs[], original_question, caveats[]}
#   statute:  {idx, citation, path, state, text}


def _ensure_data_dir() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR


def load_hf_subset(subset: str, split: str):
    """Load a raw HuggingFace split. Imported lazily so unit tests don't need it."""
    from datasets import load_dataset  # local import: heavy, network-bound

    return load_dataset(HF_DATASET, subset, split=split, trust_remote_code=True)


def normalize_question(row: dict[str, Any]) -> dict[str, Any]:
    statutes = row.get("statutes") or []
    gold_citations = [s.get("citation") for s in statutes if s.get("citation")]
    gold_statute_idxs = [s["statute_idx"] for s in statutes if s.get("statute_idx") is not None]
    return {
        "idx": row.get("idx"),
        "state": row.get("state"),
        "question": row.get("question"),
        "answer": row.get("answer"),  # "Yes" / "No"
        "question_group": row.get("question_group"),
        "gold_citations": gold_citations,
        "gold_statute_idxs": gold_statute_idxs,
        "original_question": row.get("original_question"),
        "caveats": row.get("caveats") or [],
    }


def normalize_statute(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "idx": row.get("idx"),
        "citation": row.get("citation"),
        "path": row.get("path"),
        "state": row.get("state"),
        "text": row.get("text"),
    }


def _sample(records: list[dict], sample_size: Optional[int], seed: int) -> list[dict]:
    if sample_size is None or sample_size >= len(records):
        return records
    rng = random.Random(seed)
    idxs = sorted(rng.sample(range(len(records)), sample_size))
    return [records[i] for i in idxs]


def prepare_questions(
    *,
    subset: str = "questions",
    state: Optional[str] = None,
    sample_size: Optional[int] = None,
    seed: int = 1234,
    cache: bool = True,
) -> list[dict[str, Any]]:
    """Download, filter by `state` (e.g. "California"), sample, and cache.

    Only "questions" carries gold statute annotations usable for retrieval
    scoring; "questions_aux" is allowed here for answer-accuracy sampling only.
    """
    if subset not in ("questions", "questions_aux"):
        raise ValueError("subset must be 'questions' or 'questions_aux'")

    ds = load_hf_subset(subset, "test")
    records = [normalize_question(dict(r)) for r in ds]
    if state:
        records = [r for r in records if (r.get("state") or "").lower() == state.lower()]
    records = _sample(records, sample_size, seed)

    if cache:
        _ensure_data_dir()
        path = _cache_path(subset, state, sample_size)
        path.write_text(json.dumps(records, ensure_ascii=False, indent=2))
    return records


def prepare_statutes(
    *,
    state: Optional[str] = None,
    sample_size: Optional[int] = None,
    seed: int = 1234,
    cache: bool = True,
) -> list[dict[str, Any]]:
    """Load the statutes corpus, optionally filtered by state and sampled.

    The full corpus is ~1.7M rows; callers should ALWAYS pass a `state` and/or
    `sample_size`, or combine with `select_statutes_by_idx` for the gold set.
    """
    ds = load_hf_subset("statutes", "corpus")
    if state:
        # `datasets.filter` streams without materializing 1.7M dicts in memory.
        ds = ds.filter(lambda r: (r.get("state") or "").lower() == state.lower())
    records = [normalize_statute(dict(r)) for r in ds]
    records = _sample(records, sample_size, seed)
    if cache:
        _ensure_data_dir()
        path = _cache_path("statutes", state, sample_size)
        path.write_text(json.dumps(records, ensure_ascii=False, indent=2))
    return records


def select_statutes_by_idx(idxs: Iterable[int]) -> list[dict[str, Any]]:
    """Fetch the specific statutes referenced by a set of question gold idxs.

    Loads the corpus and keeps only rows whose `idx` is in `idxs`. Used so the
    eval corpus is guaranteed to contain the gold statutes (otherwise retrieval
    could never hit them and the metric would be meaningless).
    """
    want = set(int(i) for i in idxs)
    if not want:
        return []
    ds = load_hf_subset("statutes", "corpus")
    ds = ds.filter(lambda r: r.get("idx") in want)
    return [normalize_statute(dict(r)) for r in ds]


def gold_statute_idxs(questions: Iterable[dict[str, Any]]) -> list[int]:
    """Collect the unique gold statute idxs referenced by a set of questions."""
    out: set[int] = set()
    for q in questions:
        for i in q.get("gold_statute_idxs") or []:
            out.add(int(i))
    return sorted(out)


def _slug(value: Optional[str]) -> str:
    return (value or "all").lower().replace(" ", "-")


def _cache_path(subset: str, state: Optional[str], sample_size: Optional[int]) -> Path:
    n = "full" if sample_size is None else str(sample_size)
    return DATA_DIR / f"{subset}__{_slug(state)}__{n}.json"


def load_cached(subset: str, state: Optional[str], sample_size: Optional[int]) -> Optional[list[dict]]:
    path = _cache_path(subset, state, sample_size)
    if path.exists():
        return json.loads(path.read_text())
    return None
