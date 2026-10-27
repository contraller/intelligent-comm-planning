"""Small atomic JSON store for restart-safe algorithm results."""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        # Windows读句柄或安全扫描可能短暂占用目标；保持原子替换，有限重试后仍报告错误。
        for attempt in range(5):
            try:
                temp.replace(path)
                break
            except PermissionError as exc:
                if getattr(exc, "winerror", None) not in (5, 32, 33) or attempt == 4:
                    raise
                time.sleep(.01 * 2 ** attempt)
    finally:
        temp.unlink(missing_ok=True)


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)
