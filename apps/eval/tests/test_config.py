"""Tests for the production-namespace safety guard."""

import dataclasses

import pytest

from config import ConfigError, Settings, assert_not_production


def _settings(**overrides) -> Settings:
    base = Settings(
        grounding_endpoint_url=None,
        grounding_timeout_s=60.0,
        cf_account_id="acct",
        cf_api_token="tok",
        eval_namespace="eval",
        eval_instance="dueprocess-housingqa-eval",
        prod_namespace="default",
        prod_instance="dueprocess-prod",
    )
    return dataclasses.replace(base, **overrides)


def test_allows_clean_eval_instance():
    assert_not_production(_settings())  # should not raise


def test_refuses_when_equals_prod_instance():
    with pytest.raises(ConfigError):
        assert_not_production(_settings(eval_instance="dueprocess-prod"))


def test_refuses_production_looking_token():
    for name in ("my-prod-rag", "dueprocess-production", "live-corpus"):
        with pytest.raises(ConfigError):
            assert_not_production(_settings(eval_instance=name, prod_instance=None))


def test_refuses_empty_instance():
    with pytest.raises(ConfigError):
        assert_not_production(_settings(eval_instance="  "))
