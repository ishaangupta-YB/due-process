"""Unit tests for the pure scoring functions.

Expected values are computed by hand in the comments so the metrics are pinned
and reproducible (apps/eval rule: scoring is pure & unit-tested).
"""

import math

import pytest

from scoring import (
    ItemResult,
    extract_yes_no,
    hit_at_k,
    normalize_citation,
    normalize_yes_no,
    precision_at_k,
    recall_at_k,
    score_items,
)


def approx(x):
    return pytest.approx(x, rel=1e-6, abs=1e-9)


# --------------------------- normalization --------------------------------- #

def test_normalize_citation_ignores_cosmetics():
    a = normalize_citation("ALA. CODE § 35-9A-141(11)")
    b = normalize_citation("  ala. code   §  35-9a-141(11)  ")
    assert a == b
    assert normalize_citation("statute_431263") == "statute_431263"


def test_normalize_citation_distinguishes_real_differences():
    assert normalize_citation("CAL. CIV. § 1942") != normalize_citation("CAL. CIV. § 1946")


# --------------------------- retrieval ------------------------------------- #

def test_precision_at_k_basic():
    retrieved = ["statute_1", "statute_2", "statute_3"]
    gold = ["statute_1", "statute_3"]
    # top-2 = [s1, s2] -> 1 hit / 2
    assert precision_at_k(retrieved, gold, 2) == approx(0.5)
    # top-3 = [s1, s2, s3] -> 2 hits / 3
    assert precision_at_k(retrieved, gold, 3) == approx(2 / 3)


def test_precision_empty_retrieved_is_zero():
    assert precision_at_k([], ["statute_1"], 5) == 0.0


def test_recall_at_k_basic():
    retrieved = ["statute_2", "statute_1"]
    gold = ["statute_1", "statute_3"]  # 2 gold, 1 found in top-5
    assert recall_at_k(retrieved, gold, 5) == approx(0.5)


def test_recall_no_gold_is_zero():
    assert recall_at_k(["statute_1"], [], 5) == 0.0


def test_hit_at_k():
    assert hit_at_k(["statute_9", "statute_1"], ["statute_1"], 5) is True
    assert hit_at_k(["statute_9"], ["statute_1"], 5) is False


def test_k_must_be_positive():
    with pytest.raises(ValueError):
        precision_at_k(["a"], ["a"], 0)
    with pytest.raises(ValueError):
        recall_at_k(["a"], ["a"], -1)


def test_duplicate_retrieved_collapsed_before_top_k():
    # dedup happens before the window: top-2 of [s1,s1,s2] is [s1,s2].
    assert precision_at_k(["statute_1", "statute_1", "statute_2"], ["statute_2"], 2) == approx(0.5)


# --------------------------- yes/no ---------------------------------------- #

@pytest.mark.parametrize(
    "text,expected",
    [
        ("Yes, the statute requires it.", "yes"),
        ("No. The law does not.", "no"),
        ("Yes and no, but mostly yes.", "yes"),  # first signal wins
        ("The statute is silent on this.", None),
        ("", None),
        (None, None),
    ],
)
def test_extract_yes_no(text, expected):
    assert extract_yes_no(text) == expected


@pytest.mark.parametrize(
    "value,expected",
    [("Yes", "yes"), ("no", "no"), ("TRUE", "yes"), ("maybe", None), (None, None)],
)
def test_normalize_yes_no(value, expected):
    assert normalize_yes_no(value) == expected


# --------------------------- aggregate ------------------------------------- #

def _items():
    return [
        # 1: answered, correct, retrieval hit, in-corpus
        ItemResult("1", "answered", "yes", "yes", ["statute_1", "statute_9"], ["statute_1"], True),
        # 2: answered, wrong, retrieval hit, in-corpus
        ItemResult("2", "answered", "no", "yes", ["statute_2"], ["statute_2"], True),
        # 3: abstained, out-of-corpus -> correct abstention
        ItemResult("3", "abstained", "yes", None, [], ["statute_3"], False),
        # 4: abstained, in-corpus -> incorrect abstention
        ItemResult("4", "abstained", "no", None, [], ["statute_4"], True),
        # 5: answered, unparseable verdict, retrieval hit, in-corpus
        ItemResult("5", "answered", "yes", None, ["statute_5"], ["statute_5"], True),
        # 6: answered despite out-of-corpus -> over-answer, retrieval miss
        ItemResult("6", "answered", "no", "no", ["statute_99"], ["statute_6"], False),
    ]


def test_score_items_retrieval():
    m = score_items(_items(), k=5)
    assert m.n_total == 6
    r = m.retrieval
    assert r["n_scored"] == 6
    assert r["precision_at_k"] == approx(2.5 / 6)
    assert r["recall_at_k"] == approx(0.5)
    assert r["hit_rate_at_k"] == approx(0.5)


def test_score_items_answer():
    a = score_items(_items(), k=5).answer
    assert a["n_answered"] == 4
    assert a["n_parseable"] == 3
    assert a["n_unparseable"] == 1
    assert a["accuracy"] == approx(2 / 3)


def test_score_items_abstention():
    ab = score_items(_items(), k=5).abstention
    assert ab["n_abstained"] == 2
    assert ab["rate"] == approx(2 / 6)
    assert ab["n_correct_abstentions"] == 1
    assert ab["correctness"] == approx(0.5)
    assert ab["n_not_answerable"] == 2
    assert ab["over_answer_rate"] == approx(0.5)
    assert ab["answer_coverage"] == approx(0.75)


def test_undefined_ratios_are_none_not_zero():
    # All items answerable + answered: no abstentions, no out-of-corpus.
    items = [
        ItemResult("1", "answered", "yes", "yes", ["statute_1"], ["statute_1"], True),
        ItemResult("2", "answered", "no", "no", ["statute_2"], ["statute_2"], True),
    ]
    ab = score_items(items, k=5).abstention
    assert ab["rate"] == approx(0.0)
    assert ab["correctness"] is None          # no abstentions -> undefined
    assert ab["over_answer_rate"] is None      # no out-of-corpus -> undefined
    assert ab["answer_coverage"] == approx(1.0)


def test_metrics_to_dict_has_three_families():
    d = score_items(_items(), k=5).to_dict()
    assert set(["retrieval", "answer", "abstention"]).issubset(d.keys())
    assert math.isclose(d["k"], 5)
