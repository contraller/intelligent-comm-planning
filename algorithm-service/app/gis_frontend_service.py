"""新版 GIS 只读资源投影，不混入旧页面或任意任务的规划网络。"""
from copy import deepcopy

from . import frontend_integration as resources


class GisReadError(ValueError):
    def __init__(self, message, code=1001, status=422):
        super().__init__(message)
        self.code, self.status = code, status


def read(kind, context, revision):
    if context != "gis" or kind not in ("directory", "scene"):
        raise GisReadError("仅支持 GIS 只读目录与展示资料")
    if not revision or revision != resources.resource_revision():
        raise GisReadError("资源版本已变化，请刷新后重试", 1205, 409)
    nodes, devices, models = (resources._rows(k) for k in ("nodes", "devices", "models"))
    antennas = resources._rows("antennas")
    sources = resources._rows("interferences")
    node_items = [resources._node_item(row, nodes, devices) for row in nodes]
    device_items = [resources._device_item(row, nodes, models, antennas) for row in devices]
    # 与现有型号字典 DTO 保持一致，CSV 数值只在服务边界转换。
    models = deepcopy(models)
    for model in models:
        for field in ("freq_min_khz", "freq_max_khz", "tx_power_max_dbm"):
            model[field] = resources._number(model.get(field))
    if kind == "directory":
        # 目录只承载分组与关联身份，完整设备参数由已有详情接口读取。
        fields = ("device_id", "node_id", "model_id", "status", "alert", "availability", "origin")
        device_items = [{key: row[key] for key in fields} for row in device_items]
        models = [{key: row[key] for key in ("model_id", "model_name", "device_class")} for row in models]
    data = {
        "revision": revision, "context": "gis", "dataOrigin": "SYNTHETIC_INTEGRATION",
        "source": "项目构造资源基线，非生产、非实测", "updatedAt": resources._updated_at(),
        "nodes": node_items, "devices": device_items, "models": models,
        "interferences": [resources._interference_item(row) for row in sources],
    }
    if kind == "scene":
        data["snapshotId"] = "GIS-RES-" + revision
        data["networkState"] = "missing"
        data["networkMessage"] = "资源浏览未关联指定规划方案，未提供规划链路、业务路径和实时观测。"
    # 文件在读取期间换版时拒绝整个投影，不能拼出混合版本。
    if revision != resources.resource_revision():
        raise GisReadError("资源在读取期间发生变化，请刷新后重试", 1205, 409)
    return data
