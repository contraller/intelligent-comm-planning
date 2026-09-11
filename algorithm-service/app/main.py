"""FastAPI entrypoint for the algorithm service."""
from __future__ import annotations

from typing import Any

from .candidate_sites import filter_candidate_sites

try:
    from fastapi import FastAPI
except ImportError as exc:  # pragma: no cover - exercised only without runtime deps
    raise RuntimeError(
        "FastAPI is not installed. Run: pip install -r algorithm-service/requirements.txt"
    ) from exc


app = FastAPI(title="短波/超短波智能规划算法服务", version="0.1.0")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"code": 0, "message": "success", "data": {"status": "ok"}}


@app.post("/api/v1/plan/candidate-sites")
def candidate_sites(payload: dict[str, Any]) -> dict[str, Any]:
    return filter_candidate_sites(payload)
