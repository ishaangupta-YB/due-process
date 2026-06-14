"""Push the housing_qa `statutes` subset into a SEPARATE eval AI Search instance.

Safety (apps/eval rule + root CLAUDE invariant): this NEVER touches the live
production corpus. `config.assert_not_production` is called before any write and
refuses production-looking targets.

Why a curated subset and not all 1.7M statutes:
  Indexing the entire corpus is infeasible and unnecessary for a controlled
  retrieval eval. We index (a) every GOLD statute referenced by the sampled
  questions — so retrieval *can* hit them — plus (b) optional distractor
  statutes from the same state(s), so precision is meaningful. This is the
  standard controlled-retrieval setup and is documented in the run summary.

Transport: Cloudflare AI Search REST API over HTTPS (httpx). This is plain HTTP;
nothing here is a Worker and nothing imports apps/web.

Docs followed:
  - Create instance:  POST /accounts/{acct}/ai-search/[namespaces/{ns}/]instances
  - Upload item:      POST .../instances/{id}/items   (multipart file=...)
  - Trigger sync:     POST .../instances/{id}/jobs
  - Stats / delete:   GET .../instances/{id}/stats , DELETE .../instances/{id}
  (https://developers.cloudflare.com/ai-search/api/...)
"""

from __future__ import annotations

import argparse
import json
import random
import re
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from config import DATA_DIR, ConfigError, Settings, assert_not_production, require
import dataset

CF_API_BASE = "https://api.cloudflare.com/client/v4"

# Records exactly what got indexed so run_eval can judge which questions were
# answerable from the corpus (for abstention-correctness). Written by index_corpus.
MANIFEST_PATH = DATA_DIR / "eval_corpus_manifest.json"


# --------------------------------------------------------------------------- #
# Corpus construction                                                         #
# --------------------------------------------------------------------------- #

def build_eval_corpus(
    questions: list[dict[str, Any]],
    *,
    distractors_per_state: int = 0,
    seed: int = 1234,
) -> list[dict[str, Any]]:
    """Gold statutes for `questions` + optional same-state distractors."""
    gold_idxs = dataset.gold_statute_idxs(questions)
    corpus = dataset.select_statutes_by_idx(gold_idxs)

    if distractors_per_state > 0:
        states = sorted({q.get("state") for q in questions if q.get("state")})
        have = {s["idx"] for s in corpus}
        for state in states:
            extra = dataset.prepare_statutes(
                state=state, sample_size=distractors_per_state, seed=seed, cache=False
            )
            for s in extra:
                if s["idx"] not in have:
                    corpus.append(s)
                    have.add(s["idx"])
    return corpus


