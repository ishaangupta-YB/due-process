"""FastAPI wrapper for the offline eval (convenience/inspection only).

The real logic lives in the plain scripts (dataset.py / index_eval_corpus.py /
run_eval.py / scoring.py) so the eval can run headless. This app just exposes
them over HTTP for manual inspection:

  - POST /dataset/prepare  -> download/filter/sample/cache housing_qa
  - POST /eval/run         -> run the controlled eval, write metrics
  - GET  /eval/metrics     -> return the latest written metrics

This server is NEVER deployed to Cloudflare Workers (apps/eval rule). It runs on
the operator's machine. Endpoints are sync (`def`) so FastAPI runs the blocking
dataset/HTTP work in a threadpool.

Run locally:  uvicorn api:app --reload --port 8000
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import dataset
import run_eval
from config import OUT_DIR, ConfigError, Settings

app = FastAPI(title="DueProcess eval", version="0.1.0")


class PrepareRequest(BaseModel):
    subset: str = Field(default="questions", pattern="^(questions|questions_aux)$")
    state: Optional[str] = "California"
    sample_size: Optional[int] = 50
    seed: int = 1234


class PrepareResponse(BaseModel):
    ok: bool
    subset: str
    state: Optional[str]
    sample_size: Optional[int]
    n_records: int


class RunRequest(BaseModel):
    k: int = 5
    subset: str = Field(default="questions", pattern="^(questions|questions_aux)$")
    state: Optional[str] = "California"
    sample_size: Optional[int] = 50
    seed: int = 1234
    language: str = "en"


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/dataset/prepare", response_model=PrepareResponse)
def dataset_prepare(req: PrepareRequest) -> PrepareResponse:
    try:
        records = dataset.prepare_questions(
            subset=req.subset,
            state=req.state,
            sample_size=req.sample_size,
            seed=req.seed,
        )
    except Exception as exc:  # surface real failure, do not pretend success
        raise HTTPException(status_code=500, detail=f"prepare failed: {exc}") from exc
    return PrepareResponse(
        ok=True,
        subset=req.subset,
        state=req.state,
        sample_size=req.sample_size,
        n_records=len(records),
    )


@app.post("/eval/run")
def eval_run(req: RunRequest) -> dict:
    settings = Settings.from_env()
    try:
        out = run_eval.run(
            settings,
            k=req.k,
            state=req.state,
            subset=req.subset,
            sample_size=req.sample_size,
            seed=req.seed,
            language=req.language,
        )
    except ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"eval run failed: {exc}") from exc
    return {"ok": True, **out}


@app.get("/eval/metrics")
def eval_metrics() -> dict:
    path = OUT_DIR / "metrics.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No metrics yet. Run POST /eval/run first.")
    return {"ok": True, **json.loads(path.read_text())}
