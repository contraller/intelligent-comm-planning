"""只读校验当前DEM元数据；缺失或无效时不回退演示区域。"""
from __future__ import annotations

import json
import math
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
MAX_METADATA_BYTES = 64 * 1024


def valid_bounds(value):
    return (isinstance(value, (list, tuple)) and len(value) == 4
        and all(type(item) in (int, float) for item in value)
        and -180 <= value[0] < value[2] <= 180 and -90 <= value[1] < value[3] <= 90
        and all(math.isfinite(item) for item in value))


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate metadata field")
        result[key] = value
    return result


def read_planning_bounds(metadata_path=None):
    """仅校验来源字段、哈希格式、坐标系及bbox，不读取栅格实体或验证其物理哈希。"""
    path = Path(metadata_path) if metadata_path is not None else ROOT / "data/raw/dem/dem_current.json"
    try:
        with path.open("rb") as stream:
            raw = stream.read(MAX_METADATA_BYTES + 1)
        if len(raw) > MAX_METADATA_BYTES:
            return None
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite metadata")))
        if (not isinstance(data, dict) or data.get("crs") != "EPSG:4326"
                or not isinstance(data.get("source_sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", data["source_sha256"])
                or not isinstance(data.get("source"), str) or not data["source"].strip()
                or not valid_bounds(data.get("bbox"))):
            return None
        return tuple(data["bbox"])
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        return None
