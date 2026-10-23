"""单设备基础参数维护；所有修改只生成数据库新资源快照。"""
from sqlalchemy import select

from . import frontend_integration as frontend
from . import resource_dataset_service as datasets
from .planning_plan_models import PlanningPlan
from .resource_maintenance_schemas import (AvailabilityChange, AvailabilityPreview,
    ResourceDeviceChanges, ResourceMaintenanceQuery)


def _device(tables, device_id):
    row = next((row for row in tables["device.csv"] if row["device_id"] == device_id), None)
    if row is None:
        raise datasets.ResourceDatasetError("设备不存在", 1002, 404)
    return row


def _dto(tables, row):
    return frontend._device_item(row, tables["node.csv"], tables["device_model.csv"], tables["antenna_model.csv"])


def context(query: ResourceMaintenanceQuery):
    if not datasets.database_mode():
        raise datasets.ResourceDatasetError("设备维护仅支持数据库资源版本", 5003)
    snapshot = datasets.current()
    if query.revision != snapshot["revision"]:
        raise datasets.ResourceDatasetError("资源版本已变化，请刷新后重新编辑", 1205, 409)
    tables = snapshot["tables"]
    row = _device(tables, query.device_id)
    node = next(item for item in tables["node.csv"] if item["node_id"] == row["node_id"])
    model = dict(next(item for item in tables["device_model.csv"] if item["model_id"] == row["model_id"]))
    for key in ("freq_min_khz", "freq_max_khz", "tx_power_max_dbm"):
        model[key] = float(model[key])
    antenna = next(item for item in tables["antenna_model.csv"] if item["antenna_id"] == row["antenna_id"])
    with datasets.get_session_factory()() as session:
        plans = list(session.scalars(select(PlanningPlan.plan_id).where(
            PlanningPlan.resource_revision == query.revision).order_by(PlanningPlan.plan_id)))
    return {"revision": query.revision, "base_revision": query.revision, "device": _dto(tables, row),
        "stations": [frontend._node_item(node, tables["node.csv"], tables["device.csv"])],
        "models": [model], "antennas": [antenna],
        "impact": {"plan_ids": plans, "link_ids": [],
            "description": "保存后全局资源版本更新，旧方案保留历史并标记来源变化；不自动重算，未提供链路级影响明细"}}


def save(request: ResourceDeviceChanges, actor_id: str):
    patch = request.devices[0]
    values = patch.model_dump(exclude_unset=True, exclude={"id"})

    def apply(snapshot):
        tables = snapshot["tables"]
        row = _device(tables, patch.id)
        model = next(item for item in tables["device_model.csv"] if item["model_id"] == row["model_id"])
        changed = False
        warnings = []
        for field, value in values.items():
            original = frontend._optional_number(row.get(field))
            # 既有舍入超限值仅能原样保留；任何新的超限功率都拒绝。
            if field == "tx_power_dbm" and value > float(model["tx_power_max_dbm"]):
                if value != original or value - float(model["tx_power_max_dbm"]) > 0.040001:
                    raise datasets.ResourceDatasetError("修改后的功率不得超过型号上限", 1001, 422)
                warnings.append({"object_id": patch.id, "field": "txPowerDbm", "message": "来源功率舍入超限，本次未改动予以保留"})
            if field == "work_freq_khz" and value is not None and not float(model["freq_min_khz"]) <= value <= float(model["freq_max_khz"]):
                raise datasets.ResourceDatasetError("工作频率超出设备型号范围", 1001, 422)
            if value != original:
                row[field] = "" if value is None else str(value)
                changed = True
        return changed, {"object_id": patch.id, "device": _dto(tables, row),
            "affected_ids": [patch.id] if changed else [], "warnings": warnings}

    return datasets.commit_device_change(request.base_revision, request.request_id,
        datasets.content_hash(request.model_dump(exclude_unset=True)), actor_id, apply)


def availability_preview(request: AvailabilityPreview):
    if not datasets.database_mode():
        raise datasets.ResourceDatasetError("设备上下架仅支持数据库资源版本", 5003)
    snapshot = datasets.current()
    if request.revision != snapshot["revision"]:
        raise datasets.ResourceDatasetError("资源版本已变化，请刷新后重新选择", 1205, 409)
    for device_id in request.ids:
        _device(snapshot["tables"], device_id)
    with datasets.get_session_factory()() as session:
        plans = list(session.scalars(select(PlanningPlan.plan_id).where(
            PlanningPlan.resource_revision == request.revision).order_by(PlanningPlan.plan_id)))
    # 批量确认不是设备编辑表单；不返回整库，也不把未计算的链路影响说成零。
    return {"revision": request.revision, "base_revision": request.revision,
        "selected_ids": request.ids, "device": None, "stations": [], "models": [], "antennas": [],
        "impact": {"plan_ids": plans, "link_ids": [],
            "description": "实际状态变化后全局资源换版，旧方案保留历史并需重算；未提供链路级影响明细，不执行真实设备下发"}}


def set_availability(request: AvailabilityChange, actor_id: str):
    def apply(snapshot):
        # 先核验全部编号，任一失败时不保留部分状态或回执。
        rows = [_device(snapshot["tables"], device_id) for device_id in request.ids]
        updated, unchanged = [], []
        for row in rows:
            if row.get("availability", "ACTIVE") == request.availability:
                unchanged.append(row["device_id"])
            else:
                row["availability"] = request.availability
                updated.append(row["device_id"])
        return bool(updated), {"object_id": "resource-device-availability", "affected_ids": updated,
            "updated": updated, "unchanged": unchanged, "warnings": []}

    canonical = {**request.model_dump(), "ids": sorted(request.ids), "operation": "device-availability"}
    return datasets.commit_device_change(request.base_revision, request.request_id,
        datasets.content_hash(canonical), actor_id, apply)
