"""CSV data loading helpers for algorithm modules."""
from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = REPO_ROOT / "data"


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


@lru_cache(maxsize=16)
def candidate_sites() -> list[dict[str, str]]:
    return _read_csv(DATA_ROOT / "synthetic" / "nodes" / "candidate_sites_v1.csv")


@lru_cache(maxsize=16)
def nodes() -> list[dict[str, str]]:
    return _read_csv(DATA_ROOT / "synthetic" / "nodes" / "nodes_v1.csv")


@lru_cache(maxsize=16)
def task_scenarios() -> list[dict[str, str]]:
    return _read_csv(DATA_ROOT / "synthetic" / "tasks" / "task_scenarios_v1.csv")


def to_float(row: dict[str, Any], key: str, default: float = 0.0) -> float:
    value = row.get(key)
    if value in (None, ""):
        return default
    return float(value)
