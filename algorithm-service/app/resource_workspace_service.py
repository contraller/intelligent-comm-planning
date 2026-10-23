"""完整编辑投影与原子增量保存，共用既有不可变资源底座。"""
from copy import deepcopy
import csv
from io import StringIO
import math
import re
import json

from sqlalchemy import select

from . import frontend_integration as frontend, resource_dataset_service as datasets
from .planning_plan_models import PlanningPlan
from .resource_dataset_models import ResourceDatasetVersion
from .resource_export_service import HEADERS, TABLES
from . import resource_candidate_service as candidates
from . import resource_geography as geography

_CURRENT_BOUNDS = object()

NODE_FIELDS = {"name": "node_name", "coordinate": None, "elevationM": "elevation_m",
               "region": "region", "remark": "remark"}
DEVICE_FIELDS = {"antennaHeightM": "antenna_height_m", "txPowerDbm": "tx_power_dbm", "workFreqKhz": "work_freq_khz"}
INTERFERENCE_FIELDS = {"name": "name", "coordinate": None, "elevationM": "elevation_m",
    "antennaHeightM": "antenna_height_m", "centerFreqKhz": "center_freq_khz", "bandwidthKhz": "bandwidth_khz",
    "txPowerDbm": "tx_power_dbm", "antennaGainDbi": "antenna_gain_dbi", "interferenceType": "interference_type",
    "patternType": "pattern_type", "azimuthDeg": "azimuth_deg", "dutyCycle": "duty_cycle", "active": "active"}
NEW_NODE_FIELDS = {**NODE_FIELDS, "echelon": "echelon", "subtype": "node_subtype", "role": "node_role",
    "parentIds": "parent_node_id", "mobility": "mobility", "classes": "device_class", "relayCapable": "relay_capable", "key": "is_key"}
NEW_DEVICE_FIELDS = {**DEVICE_FIELDS, "stationId": "node_id", "modelId": "model_id", "antennaId": "antenna_id",
    "tiltDeg": "tilt_deg", "azimuthDeg": "azimuth_deg", "installedAt": "install_time"}


def fail(message, code=1001, status=422):
    raise datasets.ResourceDatasetError(message, code, status)


def require_snapshot(revision=None):
    if not datasets.database_mode():
        fail("资源编辑仅支持数据库模式", 5003, 503)
    snapshot = datasets.current()
    if revision is not None and snapshot["revision"] != revision:
        fail("资源版本已变化，请刷新后重新操作", 1205, 409)
    return snapshot


def resources(snapshot, planning_bounds=_CURRENT_BOUNDS):
    if planning_bounds is _CURRENT_BOUNDS:
        planning_bounds = geography.read_planning_bounds()
    tables = snapshot["tables"]
    nodes, devices = tables["node.csv"], tables["device.csv"]
    models, antennas = tables["device_model.csv"], tables["antenna_model.csv"]
    stations = []
    for row in nodes:
        status = frontend._status(row.get("status"))
        stations.append({"id": row["node_id"], "name": row["node_name"], "echelon": row["echelon"],
            "subtype": row.get("node_subtype", ""), "role": row.get("node_role", ""),
            "parentIds": list(filter(None, row.get("parent_node_id", "").split(";"))),
            "coordinate": [float(row["lon"]), float(row["lat"])], "elevationM": frontend._optional_number(row.get("elevation_m")),
            "region": row.get("region", ""), "classes": list(filter(None, row.get("device_class", "").split(";"))),
            "status": status, "alert": None if status is None else status != "NORMAL",
            "relayCapable": frontend._boolean(row.get("relay_capable")), "key": frontend._boolean(row.get("is_key")),
            "mobility": row["mobility"], "remark": row.get("remark", ""), "origin": row.get("origin", "SOURCE")})
    device_items = []
    for row in devices:
        status = frontend._status(row.get("status"))
        device_items.append({"id": row["device_id"], "stationId": row["node_id"], "modelId": row["model_id"],
            "antennaId": row["antenna_id"], "status": status, "alert": None if status is None else status != "NORMAL",
            **{key: frontend._optional_number(row.get(field)) for key, field in {**DEVICE_FIELDS, "tiltDeg": "tilt_deg", "azimuthDeg": "azimuth_deg"}.items()},
            "installedAt": row.get("install_time", ""), "availability": row.get("availability", "ACTIVE"),
            "origin": row.get("origin", "SOURCE"), "currentWorkMode": row.get("current_work_mode") or None})
    interferences = [{"id": row["interference_id"], "name": row["name"],
        "coordinate": [float(row["lon"]), float(row["lat"])],
        **{key: frontend._optional_number(row.get(field)) for key, field in INTERFERENCE_FIELDS.items()
           if key not in ("name", "coordinate", "interferenceType", "patternType", "active")},
        "interferenceType": row["interference_type"], "patternType": row.get("pattern_type") or None,
        "active": frontend._boolean(row.get("active")), "origin": row.get("origin", "SOURCE")}
        for row in tables["interference_source.csv"]]
    return {"stations": stations, "devices": device_items, "interferences": interferences,
        "models": [{"id": row["model_id"], "name": row["model_name"], "manufacturer": row.get("manufacturer", ""),
            "deviceClass": row["device_class"], "freqMinKhz": float(row["freq_min_khz"]),
            "freqMaxKhz": float(row["freq_max_khz"]), "txPowerMaxDbm": float(row["tx_power_max_dbm"]),
            "modulation": list(filter(None, row.get("modulation", "").split(";"))),
            "workMode": list(filter(None, row.get("work_mode", "").split(";")))} for row in models],
        "antennas": [{"id": row["antenna_id"], "name": row["antenna_name"]} for row in antennas],
        "candidateLinks": candidates.get_links(snapshot), "source": datasets.SOURCE, "version": snapshot["revision"],
        "planningBounds": list(planning_bounds) if geography.valid_bounds(planning_bounds) else None}


