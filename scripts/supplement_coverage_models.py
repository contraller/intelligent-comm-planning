"""显式补充隔离联调库的接收假设；新增资源版本，不改原型号或旧方案。"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
PROFILE = ROOT / "data/supplements/coverage_rx_bandwidth_v1.json"
ORIGIN = "SYNTHETIC_COVERAGE_ASSUMPTION"
SOURCE_ID = "R5-HF-RX-3KHZ-V1"
MODEL_NAMES = {"DM-0001": "AN/PRC-150(C)", "DM-0002": "RF-7800H-MP",
               "DM-0003": "RF-5800H-MP", "DM-0008": "FT-891"}


def load_profile():
    """资料摘要按实际字节冻结，补充值不冒充原手册参数。"""
    if PROFILE.resolve() != PROFILE or PROFILE.is_symlink():
        raise ValueError("补充资料不能使用符号链接")
    raw = PROFILE.read_bytes()
    if len(raw) > 128 * 1024 or raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("补充资料须为128KiB内UTF-8无BOM文件")
    def unique_pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("补充资料存在重复字段")
            result[key] = value
        return result

    profile = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs)
    if (not isinstance(profile, dict) or type(profile.get("schema_version")) is not int or profile["schema_version"] != 1
            or profile.get("supplement_id") != SOURCE_ID or profile.get("data_origin") != ORIGIN
            or profile.get("unit") != "kHz" or not isinstance(profile.get("notice"), str)
            or not 1 <= len(profile["notice"]) <= 1000
            or not isinstance(profile.get("basis"), list) or not profile["basis"]
            or any(not isinstance(value, str) or not value.strip() for value in profile["basis"])):
        raise ValueError("构造接收假设资料的身份、单位或说明无效")
    rows = profile.get("models")
    if not isinstance(rows, list) or len(rows) != len(MODEL_NAMES):
        raise ValueError("补充资料仅允许本批四个HF型号")
    values = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("补充型号结构无效")
        mid, value = row.get("model_id"), row.get("value_khz")
        if (mid not in MODEL_NAMES or mid in values or row.get("model_name") != MODEL_NAMES[mid]
                or row.get("device_class") != "HF" or type(value) not in (int, float)
                or not math.isfinite(value) or value != 3):
            raise ValueError("补充型号或3kHz构造假设与本批批准范围不符")
        values[mid] = str(int(value))
    return profile, hashlib.sha256(raw).hexdigest(), values


def validate_database(runtime_root, database_url):
    """只允许已有配套隔离库，不能因路径写错创建空库或连接原5183库。"""
    from sqlalchemy.engine import make_url

    try:
        runtime = Path(runtime_root)
        url = make_url(database_url)
        database = Path(url.database or "")
        if (not runtime.is_absolute() or runtime.resolve() != runtime
                or runtime.parent != ROOT / "data/runtime/r2"
                or not re.fullmatch(r"r[45]-[A-Za-z0-9_-]+", runtime.name) or not runtime.is_dir()
                or url.drivername != "sqlite" or url.query or not database.is_absolute()
                or database.resolve() != database or database.parent != ROOT / "data/runtime/tmp" / runtime.name
                or not database.is_file()):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("仅接受显式本树r4/r5运行目录及配套已存在SQLite隔离库") from None
    return database


def supplement_models(base_revision, request_id, actor_id, *, apply=False):
    from app import resource_dataset_service as datasets

    if (not isinstance(base_revision, str) or not re.fullmatch(r"resource-[a-f0-9]{16}", base_revision)
            or any(not isinstance(value, str) or not 1 <= len(value) <= 120
                   or any(ord(char) < 32 or ord(char) == 127 for char in value)
                   for value in (request_id, actor_id))):
        raise ValueError("须显式提供有效基准版本、请求号和离线操作者标识")
    profile, digest, values = load_profile()

    def changes(snapshot):
        models = {row["model_id"]: row for row in snapshot["tables"]["device_model.csv"]}
        # 先完整核对，再写四行；原值已有内容或已有来源标记时禁止静默覆盖。
        for mid in values:
            row = models.get(mid)
            if (row is None or row.get("model_name") != MODEL_NAMES[mid]
                    or row.get("device_class") != "HF" or row.get("bandwidth_khz", "").strip()
                    or any(key.startswith("bandwidth_") and key != "bandwidth_khz" for key in row)):
                raise datasets.ResourceDatasetError("型号已变化或已补充，未覆盖：" + mid, 1205, 409)
        for mid, value in values.items():
            models[mid].update(bandwidth_khz=value, bandwidth_origin=ORIGIN,
                bandwidth_source_id=SOURCE_ID, bandwidth_source_sha256=digest,
                bandwidth_source_note=profile["notice"], bandwidth_original_khz="")
        return True, {"supplement_id": SOURCE_ID, "data_origin": ORIGIN,
            "source_sha256": digest, "model_ids": sorted(values), "applied_model_count": len(values),
            "notice": profile["notice"], "device_configuration_verified": False}

    if not apply:
        current = datasets.current()
        if current["revision"] != base_revision:
            raise datasets.ResourceDatasetError("资源版本已变化，预览未执行", 1205, 409)
        _, receipt = changes(current)
        return {**receipt, "changed": False, "preview_only": True, "revision": base_revision}
    body = {"operation": "coverage-model-supplement-v1", "base_revision": base_revision,
            "supplement_id": SOURCE_ID, "source_sha256": digest}
    return datasets.commit_device_change(base_revision, request_id, datasets.content_hash(body), actor_id, changes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--base-revision", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--actor-id", required=True)
    parser.add_argument("--apply", action="store_true", help="默认只预览；此选项显式新增资源版本")
    args = parser.parse_args()
    validate_database(args.runtime_root, args.database_url)
    os.environ["DATABASE_URL"] = args.database_url
    os.environ["RESOURCE_DATASET_MODE"] = "database"
    result = supplement_models(args.base_revision, args.request_id, args.actor_id, apply=args.apply)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
