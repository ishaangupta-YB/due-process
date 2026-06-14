"""Central configuration + safety guards for the offline eval.

All knobs come from environment variables so nothing sensitive is committed.
This module also holds the single most important safety check in the eval:
`assert_not_production`, which refuses to let any indexing/teardown operation
touch the live product AI Search instance.

This subproject is NEVER deployed to Workers; it only reads env and calls HTTP.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parent
DATA_DIR = EVAL_ROOT / "data"
OUT_DIR = EVAL_ROOT / "out"

# HuggingFace dataset coordinates (Stanford RegLab housing_qa).
HF_DATASET = "reglab/housing_qa"
DATASET_CITATION = (
    "Stanford RegLab, housing_qa (reglab/housing_qa), CC-BY-SA-4.0. "
    "A Reasoning-Focused Legal Retrieval Benchmark (CS&Law 2025). "
    "Statutes and answers are accurate only as of 2021 and are NOT legal advice."
)
DATASET_LIMITATION_2021 = (
    "LIMITATION: reglab/housing_qa is accurate only as of 2021 and is multi-state. "
    "These numbers measure the grounding pipeline's faithfulness against a 2021 "
    "controlled corpus, NOT the correctness of current California law. Do not "
    "present them as a statement about today's CA statutes."
)


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or unsafe."""


@dataclass(frozen=True)
class Settings:
    # Deployed grounding endpoint (the SAME pipeline the product uses), pointed
    # at the eval corpus. run_eval calls this over HTTP. No app/web import.
    grounding_endpoint_url: str | None
    grounding_timeout_s: float

    # Cloudflare AI Search REST credentials (index_eval_corpus only).
    cf_account_id: str | None
    cf_api_token: str | None

    # The throwaway EVAL instance/namespace. NEVER the production one.
    eval_namespace: str
    eval_instance: str

    # Production identifiers — used ONLY as a denylist so we can refuse to write
    # to them. We never read or write the production corpus from here.
    prod_namespace: str | None
    prod_instance: str | None

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            grounding_endpoint_url=os.getenv("GROUNDING_ENDPOINT_URL") or None,
            grounding_timeout_s=float(os.getenv("GROUNDING_TIMEOUT_S", "60")),
            cf_account_id=os.getenv("CF_ACCOUNT_ID") or None,
            cf_api_token=os.getenv("CF_API_TOKEN") or None,
            eval_namespace=os.getenv("EVAL_AISEARCH_NAMESPACE", "eval"),
            eval_instance=os.getenv("EVAL_AISEARCH_INSTANCE", "dueprocess-housingqa-eval"),
            prod_namespace=os.getenv("PROD_AISEARCH_NAMESPACE") or None,
            prod_instance=os.getenv("PROD_AISEARCH_INSTANCE") or None,
        )


def assert_not_production(settings: Settings) -> None:
    """Refuse to proceed if the eval target looks like the production corpus.

    This is a hard guardrail (root CLAUDE invariant + apps/eval rules): the eval
    must never index into or tear down the live product AI Search instance.
    """
    inst = settings.eval_instance.strip()
    ns = settings.eval_namespace.strip()

    if not inst:
        raise ConfigError("EVAL_AISEARCH_INSTANCE must be set to a non-empty value.")

    if settings.prod_instance and inst == settings.prod_instance.strip():
        raise ConfigError(
            f"Refusing to run: eval instance '{inst}' equals PROD_AISEARCH_INSTANCE."
        )
    if (
        settings.prod_namespace
        and ns == settings.prod_namespace.strip()
        and settings.prod_instance
        and inst == settings.prod_instance.strip()
    ):
        raise ConfigError(
            "Refusing to run: eval namespace+instance equal the production pair."
        )

    # Belt-and-suspenders: a bare "prod"/"production" token in the instance id is
    # almost certainly a misconfiguration for a throwaway eval target.
    lowered = inst.lower()
    if any(tok in lowered for tok in ("prod", "production", "live")):
        raise ConfigError(
            f"Refusing to run: eval instance '{inst}' contains a production-looking "
            "token. Use a clearly throwaway name (e.g. 'dueprocess-housingqa-eval')."
        )


def require(value: str | None, name: str) -> str:
    if not value:
        raise ConfigError(f"Missing required configuration: {name}")
    return value
