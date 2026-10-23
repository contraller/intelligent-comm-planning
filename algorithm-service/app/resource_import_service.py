"""预检只读，提交在底座写锁内重验文件、版本及内容签名。"""
import base64
import binascii
from copy import deepcopy
import hashlib
from pathlib import PureWindowsPath

from . import resource_dataset_service as datasets
from . import resource_workspace_service as workspace
from . import resource_candidate_service as candidates
from .resource_export_service import HEADERS, TABLES
from .resource_import_parser import make_template, parse_import
from . import resource_geography as geography

MAX_BYTES = 5 * 1024 * 1024


def decode_file(request):
    name = request.file.name
    if PureWindowsPath(name).name != name or "/" in name or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        workspace.fail("文件名不得包含路径或控制字符")
    try:
        data = base64.b64decode(request.file.base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise datasets.ResourceDatasetError("文件内容不是有效的 Base64", 1001, 422) from exc
    if not data or len(data) > MAX_BYTES:
        workspace.fail("文件必须非空且不超过 5 MiB")
    return data


def signature(request, data):
    return datasets.content_hash({"operation": "resource-import-v1", "context": request.context,
        "base_revision": request.base_revision, "kind": request.kind, "file_name": request.file.name,
        "file_sha256": hashlib.sha256(data).hexdigest()})


def _parse(snapshot, request, data, bounds=None):
    if request.kind == "topology_links":
        parsed = candidates.parse_candidate_import(snapshot, request.file.name, data)
        candidate = deepcopy(snapshot)
        if not parsed["issues"]:
            candidate[candidates.SNAPSHOT_KEY] = parsed["links"]
        return parsed, candidate
    parsed = parse_import(snapshot["tables"], request.file.name, data, request.kind, bounds)
    candidate = {**deepcopy(snapshot), "tables": parsed["tables"]}
    # 有错误的候选不能投影为可应用资源；差异和逐行错误仍完整返回。
    if parsed["issues"]:
        candidate = deepcopy(snapshot)
    else:
        for result in parsed["rows"]:
            if result["action"] == "UNCHANGED":
                continue
            row = next(row for row in candidate["tables"][TABLES[result["sheet"]]]
                if row[HEADERS[result["sheet"]][0]] == result["id"])
            row["origin"] = "IMPORT"
    return parsed, candidate


def preview(request):
    data = decode_file(request)
    snapshot = workspace.require_snapshot(request.base_revision)
    bounds = geography.read_planning_bounds()
    parsed, candidate = _parse(snapshot, request, data, bounds)
    return {"base_revision": request.base_revision, "context": request.context, "kind": request.kind,
        "file_name": request.file.name, "signature": signature(request, data), "valid": not bool(parsed["issues"]),
        "rows": parsed["rows"], "issues": parsed["issues"], "warnings": parsed["warnings"],
        "candidate": workspace.resources(candidate, bounds), "changes": workspace.changes_between(snapshot, candidate)}


def commit(request, actor_id):
    data = decode_file(request)
    expected = signature(request, data)
    if request.signature != expected:
        workspace.fail("预检签名与文件、类型或版本不一致，请重新预检", 1206, 409)

    def apply(snapshot):
        # 签名只绑定输入，不代替业务校验；真正写入前始终重新解析。
        parsed, candidate = _parse({**snapshot, "revision": request.base_revision}, request, data,
            geography.read_planning_bounds())
        if parsed["issues"]:
            workspace.fail("导入校验未通过：" + parsed["issues"][0]["message"])
        links_changed = candidates.get_links(candidate) != candidates.get_links(snapshot)
        changed = candidate["tables"] != snapshot["tables"] or links_changed
        affected = sorted({row["id"] for row in parsed["rows"] if row["action"] != "UNCHANGED"})
        snapshot["tables"] = candidate["tables"]
        if links_changed:
            snapshot[candidates.SNAPSHOT_KEY] = candidate[candidates.SNAPSHOT_KEY]
        return changed, {"object_id": "resource-import", "affected_ids": affected, "warnings": parsed["warnings"]}

    receipt = datasets.commit_device_change(request.base_revision, request.request_id,
        datasets.content_hash({"operation": "resource-import-commit", "signature": expected}), actor_id, apply)
    return workspace.result_for_receipt(receipt)


def template(query):
    snapshot = workspace.require_snapshot(query.revision)
    if query.kind == "topology_links":
        return candidates.make_candidate_template(snapshot, query.format)
    return make_template(snapshot["tables"], query.format, query.kind)
