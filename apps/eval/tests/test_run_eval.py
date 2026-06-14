"""Tests for run_eval mapping + end-to-end scoring with a fake endpoint.

These avoid all network/HF access by injecting an `answer_fn` and stubbing the
dataset/manifest loaders, proving run_eval produces metrics.json with the three
metric families (acceptance criterion) deterministically.
"""

import json

import pytest

import run_eval
from config import Settings


def test_citation_tokens_parses_statute_idx():
    c = {"sourceId": "statute_431263__ALA-CODE-35", "url": "https://x/statute_431263"}
    assert run_eval.citation_tokens(c) == ["statute_431263"]


def test_citation_tokens_fallback_when_no_idx():
    c = {"url": "https://example.gov/some-page", "sourceTitle": "Some page"}
    assert run_eval.citation_tokens(c) == ["https://example.gov/some-page"]


def test_to_item_result_answered_in_corpus():
    q = {"idx": 7, "question": "q?", "answer": "Yes", "gold_statute_idxs": [100]}
    ans = {
        "status": "answered",
        "answerMarkdown": "Yes, the statute applies.",
        "citations": [{"sourceId": "statute_100__cite"}],
    }
    it = run_eval.to_item_result(q, ans, indexed_idxs={100}, holdout_idxs=set())
    assert it.status == "answered"
    assert it.predicted_answer == "yes"
    assert it.gold_answer == "yes"
    assert it.retrieved_citations == ["statute_100"]
    assert it.gold_citations == ["statute_100"]
    assert it.answerable is True


def test_to_item_result_holdout_is_not_answerable():
    q = {"idx": 7, "question": "q?", "answer": "No", "gold_statute_idxs": [100]}
    ans = {"status": "abstained", "citations": []}
    it = run_eval.to_item_result(q, ans, indexed_idxs={100}, holdout_idxs={7})
    assert it.answerable is False  # held out of corpus
    assert it.status == "abstained"


def test_run_end_to_end_with_fake_endpoint(tmp_path, monkeypatch):
    questions = [
        {"idx": 1, "question": "q1", "answer": "Yes", "gold_statute_idxs": [10]},
        {"idx": 2, "question": "q2", "answer": "No", "gold_statute_idxs": [20]},
    ]
    monkeypatch.setattr(run_eval.dataset, "load_cached", lambda *a, **k: questions)
    monkeypatch.setattr(run_eval.corpus_mod, "load_manifest", lambda: None)
    monkeypatch.setattr(run_eval, "OUT_DIR", tmp_path)

    def fake_answer(question_text, case_id):
        if question_text == "q1":
            return {
                "status": "answered",
                "answerMarkdown": "Yes, it is required.",
                "citations": [{"sourceId": "statute_10__cite"}],
            }
        return {
            "status": "answered",
            "answerMarkdown": "No, it is not.",
            "citations": [{"sourceId": "statute_20__cite"}],
        }

    settings = Settings.from_env()
    out = run_eval.run(
        settings,
        k=5,
        state="California",
        subset="questions",
        sample_size=2,
        seed=1,
        language="en",
        answer_fn=fake_answer,
    )

    # three metric families present
    for fam in ("retrieval", "answer", "abstention"):
        assert fam in out
    assert out["answer"]["accuracy"] == pytest.approx(1.0)
    assert out["retrieval"]["hit_rate_at_k"] == pytest.approx(1.0)

    # metrics.json + summary.md written with the families
    metrics_path = tmp_path / "metrics.json"
    summary_path = tmp_path / "summary.md"
    assert metrics_path.exists() and summary_path.exists()
    saved = json.loads(metrics_path.read_text())
    assert {"retrieval", "answer", "abstention"}.issubset(saved.keys())
    assert "2021" in summary_path.read_text()  # limitation stated
    assert "RegLab" in summary_path.read_text()  # dataset cited


def test_run_records_endpoint_errors(tmp_path, monkeypatch):
    questions = [{"idx": 1, "question": "q1", "answer": "Yes", "gold_statute_idxs": [10]}]
    monkeypatch.setattr(run_eval.dataset, "load_cached", lambda *a, **k: questions)
    monkeypatch.setattr(run_eval.corpus_mod, "load_manifest", lambda: None)
    monkeypatch.setattr(run_eval, "OUT_DIR", tmp_path)

    def boom(question_text, case_id):
        raise RuntimeError("endpoint down")

    out = run_eval.run(
        Settings.from_env(),
        k=5, state="CA", subset="questions", sample_size=1, seed=1, language="en",
        answer_fn=boom,
    )
    assert out["meta"]["n_errors"] == 1
    assert out["meta"]["n_scored"] == 0
