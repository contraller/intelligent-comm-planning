"""按已保存的任务输入版本读取原资源坐标，避免 GIS 混用资源版本。"""
from __future__ import annotations

from copy import deepcopy
import math

from . import frontend_integration as resources
from . import resource_dataset_service as datasets
from .database import get_session_factory
from .task_input_models import PlanningTaskRevision
from .task_input_service import TaskInputError, _dto


def snapshot(task_id, revision, context, *, factory=None):
    factory = factory or get_session_factory()
    with factory() as session:
        saved = session.get(PlanningTaskRevision, revision)
        if saved is None or saved.task_id != task_id or saved.context != context:
            raise TaskInputError(2001, "所选任务保存版本不存在，请重新查询已保存任务", 404)
        task = deepcopy(_dto(saved))
    frozen = datasets.at_revision(task["resource_revision"], factory=factory)
    tables = frozen["tables"]
    all_nodes = tables[datasets.PRIMARY_NAMES["nodes"]]
    devices = tables[datasets.PRIMARY_NAMES["devices"]]
    by_id = {row["node_id"]: row for row in all_nodes}
    nodes, missing = [], []
    for node_id in task["input"]["stationIds"]:
        row = by_id.get(node_id)
        try:
            # 历史缺项与无效坐标不补零，其他节点仍可在地图上查看。
            lon, lat = float(row["lon"]), float(row["lat"])
            if not (math.isfinite(lon) and math.isfinite(lat)
                    and -180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError("invalid coordinate")
            nodes.append(resources._node_item(row, all_nodes, devices))
        except (KeyError, TypeError, ValueError):
            missing.append(node_id)
    changed = task["resource_revision"] != resources.resource_revision()
    messages = ["展示任务保存时的参与节点与通联需求；需求连线不表示已计算的规划链路。"]
    if changed:
        messages.append("当前资源已变化，正在查看历史冻结任务，未拼接当前资源坐标。")
    if missing:
        messages.append("以下节点在冻结资源中缺失或坐标无效，未绘制：" + "、".join(missing))
    return {"task": task, "task_revision": revision,
            "resource_revision": task["resource_revision"],
            "snapshot_id": "GIS-TASK-" + revision, "source_changed": changed,
            "nodes": nodes, "missing_node_ids": missing, "message": " ".join(messages)}