def partition_holdout(
    questions: list[dict[str, Any]],
    *,
    holdout_frac: float,
    seed: int = 1234,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split questions into (to_index, holdout).

    The holdout's gold statutes are deliberately NOT indexed, making those
    questions genuinely out-of-corpus. This is the ONLY honest way to measure
    abstention correctness: a correct abstention is one on a holdout question.
    Deterministic given `seed`.
    """
    if not (0.0 <= holdout_frac < 1.0):
        raise ValueError("holdout_frac must be in [0, 1)")
    if holdout_frac == 0.0 or len(questions) < 2:
        return list(questions), []
    rng = random.Random(seed)
    order = list(range(len(questions)))
    rng.shuffle(order)
    n_hold = int(round(len(questions) * holdout_frac))
    hold_idx = set(order[:n_hold])
    to_index = [q for i, q in enumerate(questions) if i not in hold_idx]
    holdout = [q for i, q in enumerate(questions) if i in hold_idx]
    return to_index, holdout


def write_manifest(
    corpus: list[dict[str, Any]],
    holdout_questions: list[dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Persist what was indexed + which questions were held out-of-corpus."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "params": params,
        "indexed_statute_idxs": sorted(
            {s["idx"] for s in corpus if s.get("idx") is not None}
        ),
        "holdout_question_idxs": sorted(
            {q["idx"] for q in holdout_questions if q.get("idx") is not None}
        ),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def load_manifest() -> Optional[dict[str, Any]]:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return None


_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def statute_filename(statute: dict[str, Any]) -> str:
    """Deterministic filename that encodes the statute idx for back-mapping.

    Format: ``statute_<idx>__<safe-citation>.txt``. run_eval parses the idx and
    citation back out of returned Citation fields to score retrieval.
    """
    idx = statute.get("idx")
    cite = _SAFE.sub("-", (statute.get("citation") or "uncited")).strip("-")[:80]
    return f"statute_{idx}__{cite}.txt"


def statute_document(statute: dict[str, Any]) -> tuple[str, bytes]:
    """Render a statute to (filename, utf-8 bytes) for indexing.

    A small header keeps the citation + idx recoverable from the indexed text
    itself, in addition to the filename.
    """
    header = (
        f"STATUTE_IDX: {statute.get('idx')}\n"
        f"CITATION: {statute.get('citation')}\n"
        f"STATE: {statute.get('state')}\n"
        f"PATH: {statute.get('path')}\n"
        f"---\n"
    )
    body = statute.get("text") or ""
    return statute_filename(statute), (header + body).encode("utf-8")


# --------------------------------------------------------------------------- #
# AI Search REST client                                                       #
# --------------------------------------------------------------------------- #

@dataclass
class AISearchClient:
    account_id: str
    api_token: str
    instance: str
    namespace: Optional[str] = None
    timeout_s: float = 120.0

    def _base(self) -> str:
        if self.namespace:
            return (
                f"{CF_API_BASE}/accounts/{self.account_id}"
                f"/ai-search/namespaces/{self.namespace}"
            )
        return f"{CF_API_BASE}/accounts/{self.account_id}/ai-search"

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_token}"}

    def create_instance(self, client: httpx.Client) -> dict[str, Any]:
        """Create the eval instance (built-in storage). Idempotent-ish: a
        409/'already exists' is treated as success."""
        url = f"{self._base()}/instances"
        resp = client.post(url, headers=self._headers(), json={"id": self.instance})
        if resp.status_code in (200, 201):
            return resp.json()
        body = resp.text.lower()
        if resp.status_code == 409 or "exist" in body:
            return {"success": True, "note": "instance already exists"}
        resp.raise_for_status()
        return resp.json()

    def upload_item(self, client: httpx.Client, filename: str, content: bytes) -> dict[str, Any]:
        url = f"{self._base()}/instances/{self.instance}/items"
        files = {"file": (filename, content, "text/plain")}
        resp = client.post(url, headers=self._headers(), files=files)
        resp.raise_for_status()
        return resp.json()

    def trigger_sync(self, client: httpx.Client) -> dict[str, Any]:
        url = f"{self._base()}/instances/{self.instance}/jobs"
        resp = client.post(url, headers=self._headers())
        resp.raise_for_status()
        return resp.json()

    def stats(self, client: httpx.Client) -> dict[str, Any]:
        url = f"{self._base()}/instances/{self.instance}/stats"
        resp = client.get(url, headers=self._headers())
        resp.raise_for_status()
        return resp.json()

    def delete_instance(self, client: httpx.Client) -> dict[str, Any]:
        url = f"{self._base()}/instances/{self.instance}"
        resp = client.delete(url, headers=self._headers())
        resp.raise_for_status()
        return resp.json()


def index_corpus(
    settings: Settings,
    corpus: list[dict[str, Any]],
    *,
    trigger_sync: bool = True,
) -> dict[str, Any]:
    """Create the eval instance and upload every statute, then sync.

    Returns a small report dict. Raises on hard failures (never silently
    fabricates success).
    """
    assert_not_production(settings)  # hard guardrail
    account_id = require(settings.cf_account_id, "CF_ACCOUNT_ID")
    api_token = require(settings.cf_api_token, "CF_API_TOKEN")

    client_obj = AISearchClient(
        account_id=account_id,
        api_token=api_token,
        instance=settings.eval_instance,
        namespace=settings.eval_namespace or None,
    )

    uploaded = 0
    errors: list[str] = []
    with httpx.Client(timeout=settings.grounding_timeout_s or 120.0) as client:
        client_obj.create_instance(client)
        for statute in corpus:
            filename, content = statute_document(statute)
            try:
                client_obj.upload_item(client, filename, content)
                uploaded += 1
            except httpx.HTTPError as exc:  # report, never swallow into a fake metric
                errors.append(f"{filename}: {exc}")
        sync = client_obj.trigger_sync(client) if trigger_sync else None

    return {
        "instance": settings.eval_instance,
        "namespace": settings.eval_namespace,
        "documents_total": len(corpus),
        "documents_uploaded": uploaded,
        "upload_errors": errors,
        "sync_triggered": bool(trigger_sync),
        "sync": sync,
    }


def teardown(settings: Settings) -> dict[str, Any]:
    """Delete the throwaway eval instance (apps/eval rule: tear down after)."""
    assert_not_production(settings)
    account_id = require(settings.cf_account_id, "CF_ACCOUNT_ID")
    api_token = require(settings.cf_api_token, "CF_API_TOKEN")
    client_obj = AISearchClient(
        account_id=account_id,
        api_token=api_token,
        instance=settings.eval_instance,
        namespace=settings.eval_namespace or None,
    )
    with httpx.Client(timeout=60.0) as client:
        return client_obj.delete_instance(client)


# --------------------------------------------------------------------------- #
# CLI                                                                         #
# --------------------------------------------------------------------------- #

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", default="California", help="Filter questions by state.")
    parser.add_argument("--subset", default="questions", choices=["questions"])
    parser.add_argument("--sample-size", type=int, default=50)
    parser.add_argument("--distractors-per-state", type=int, default=0)
    parser.add_argument(
        "--holdout-frac",
        type=float,
        default=0.0,
        help="Fraction of questions whose gold is left OUT of the corpus "
        "(genuinely out-of-corpus) to measure abstention correctness.",
    )
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--no-sync", action="store_true", help="Skip the sync job.")
    parser.add_argument("--teardown", action="store_true", help="Delete the eval instance and exit.")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    try:
        if args.teardown:
            print(teardown(settings))
            return 0

        questions = dataset.prepare_questions(
            subset=args.subset,
            state=args.state,
            sample_size=args.sample_size,
            seed=args.seed,
        )
        to_index, holdout = partition_holdout(
            questions, holdout_frac=args.holdout_frac, seed=args.seed
        )
        corpus = build_eval_corpus(
            to_index,
            distractors_per_state=args.distractors_per_state,
            seed=args.seed,
        )
        if not corpus:
            print("No statutes to index (no gold statute idxs in sampled questions).")
            return 1
        params = {
            "subset": args.subset,
            "state": args.state,
            "sample_size": args.sample_size,
            "seed": args.seed,
            "holdout_frac": args.holdout_frac,
            "distractors_per_state": args.distractors_per_state,
        }
        manifest = write_manifest(corpus, holdout, params)
        report = index_corpus(settings, corpus, trigger_sync=not args.no_sync)
        report["manifest"] = {
            "indexed_statutes": len(manifest["indexed_statute_idxs"]),
            "holdout_questions": len(manifest["holdout_question_idxs"]),
        }
        print(report)
        return 0
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
