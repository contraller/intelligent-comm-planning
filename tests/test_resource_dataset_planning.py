"""同版资源传入 SR4；受控测试不代替真实 HTTP 算法验收。"""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from test_sr4_submit_api import api, _save_task, _submit  # noqa: F401
from test_resource_dataset_store import add_test_version
from app import resource_dataset_service as datasets, planning_w4


def prepare(api, monkeypatch):
    client, factory, calls = api
    monkeypatch.setattr(datasets, "get_session_factory", lambda: factory)
    initialized = datasets.initialize()
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    return client, factory, calls, initialized


def test_versioned_submit_freezes_all_rows(api, monkeypatch):
    client, factory, calls, initialized = prepare(api, monkeypatch)
    monkeypatch.setattr(planning_w4, "_load", lambda _: pytest.fail("数据库作业不应读取磁盘资源"))
    saved = _save_task(client)
    response = client.post("/api/v1/plan/sr4-flow", json=_submit(saved))
    assert response.status_code == 202, response.text
    payload = calls[0][0]
    assert payload["resource_revision"] == saved["resource_revision"] == initialized["revision"]
    assert {name: payload["resource_rows"][name] for name in initialized["tables"]} == initialized["tables"]
    assert payload["resource_rows"]["planning_input"]["bbox"] == saved["input"]["bbox"]
    frozen = deepcopy(payload["resource_rows"])
    add_test_version(factory, initialized)
    assert payload["resource_rows"] == frozen
    stale = client.post("/api/v1/plan/sr4-flow", json=_submit(saved, "another-request"))
    assert stale.status_code == 409 and stale.json()["code"] == 1205


def test_cannot_inject_private_tables(api, monkeypatch):
    client, _, calls, _ = prepare(api, monkeypatch)
    saved = _save_task(client)
    response = client.post("/api/v1/plan/sr4-flow", json={**_submit(saved), "resource_rows": {}})
    assert response.status_code == 422 and not calls


def test_full_flow_reads_snapshot(api, monkeypatch):
    _, _, _, initialized = prepare(api, monkeypatch)
    import sr4_flow
    tables = deepcopy(initialized["tables"])
    monkeypatch.setattr(sr4_flow, "load", lambda _: pytest.fail("冻结流程不应读取文件"))
    monkeypatch.setattr(sr4_flow, "default_terrain", lambda **_: object())
    class ReachedDeployment(Exception):
        pass
    def deployment(stations, terrain, nodes, devices, models, candidates, **kwargs):
        assert nodes == tables["node.csv"] and devices == tables["device.csv"]
        assert models == tables["device_model.csv"] and candidates == tables["candidate_site.csv"]
        assert callable(kwargs["checkpoint"])
        raise ReachedDeployment()
    monkeypatch.setattr(sr4_flow, "topology_from_deployment", deployment)
    with pytest.raises(ReachedDeployment):
        sr4_flow.run(task_id="TS-0001", resource_rows=tables, verbose=False)
    assert tables == initialized["tables"]
    with pytest.raises(ValueError, match="冻结资源缺少"):
        sr4_flow.run(resource_rows={}, verbose=False)


def test_parent_flow_reads_snapshot(api, monkeypatch):
    _, _, _, initialized = prepare(api, monkeypatch)
    import sr4_flow
    monkeypatch.setattr(sr4_flow, "load", lambda _: pytest.fail("父方案重算不应读取文件"))
    monkeypatch.setattr(sr4_flow, "default_terrain", lambda **_: object())
    class ReachedParameters(Exception):
        pass
    def stations(nodes, devices, models, antennas):
        assert nodes == [{"node_id": "PARENT"}]
        assert models == initialized["tables"]["device_model.csv"]
        assert antennas == initialized["tables"]["antenna_model.csv"]
        raise ReachedParameters()
    monkeypatch.setattr(sr4_flow, "stations_from_nodes", stations)
    with pytest.raises(ReachedParameters):
        sr4_flow.run_from_parent({"detail": {"nodes": [{"node_id": "PARENT"}], "devices": [], "links": [],
            "optimization": {"uplinks": {}}}},
            {}, [], "T1", [], resource_rows=initialized["tables"])