def meta(snapshot):
    revision = snapshot["revision"]
    # 仅表示资源编辑版本，未计算的链路影响不虚构为已评估。
    return {"revision": revision, "resourceEpoch": revision, "savedAt": snapshot["source_updated_at"],
        "stationVersions": {row["node_id"]: revision for row in snapshot["tables"]["node.csv"]},
        "deviceVersions": {row["device_id"]: revision for row in snapshot["tables"]["device.csv"]},
        "changedStationIds": [], "changedDeviceIds": [], "changedInterferenceIds": [],
        "interferenceVersion": revision, "receipts": []}


def context(query):
    snapshot = require_snapshot(query.revision)
    data, metadata = resources(snapshot), meta(snapshot)
    with datasets.get_session_factory()() as session:
        plans = list(session.scalars(select(PlanningPlan.plan_id).where(
            PlanningPlan.resource_revision == snapshot["revision"]).order_by(PlanningPlan.plan_id)))
    return {"revision": snapshot["revision"], "baseRevision": snapshot["revision"], "device": None,
        "stations": data["stations"], "models": data["models"], "antennas": data["antennas"],
        "resources": data, "meta": metadata, "resourceMeta": metadata, "validationSource": deepcopy(data),
        "situation": {"title": "当前构造资源编辑上下文（非规划网络）", "snapshotId": snapshot["revision"],
            "updatedAt": snapshot["source_updated_at"], "links": [], "candidateLinks": [], "regions": [], "alerts": [], "spectrum": []},
        "impact": {"planIds": plans, "linkIds": [],
            "description": "资源保存后旧方案保留并标记来源变化；不自动重算，未提供链路级影响明细，不执行设备下发"}}


def result_for_receipt(receipt):
    # 重放必须读取原提交版本，不借用后来发生变化的 current。
    with datasets.get_session_factory()() as session:
        snapshot = datasets._decode(session.get(ResourceDatasetVersion, receipt["revision"]))
    canonical = {"objectId": receipt["object_id"], "changed": receipt["changed"], "revision": receipt["revision"],
        "readRevision": receipt["read_revision"], "affectedIds": receipt["affected_ids"], "warnings": receipt["warnings"]}
    data = resources(snapshot)
    device = next((row for row in data["devices"] if row["id"] == receipt["object_id"]), None)
    if device is not None:
        canonical["device"] = device
    return {"receipt": canonical, "result": {"resources": data, "meta": meta(snapshot),
        "changed": receipt["changed"], "warnings": receipt["warnings"]}}


