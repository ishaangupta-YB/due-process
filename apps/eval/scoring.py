"""Pure scoring functions for the housing_qa controlled RAG eval.

NOTHING in this module does I/O, network, or randomness. Every number is a
deterministic function of its inputs so the metrics are reproducible and the
unit tests can pin exact values (apps/eval CLAUDE rule: scoring is pure & tested).

Three metric families are produced (see `score_items`):
  1. retrieval   — precision@k / recall@k / hit-rate vs gold statute citations
  2. answer      — yes/no accuracy on items the pipeline chose to answer
  3. abstention  — how often it abstained, and whether those abstentions were
                   correct (refused on genuinely out-of-corpus questions) vs.
                   incorrect (refused when the corpus did support an answer)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal, Optional, Sequence

Status = Literal["answered", "abstained"]
YesNo = Literal["yes", "no"]


# --------------------------------------------------------------------------- #
# Normalization / matching                                                    #
# --------------------------------------------------------------------------- #

_SECTION_TOKENS = ("§§", "§", "sec.", "section", "sections")
_WS = re.compile(r"\s+")
_NONALNUM_EDGE = re.compile(r"^[^0-9a-z]+|[^0-9a-z]+$")


def normalize_citation(citation: str) -> str:
    """Normalize a statute citation for robust set-membership comparison.

    Gold citations look like ``"ALA. CODE § 35-9A-141(11)"``. Retrieved citations
    (derived from indexed filenames / metadata) may differ in spacing, the
    section glyph, and casing. We lowercase, replace section glyphs and the word
    "section" with a single 's' marker, drop all whitespace, and strip edge
    punctuation. This keeps real differences (different statute numbers) while
    erasing cosmetic ones.
    """
    s = citation.strip().lower()
    for tok in _SECTION_TOKENS:
        s = s.replace(tok, " s ")
    s = _WS.sub(" ", s).strip()
    s = _NONALNUM_EDGE.sub("", s)
    # Remove all spaces so "ala.code s 35-9a-141(11)" -> "ala.codes35-9a-141(11)".
    return s.replace(" ", "")


def _normset(citations: Sequence[str]) -> set[str]:
    return {normalize_citation(c) for c in citations if c and c.strip()}


def _ordered_norm(citations: Sequence[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for c in citations:
        if not c or not c.strip():
            continue
        n = normalize_citation(c)
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


# --------------------------------------------------------------------------- #
# Retrieval metrics                                                           #
# --------------------------------------------------------------------------- #

def precision_at_k(retrieved: Sequence[str], gold: Sequence[str], k: int) -> float:
    """Fraction of the top-k retrieved citations that are gold.

    Empty top-k window (nothing retrieved) -> 0.0.
    """
    if k <= 0:
        raise ValueError("k must be >= 1")
    top = _ordered_norm(retrieved)[:k]
    if not top:
        return 0.0
    goldset = _normset(gold)
    hits = sum(1 for c in top if c in goldset)
    return hits / len(top)


def recall_at_k(retrieved: Sequence[str], gold: Sequence[str], k: int) -> float:
    """Fraction of gold citations found within the top-k retrieved.

    No gold citations -> undefined; we return 0.0 by convention but such items
    are excluded from retrieval aggregates in `score_items`.
    """
    if k <= 0:
        raise ValueError("k must be >= 1")
    goldset = _normset(gold)
    if not goldset:
        return 0.0
    top = set(_ordered_norm(retrieved)[:k])
    hits = sum(1 for g in goldset if g in top)
    return hits / len(goldset)


def hit_at_k(retrieved: Sequence[str], gold: Sequence[str], k: int) -> bool:
    """True if at least one gold citation appears in the top-k retrieved."""
    if k <= 0:
        raise ValueError("k must be >= 1")
    goldset = _normset(gold)
    if not goldset:
        return False
    top = set(_ordered_norm(retrieved)[:k])
    return any(g in top for g in goldset)


# --------------------------------------------------------------------------- #
# Answer (yes/no) extraction + accuracy                                       #
# --------------------------------------------------------------------------- #

_YES = re.compile(r"\b(yes|affirmative|correct)\b", re.IGNORECASE)
_NO = re.compile(r"\b(no|negative|incorrect)\b", re.IGNORECASE)


def normalize_yes_no(value: Optional[str]) -> Optional[YesNo]:
    """Map a raw gold/predicted label to 'yes'/'no', or None if unclear."""
    if value is None:
        return None
    v = value.strip().lower()
    if v in ("yes", "y", "true", "1"):
        return "yes"
    if v in ("no", "n", "false", "0"):
        return "no"
    return None


def extract_yes_no(answer_text: Optional[str]) -> Optional[YesNo]:
    """Heuristically extract a yes/no verdict from grounded answer prose.

    The product's GroundedAnswer carries markdown prose, not a structured
    yes/no field. For scoring against housing_qa's yes/no gold we look for the
    FIRST yes/no signal in the text. Returns None when neither (or both at the
    very start ambiguously) can be determined; such items are counted as
    'unparseable' rather than silently scored.
    """
    if not answer_text:
        return None
    text = answer_text.strip()
    if not text:
        return None
    yes_m = _YES.search(text)
    no_m = _NO.search(text)
    if yes_m and not no_m:
        return "yes"
    if no_m and not yes_m:
        return "no"
    if yes_m and no_m:
        # Whichever appears first wins (answers typically lead with the verdict).
        return "yes" if yes_m.start() < no_m.start() else "no"
    return None


# --------------------------------------------------------------------------- #
# Per-item record + aggregation                                               #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class ItemResult:
    """One scored question. Constructed by run_eval; consumed here (pure)."""

    item_id: str
    status: Status
    gold_answer: YesNo                       # 'yes' / 'no' from housing_qa
    predicted_answer: Optional[YesNo]        # parsed from prose; None if unparseable
    retrieved_citations: list[str] = field(default_factory=list)  # rank order
    gold_citations: list[str] = field(default_factory=list)
    answerable: bool = True
    # `answerable` = the gold statute(s) for this item are present in the indexed
    # eval corpus, so the pipeline *could* have answered from grounding. Used to
    # judge whether an abstention was correct.


def _ratio(num: int, den: int) -> Optional[float]:
    """Honest ratio: None when undefined (denominator 0), never a fake 0."""
    return (num / den) if den else None


def _mean(xs: Sequence[float]) -> Optional[float]:
    return (sum(xs) / len(xs)) if xs else None


@dataclass
class RunMetrics:
    k: int
    n_total: int
    retrieval: dict
    answer: dict
    abstention: dict

    def to_dict(self) -> dict:
        return {
            "k": self.k,
            "n_total": self.n_total,
            "retrieval": self.retrieval,
            "answer": self.answer,
            "abstention": self.abstention,
        }


def score_items(items: Sequence[ItemResult], k: int) -> RunMetrics:
    """Aggregate per-item results into the three metric families.

    Definitions are intentionally explicit so the README can quote them:

    retrieval (over items that have >=1 gold citation):
        precision_at_k / recall_at_k  — mean over those items
        hit_rate_at_k                 — fraction with >=1 gold citation in top-k

    answer (over items the pipeline chose to ANSWER):
        accuracy            — correct yes/no / parseable answered items
        unparseable         — answered items whose verdict couldn't be parsed

    abstention (over ALL items):
        rate                — abstained / total
        correctness         — of abstained items, fraction that were NOT
                              answerable (i.e. correct refusals)
        over_answer_rate    — of NOT-answerable items, fraction that were
                              answered anyway (the dangerous failure mode)
    """
    if k <= 0:
        raise ValueError("k must be >= 1")

    n_total = len(items)

    # ---- retrieval ----
    gold_bearing = [it for it in items if _normset(it.gold_citations)]
    precisions = [precision_at_k(it.retrieved_citations, it.gold_citations, k) for it in gold_bearing]
    recalls = [recall_at_k(it.retrieved_citations, it.gold_citations, k) for it in gold_bearing]
    hits = [hit_at_k(it.retrieved_citations, it.gold_citations, k) for it in gold_bearing]
    retrieval = {
        "n_scored": len(gold_bearing),
        "precision_at_k": _mean(precisions),
        "recall_at_k": _mean(recalls),
        "hit_rate_at_k": _mean([1.0 if h else 0.0 for h in hits]),
    }

    # ---- answer ----
    answered = [it for it in items if it.status == "answered"]
    parseable = [it for it in answered if it.predicted_answer is not None]
    correct = [it for it in parseable if it.predicted_answer == it.gold_answer]
    answer = {
        "n_answered": len(answered),
        "n_parseable": len(parseable),
        "n_unparseable": len(answered) - len(parseable),
        "accuracy": _ratio(len(correct), len(parseable)),
    }

    # ---- abstention ----
    abstained = [it for it in items if it.status == "abstained"]
    correct_abstentions = [it for it in abstained if not it.answerable]
    not_answerable = [it for it in items if not it.answerable]
    over_answered = [it for it in not_answerable if it.status == "answered"]
    answerable_items = [it for it in items if it.answerable]
    answerable_answered = [it for it in answerable_items if it.status == "answered"]
    abstention = {
        "n_abstained": len(abstained),
        "rate": _ratio(len(abstained), n_total),
        "n_correct_abstentions": len(correct_abstentions),
        "correctness": _ratio(len(correct_abstentions), len(abstained)),
        "n_not_answerable": len(not_answerable),
        "over_answer_rate": _ratio(len(over_answered), len(not_answerable)),
        "answer_coverage": _ratio(len(answerable_answered), len(answerable_items)),
    }

    return RunMetrics(
        k=k,
        n_total=n_total,
        retrieval=retrieval,
        answer=answer,
        abstention=abstention,
    )
