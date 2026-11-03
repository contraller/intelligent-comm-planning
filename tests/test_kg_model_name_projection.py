"""型号仅取所选知识版本中的冻结属性，不查询当前设备资源。"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from app import kg_frontend_service as service


def test_search_projects_frozen_model_name_and_keeps_entity_id(monkeypatch):
    def snapshot(version):
        name = "AN/PRC-150(C)" if version == "KGV-1" else "FT-891"
        return {"entities": [{"id": "e1", "name": "DM-0001", "category": "设备知识", "type": "DeviceModel",
                             "attributes": [{"name": "model_name", "value": name, "unit": None}]}], "relations": []}
    monkeypatch.setattr(service, "snapshot", snapshot)
    first = service.browse("search", {"versionId": "KGV-1"})["items"][0]
    second = service.browse("search", {"versionId": "KGV-2"})["items"][0]
    assert first == {"id": "e1", "name": "DM-0001", "category": "设备知识", "type": "DeviceModel", "modelName": "AN/PRC-150(C)"}
    assert second["modelName"] == "FT-891"


def test_unavailable_model_name_is_omitted_and_nonmodel_attributes_never_project(monkeypatch):
    monkeypatch.setattr(service, "snapshot", lambda version: {"entities": [
        {"id": "e1", "name": "DM-1", "category": "设备知识", "type": "DeviceModel", "attributes": []},
        {"id": "e2", "name": "功能", "category": "设备知识", "type": "Function", "attributes": [{"name": "model_name", "value": "FT-891"}]}], "relations": []})
    assert all("modelName" not in row for row in service.browse("search", {"versionId": "KGV-1"})["items"])