def changes_between(before, after):
    old, new = resources(before, None), resources(after, None)
    changes = {"stations": [], "devices": []}
    for collection, added_key, changed_key, fields in (
        ("stations", "newStations", "stations", NODE_FIELDS),
        ("devices", "newDevices", "devices", DEVICE_FIELDS),
        ("interferences", "newInterferences", "interferences", INTERFERENCE_FIELDS)):
        previous = {item["id"]: item for item in old[collection]}
        for item in new[collection]:
            original = previous.get(item["id"])
            if original is None:
                changes.setdefault(added_key, []).append(item)
            else:
                patch = {key: item[key] for key in fields if item[key] != original[key]}
                if patch:
                    changes.setdefault(changed_key, []).append({"id": item["id"], **patch})
    previous = {row["id"]: row for row in old["candidateLinks"]}
    for row in new["candidateLinks"]:
        if row["id"] not in previous:
            changes.setdefault("newCandidateLinks", []).append(row)
        elif row != previous[row["id"]]:
            changes.setdefault("importedCandidateLinks", []).append(row)
    return changes


def _scalar(key, value):
    numeric = {"elevationM", "antennaHeightM", "txPowerDbm", "workFreqKhz", "tiltDeg", "azimuthDeg",
        "centerFreqKhz", "bandwidthKhz", "antennaGainDbi", "dutyCycle"}
    if key in ("relayCapable", "key", "active"):
        if type(value) is not bool:
            fail("布尔字段无效：" + key)
        return str(value).lower()
    if key in numeric:
        if value is None and key not in ("antennaHeightM", "txPowerDbm", "centerFreqKhz", "bandwidthKhz"):
            return ""
        if type(value) not in (int, float) or not math.isfinite(value):
            fail("数值字段无效：" + key)
        return str(value)
    if key in ("parentIds", "classes"):
        if not isinstance(value, list) or any(not isinstance(v, str) or not v or ";" in v for v in value) or len(value) != len(set(value)):
            fail("多值字段无效：" + key)
        return ";".join(value)
    if key == "patternType" and value is None:
        return ""
    if not isinstance(value, str) or len(value) > 512 or re.search(r"[\x00-\x1f\x7f]", value):
        fail("文本字段无效：" + key)
    return value


def apply_changes(snapshot, changes, planning_bounds=_CURRENT_BOUNDS):
    from .resource_import_parser import parse_import

    if planning_bounds is _CURRENT_BOUNDS:
        planning_bounds = geography.read_planning_bounds()

    allowed = {"stations", "devices", "interferences", "newStations", "newDevices", "newInterferences",
        "newCandidateLinks", "candidateLinks", "importedCandidateLinks"}
    if set(changes) - allowed:
        fail("包含未接入或只读的资源操作")
    if sum(len(value) for value in changes.values() if isinstance(value, list)) > 5000:
        fail("一次最多提交5000条资源增量")
    parsed_tables = deepcopy(snapshot["tables"])
    warnings, touched = [], []
    for kind, patch_key, new_key, fields, new_fields in (
        ("nodes", "stations", "newStations", NODE_FIELDS, NEW_NODE_FIELDS),
        ("devices", "devices", "newDevices", DEVICE_FIELDS, NEW_DEVICE_FIELDS),
        ("interference_sources", "interferences", "newInterferences", INTERFERENCE_FIELDS, INTERFERENCE_FIELDS)):
        rows = parsed_tables[TABLES[kind]]
        originals = {row[HEADERS[kind][0]]: row for row in rows}
        values, ids = [], set()
        for creating, key, mapping in ((False, patch_key, fields), (True, new_key, new_fields)):
            entries = changes.get(key, [])
            if not isinstance(entries, list) or len(entries) > 5000:
                fail("资源变更列表无效：" + key)
            for entry in entries:
                if not isinstance(entry, dict):
                    fail("资源变更行无效")
                identifier = entry.get("id")
                if not isinstance(identifier, str) or not identifier or len(identifier) > 120 or re.search(r"\s|[\x00-\x1f\x7f]", identifier):
                    fail("资源编号无效")
                if identifier in ids:
                    fail("同一资源不能重复修改")
                ids.add(identifier)
                if creating == (identifier in originals):
                    fail("新增编号已存在" if creating else "待编辑资源不存在", 1001 if creating else 1002, 422 if creating else 404)
                extras = {"origin", "status", "alert", "availability"} if creating else set()
                if set(entry) - {"id", *mapping, *extras}:
                    fail("资源变更包含只读或未接入字段")
                if creating and (entry.get("origin", "MANUAL") != "MANUAL" or entry.get("status") is not None or entry.get("alert") is not None
                    or entry.get("availability", "ACTIVE") != "ACTIVE"):
                    fail("新建资源不得伪造来源、观测状态或上下架结果")
                row = {} if creating else deepcopy(originals[identifier])
                row[HEADERS[kind][0]] = identifier
                for field, target in mapping.items():
                    if field not in entry:
                        continue
                    if field == "coordinate":
                        coordinate = entry[field]
                        if not isinstance(coordinate, list) or len(coordinate) != 2 or any(type(n) not in (float, int) or not math.isfinite(n) for n in coordinate):
                            fail("坐标必须为有限数值的经纬度数组")
                        for column, number in zip(("lon", "lat"), coordinate):
                            if creating or frontend._optional_number(row.get(column)) != number:
                                row[column] = str(number)
                    else:
                        converted = _scalar(field, entry[field])
                        if not creating and (type(entry[field]) in (int, float) or entry[field] is None) and field not in ("patternType",):
                            if frontend._optional_number(row.get(target)) == entry[field]:
                                continue
                        row[target] = converted
                values.append(row)
                touched.append((kind, identifier, creating))
        if not values:
            continue
        output = StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=HEADERS[kind], extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for row in values:
            encoded = {field: row.get(field, "ACTIVE" if field == "availability" else "") for field in HEADERS[kind]}
            # 内部手工文本不是外部 CSV 转义，避免 ~rp~ 前缀被二次解释。
            writer.writerow({field: "~rp~" + json.dumps(value, ensure_ascii=False) if value.startswith("~rp~") else value
                for field, value in encoded.items()})
        parsed = parse_import(parsed_tables, "workspace.csv", output.getvalue().encode("utf-8"), kind, planning_bounds)
        if parsed["issues"]:
            fail("资源校验失败：" + parsed["issues"][0]["message"])
        parsed_tables = parsed["tables"]
        warnings.extend(parsed["warnings"])
    for kind, identifier, creating in touched:
        row = next(row for row in parsed_tables[TABLES[kind]] if row[HEADERS[kind][0]] == identifier)
        previous = next((row for row in snapshot["tables"][TABLES[kind]] if row[HEADERS[kind][0]] == identifier), None)
        if creating:
            row["origin"] = "MANUAL"
        elif "origin" in previous:
            row["origin"] = previous["origin"]
        else:
            row.pop("origin", None)
    return parsed_tables, warnings


def save(request, actor_id):
    try:
        digest = datasets.content_hash({"operation": "workspace-changes", **request.model_dump()})
    except (TypeError, ValueError):
        # JSON NaN/Infinity 必须在哈希与事务之前拒绝，不能泄漏为未捕获异常。
        fail("资源变更必须为有限数值和有效 JSON 字段")
    def apply(snapshot):
        before = {**deepcopy(snapshot), "revision": request.base_revision}
        candidate, warnings = apply_changes(snapshot, request.changes)
        after = {**snapshot, "tables": candidate, "revision": request.base_revision}
        links = candidates.apply_candidate_changes(after, request.changes)
        links_changed = links != candidates.get_links(snapshot)
        if links_changed:
            after[candidates.SNAPSHOT_KEY] = links
        changed = candidate != snapshot["tables"] or links_changed
        differences = changes_between(before, after)
        affected = sorted({item["id"] for values in differences.values() for item in values})
        snapshot["tables"] = candidate
        if links_changed:
            snapshot[candidates.SNAPSHOT_KEY] = links
        devices = [item["id"] for key in ("devices", "newDevices") for item in request.changes.get(key, [])]
        object_id = devices[0] if len(devices) == 1 and not any(request.changes.get(key) for key in ("stations", "newStations", "interferences", "newInterferences", "newCandidateLinks", "candidateLinks")) else "resource-workspace"
        return changed, {"object_id": object_id, "affected_ids": affected, "warnings": warnings}

    receipt = datasets.commit_device_change(request.base_revision, request.request_id, digest, actor_id, apply)
    return result_for_receipt(receipt)
