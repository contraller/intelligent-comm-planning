"""GIS 独立路由与冻结投影；构造样本不冒充真实算法或页面验收。"""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import socket
import sys
from threading import Thread
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import frontend_integration as resources, gis_plan_service as service, integration_identity_service as identity
from app.database import Base, DatabaseConfigurationError
from app.gis_plan_router import router
from app.planning_job_models import PlanningJob
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan
from app import resource_dataset_service as datasets
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from app.task_input_models import PlanningTask, PlanningTaskRevision


def frozen_result():
    return {"snapshot_id": "SNAP-P02", "nodes": [
        {"id": node, "name": "构造节点" + node, "coordinate": [114.0 + i / 10, 37.0]}
        for i, node in enumerate(("A", "B", "C"))],
        "devices": [{"id": "E" + node, "stationId": node, "modelId": "M1", "deviceClass": "HF",
                     "workFreqKhz": 7000.0, "txPowerDbm": 40.0, "antennaHeightM": 12.0}
                    for node in ("A", "B", "C")],
        "links": [{"id": lid, "a": a, "b": b, "deviceA": "E" + a, "deviceB": "E" + b,
                   "deviceClass": "HF", "frequencyKhz": 7000.0, "backup": backup, "state": "GOOD"}
                  for lid, a, b, backup in (("L1", "A", "B", True), ("L2", "B", "C", True), ("L3", "A", "C", False))],
        "configuration": {"routes": [
            {"id": "R1", "demandId": "D1", "nodeIds": ["A", "C"], "linkIds": ["L3"], "backup": False},
            {"id": "R2", "demandId": "D1", "nodeIds": ["A", "B", "C"], "linkIds": ["L1", "L2"], "backup": True}]}}


def frozen_input():
    return {"demands": [{"id": "D1", "sourceId": "A", "targetId": "C", "sourceDeviceId": None,
                          "targetDeviceId": None, "service": "数据", "mandatory": True,
                          "requiredRateKbps": 64.0, "minReliability": 0.95}]}


@pytest.fixture
def api(tmp_path, monkeypatch):
    db = tmp_path / "gis.sqlite"
    engine = create_engine("sqlite:///" + db.as_posix(), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    with factory.begin() as session:
        session.add(PlanningTask(task_id="T1", current_revision_id="I1", current_version_no=1, created_at=now, updated_at=now))
        session.add(PlanningTaskRevision(revision_id="I1", task_id="T1", version_no=1, condition_version="C1",
                                        resource_revision="resource-old", context="planning", input_snapshot=frozen_input(), created_at=now))
        session.add(PlanningJob(job_id="J1", request_id="RUN1", request_digest="hash", task_id="T1", revision_id="I1",
                                condition_version="C1", resource_revision="resource-old", context="planning", status="SUCCESS",
                                progress=1.0, stage="完成", created_at=now, updated_at=now))
        session.add(PlanningPlan(plan_id="P1", request_id="SAVE1", request_digest="hash", task_id="T1", job_id="J1",
                                 revision_id="I1", condition_version="C1", resource_revision="resource-old", version_no=1,
                                 name="构造测试方案", note="非实测", state="CONFIRMED", source="SR4", saved_at=now,
                                 confirmed_at=now, input_snapshot=frozen_input(), result_snapshot=frozen_result(), outcome_snapshot={}))
        session.add(PlanningCurrentPlan(task_id="T1", plan_id="P1", updated_at=now))
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setattr(service, "get_session_factory", lambda: factory)
    monkeypatch.setattr(identity, "get_session_factory", lambda: factory)
    monkeypatch.setattr(resources, "resource_revision", lambda: "resource-new")
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client, factory, db
    engine.dispose()


def query(client, path="network", **params):
    return client.get("/api/v1/gis/plans/P1/" + path,
                      params={"context": "gis", "task_id": "T1", **params})


def edit(factory, field, transform):
    with factory.begin() as session:
        plan = session.get(PlanningPlan, "P1")
        value = deepcopy(getattr(plan, field))
        transform(value)
        setattr(plan, field, value)


def test_network_keeps_historical_snapshot_and_unknowns(api, monkeypatch):
    client, factory, _ = api
    monkeypatch.setattr(resources, "_rows", lambda *args: pytest.fail("不得用当前资源补历史快照"))
    result = query(client)
    assert result.status_code == 200, result.text
    data = result.json()["data"]
    assert data["identity"] == {"plan_id": "P1", "task_id": "T1", "snapshot_id": "SNAP-P02", "input_version": "I1",
                                "condition_version": "C1", "resource_revision": "resource-old", "state": "CONFIRMED",
                                "source_changed": True, "data_origin": "SYNTHETIC_INTEGRATION", "source": "SR4"}
    assert data["nodes"][0]["status"] is None and data["nodes"][0]["alert"] is None
    assert data["nodes"][0]["coordinate"] == [114.0, 37.0]
    assert len(data["routes"]) == 2 and data["paths_state"] == "ready"
    assert data["interferences"] == [] and "未保留同版本" in data["interferences_notice"]
    with factory() as session:
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").result_snapshot == frozen_result()
        assert session.scalar(select(func.count()).select_from(PlanningJob)) == 1


def frozen_tables(source_id="IF-OLD", mobility="VEHICLE"):
    return {"node.csv": [{"node_id": node, "mobility": mobility, "node_role": "TASK", "node_subtype": "II_MOBILE"}
                          for node in ("A", "B", "C")],
            "interference_source.csv": [{"interference_id": source_id, "name": "冻结构造干扰源",
                "lon": "114.15", "lat": "37.2", "elevation_m": "", "antenna_height_m": "8.0",
                "center_freq_khz": "7000", "bandwidth_khz": "200", "tx_power_dbm": "30.0",
                "antenna_gain_dbi": "", "interference_type": "PULSE", "pattern_type": "",
                "azimuth_deg": "", "duty_cycle": "0.5", "active": "false"}]}


def resource_snapshot(source_id="IF-OLD", mobility="VEHICLE"):
    tables = {name: [{field: "FROZEN-" + str(index)}] for index, (name, field) in enumerate(datasets.ID_FIELDS.items())}
    tables.update(frozen_tables(source_id, mobility))
    tables["device_model.csv"] = [{"model_id": "M1"}]
    tables["antenna_model.csv"] = [{"antenna_id": "ANT1"}]
    tables["device.csv"] = [{"device_id": "EA", "node_id": "A", "model_id": "M1", "antenna_id": "ANT1"}]
    tables["task_scenario.csv"] = [{"task_id": "TASK1"}]
    tables["comm_demand.csv"] = [{"demand_id": "D1", "task_id": "TASK1", "src_node_id": "A", "dst_node_id": "C"}]
    return {"schema_version": 1, "tables": tables, "source_updated_at": "2026-11-03T08:00:00+08:00",
            "source_files": {name: {"path": "data/frozen/" + name, "sha256": "a" * 64} for name in tables}}


def add_version(session, revision, snapshot, *, bad_hash=False):
    session.add(ResourceDatasetVersion(revision=revision, content_hash="0" * 64 if bad_hash else datasets.content_hash(snapshot),
        source=datasets.SOURCE, data_origin=datasets.ORIGIN, snapshot=snapshot, created_at=datetime.now(timezone.utc)))


def test_network_reads_only_the_plan_resource_revision_and_preserves_result_node_values(api, monkeypatch):
    client, factory, _ = api
    old_revision, current_revision = "resource-1111111111111111", "resource-2222222222222222"
    with factory.begin() as session:
        add_version(session, old_revision, resource_snapshot())
        add_version(session, current_revision, resource_snapshot("IF-CURRENT", "FIXED"))
        session.flush()
        session.add(ResourceDatasetCurrent(scope=datasets.SCOPE, revision=current_revision))
        plan = session.get(PlanningPlan, "P1")
        plan.resource_revision = old_revision
        result = deepcopy(plan.result_snapshot)
        result["nodes"][1].update(mobility="MANPACK", node_role="EXPLICIT_RESULT_ROLE")
        plan.result_snapshot = result
    monkeypatch.setattr(datasets, "current", lambda *a, **k: pytest.fail("不能读取current补冻结态势"))
    monkeypatch.setattr(datasets, "capture_files", lambda *a, **k: pytest.fail("不能读取现用CSV补冻结态势"))
    response = query(client)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["identity"]["resource_revision"] == old_revision
    assert [source["id"] for source in data["interferences"]] == ["IF-OLD"]
    source = data["interferences"][0]
    assert source["coordinate"] == [114.15, 37.2] and source["active"] is False
    assert source["elevationM"] is None and source["antennaGainDbi"] is None and source["origin"] == "SOURCE"
    assert data["interferences_notice"] == ""
    assert data["nodes"][0]["mobility"] == "VEHICLE" and data["nodes"][0]["node_subtype"] == "II_MOBILE"
    assert data["nodes"][1]["mobility"] == "MANPACK" and data["nodes"][1]["node_role"] == "EXPLICIT_RESULT_ROLE"
    assert data["nodes"][0]["status"] is None and data["nodes"][0]["alert"] is None
    with factory() as session:
        assert session.get(ResourceDatasetCurrent, datasets.SCOPE).revision == current_revision
        assert session.get(ResourceDatasetVersion, old_revision).snapshot == resource_snapshot()


def test_missing_frozen_revision_keeps_old_network_without_current_fallback(api, monkeypatch):
    monkeypatch.setattr(datasets, "current", lambda *a, **k: pytest.fail("不能回退当前资源"))
    data = query(api[0]).json()["data"]
    assert data["nodes"] and data["links"] and data["interferences"] == [] and data["interferences_notice"]
    assert data["nodes"][0]["mobility"] is None


def test_present_but_corrupt_same_revision_does_not_silently_drop_sources(api):
    client, factory, _ = api
    revision = "resource-1111111111111111"
    with factory.begin() as session:
        add_version(session, revision, resource_snapshot(), bad_hash=True)
        session.get(PlanningPlan, "P1").resource_revision = revision
    response = query(client)
    assert response.status_code == 409 and response.json()["code"] == 1203
    assert "同版本资源快照校验失败" in response.json()["message"]


@pytest.mark.parametrize("mutation", [
    lambda tables: tables["interference_source.csv"][0].update(active="0"),
    lambda tables: tables["interference_source.csv"][0].update(active=False),
    lambda tables: tables["interference_source.csv"][0].update(lon="181"),
    lambda tables: tables["interference_source.csv"][0].update(lon="NaN"),
    lambda tables: tables["interference_source.csv"][0].update(tx_power_dbm="inf"),
    lambda tables: tables["interference_source.csv"][0].update(center_freq_khz="0"),
    lambda tables: tables["interference_source.csv"][0].update(duty_cycle="1.5"),
    lambda tables: tables["interference_source.csv"][0].update(origin="UNKNOWN"),
    lambda tables: tables["interference_source.csv"][0].update(interference_id="bad id"),
    lambda tables: tables["interference_source.csv"][0].pop("lat"),
    lambda tables: tables["interference_source.csv"].append(deepcopy(tables["interference_source.csv"][0])),
    lambda tables: tables["node.csv"][0].update(mobility="AIRCRAFT"),
    lambda tables: tables["node.csv"][0].update(node_role=7),
    lambda tables: tables["node.csv"].append(deepcopy(tables["node.csv"][0])),
])
def test_damaged_frozen_csv_is_rejected_instead_of_coerced_or_ignored(api, mutation):
    data = query(api[0]).json()["data"]
    tables = frozen_tables(); mutation(tables)
    with pytest.raises(service.GisPlanError):
        service._project(frozen_result(), frozen_input(), data["identity"], tables)


def test_pure_projection_accepts_old_call_and_verified_empty_source_table(api):
    identity = query(api[0]).json()["data"]["identity"]
    old = service._project(frozen_result(), frozen_input(), identity)
    assert old["interferences"] == [] and old["interferences_notice"]
    empty = service._project(frozen_result(), frozen_input(), identity, {"interference_source.csv": []})
    assert empty["interferences"] == [] and empty["interferences_notice"] == ""


@pytest.mark.parametrize("state", ["SAVED", "REFERENCE", "CONFIRMED"])
def test_all_saved_states_remain_readable(api, state):
    client, factory, _ = api
    with factory.begin() as session:
        session.get(PlanningPlan, "P1").state = state
    assert query(client).json()["data"]["identity"]["state"] == state


def test_link_and_paths_are_bound_to_same_snapshot(api):
    client, _, _ = api
    response = query(client, "links/L3", snapshot_id="SNAP-P02")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["demand_ids"] == ["D1"] and data["route_ids"] == ["R1"]
    assert [d["id"] for d in data["endpoint_devices"]] == ["EA", "EC"]
    assert data["observation"]["state"] == "missing" and data["observation"]["samples"] == []
    routes = query(client, "paths", snapshot_id="SNAP-P02", demand_id="D1").json()["data"]
    assert routes["routes"][1]["node_ids"] == ["A", "B", "C"]
    assert routes["identity"] == data["identity"]


def test_surface_requires_exact_snapshot_and_preserves_unknown(api):
    client, _, _ = api
    assert query(client, "surface").status_code == 422
    assert query(client, "surface", snapshot_id="OTHER").status_code == 409
    response = query(client, "surface", snapshot_id="SNAP-P02")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["identity"]["snapshot_id"] == "SNAP-P02"
    assert data["terrain"] is None and data["terrain_notice"]
    assert data["coverage"] is None and data["coverage_notice"]


def test_surface_preserves_frozen_coverage_without_current_resource_fallback(api):
    client, factory, _ = api
    coverage = {"contour": {"type": "FeatureCollection", "features": []}, "raster_png": None}
    edit(factory, "result_snapshot", lambda result: result.update(coverage=coverage))
    response = query(client, "surface", snapshot_id="SNAP-P02")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["coverage"] == coverage
    assert response.json()["data"]["coverage_notice"] == ""
    with factory() as session:
        assert session.get(PlanningPlan, "P1").result_snapshot["coverage"] == coverage


@pytest.mark.parametrize("coverage", [{"contour": None, "raster_png": None}, None])
def test_surface_missing_coverage_is_unknown_not_zero(api, coverage):
    client, factory, _ = api
    edit(factory, "result_snapshot", lambda result: result.update(coverage=coverage))
    data = query(client, "surface", snapshot_id="SNAP-P02").json()["data"]
    assert data["coverage"] is None and data["coverage_notice"]


def test_surface_damaged_coverage_is_rejected(api):
    client, factory, _ = api
    edit(factory, "result_snapshot", lambda result: result.update(coverage={"rasterPng": None}))
    assert query(client, "surface", snapshot_id="SNAP-P02").status_code == 409


def test_surface_only_uses_verified_frozen_dem(api, monkeypatch, tmp_path):
    import json
    from app import planning_adjustment_service
    client, factory, _ = api
    with factory.begin() as session:
        session.get(PlanningPlan, "P1").raw_snapshot = {"terrain_fingerprint": "frozen-dem"}
    meta = tmp_path / "data/raw/dem/dem_current.json"
    meta.parent.mkdir(parents=True)
    meta.write_text(json.dumps({"source_sha256": "a" * 64, "bbox": [113, 36, 115, 38], "source": "构造测试元数据"}), encoding="utf-8")
    monkeypatch.setattr(resources, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(planning_adjustment_service, "terrain_fingerprint", lambda: "frozen-dem")
    data = query(client, "surface", snapshot_id="SNAP-P02").json()["data"]
    assert data["terrain"] == {"sourceSha256": "a" * 64, "bounds": [113, 36, 115, 38], "source": "构造测试元数据"}
    assert data["terrain_notice"] == ""
    monkeypatch.setattr(planning_adjustment_service, "terrain_fingerprint", lambda: "another-dem")
    data = query(client, "surface", snapshot_id="SNAP-P02").json()["data"]
    assert data["terrain"] is None and data["terrain_notice"]


@pytest.mark.parametrize("bad", [None, [], [115, 36, 113, 38], [113, 36, 115, 95], [True, 36, 115, 38]])
def test_surface_rejects_damaged_dem_bounds(api, monkeypatch, tmp_path, bad):
    import json
    from app import planning_adjustment_service
    client, factory, _ = api
    with factory.begin() as session:
        session.get(PlanningPlan, "P1").raw_snapshot = {"terrain_fingerprint": "frozen-dem"}
    meta = tmp_path / "data/raw/dem/dem_current.json"
    meta.parent.mkdir(parents=True)
    meta.write_text(json.dumps({"source_sha256": "a" * 64, "bbox": bad, "source": "测试"}), encoding="utf-8")
    monkeypatch.setattr(resources, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(planning_adjustment_service, "terrain_fingerprint", lambda: "frozen-dem")
    data = query(client, "surface", snapshot_id="SNAP-P02").json()["data"]
    assert data["terrain"] is None and "无效" in data["terrain_notice"]


@pytest.mark.parametrize("path,params,code,status", [
    ("network", {"task_id": "other"}, 2001, 404),
    ("network", {"snapshot_id": "other"}, 1203, 409),
    ("links/missing", {"snapshot_id": "SNAP-P02"}, 1002, 404),
    ("paths", {"snapshot_id": "SNAP-P02", "demand_id": "missing"}, 1002, 404),
    ("links/L1", {}, 1001, 422), ("paths", {}, 1001, 422),
    ("network", {"context": "planning"}, 1001, 422),
    ("network", {"task_id": "bad id"}, 1001, 422),
    ("network", {"extra": "unsupported"}, 1001, 422)])
def test_rejected_queries(api, path, params, code, status):
    response = query(api[0], path, **params)
    assert response.status_code == status and response.json()["code"] == code, response.text
    assert response.json()["data"] is None


def test_missing_plan_and_duplicate_queries_and_body(api):
    client = api[0]
    assert client.get("/api/v1/gis/plans/missing/network?context=gis&task_id=T1").status_code == 404
    assert client.get("/api/v1/gis/plans/P1/network?context=gis&task_id=T1&task_id=T2").status_code == 422
    assert client.get("/api/v1/gis/plans/P1/network?context=gis").status_code == 422
    response = client.request("GET", "/api/v1/gis/plans/P1/network?context=gis&task_id=T1", content=b"x")
    assert response.status_code == 422


@pytest.mark.parametrize("mutation", [
    lambda r: r["nodes"].append(deepcopy(r["nodes"][0])),
    lambda r: r["nodes"][0].update(coordinate=[181.0, 37.0]),
    lambda r: r["nodes"][0].update(alert="false"),
    lambda r: r["devices"][0].update(stationId="missing"),
    lambda r: r["devices"][0].update(deviceClass="VUHF"),
    lambda r: r["links"][0].update(deviceA="EB"),
    lambda r: r["links"][0].update(frequencyKhz="7000"),
    lambda r: r["configuration"]["routes"][0].update(nodeIds=["A", "B"]),
    lambda r: r["configuration"]["routes"][1].update(linkIds=["L2", "L1"]),
    lambda r: r["configuration"]["routes"].append({**r["configuration"]["routes"][0], "id": "R3"}),
    lambda r: r.update(snapshot_id=None),
    lambda r: r.update(nodes=None)])
def test_corrupt_frozen_data_is_not_silently_repaired(api, mutation):
    client, factory, _ = api
    edit(factory, "result_snapshot", mutation)
    response = query(client)
    assert response.status_code == 409 and response.json()["code"] == 1203, response.text


def test_bad_demand_device_binding_is_rejected(api):
    client, factory, _ = api
    edit(factory, "input_snapshot", lambda data: data["demands"][0].update(sourceDeviceId="EC"))
    assert query(client).status_code == 409


def test_missing_paths_and_unallocated_frequency_stay_unknown(api):
    client, factory, _ = api
    edit(factory, "result_snapshot", lambda data: data.update(configuration=None))
    edit(factory, "result_snapshot", lambda data: data["links"][0].update(frequencyKhz=0))
    data = query(client).json()["data"]
    assert data["paths_state"] == "missing" and data["paths_message"] and data["routes"] == []
    assert data["links"][0]["frequency_khz"] is None
    assert query(client, "paths", snapshot_id="SNAP-P02").json()["data"]["paths_state"] == "missing"


def test_actual_identity_gate_and_error_envelope(api, monkeypatch):
    client = api[0]
    monkeypatch.delenv("FRONTEND_INTEGRATION_DEMO")
    assert query(client).status_code == 401
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    response = client.get("/api/v1/gis/plans/P1/network?context=gis&task_id=T1", cookies={identity.COOKIE: "invalid"})
    assert response.status_code == 409 and response.json()["code"] == 1106
    original = resources.session_identity()
    monkeypatch.setattr(resources, "session_identity", lambda: {**original, "permissions": []})
    assert query(client).status_code == 403


@pytest.mark.parametrize("kind,code", [("configuration", 5001), ("sql", 5002)])
def test_database_failure_does_not_fallback_or_leak(api, monkeypatch, kind, code):
    def fail():
        if kind == "configuration":
            raise DatabaseConfigurationError("secret connection configuration")
        raise OperationalError("SELECT secret", None, Exception("secret"))
    monkeypatch.setattr(service, "get_session_factory", fail)
    response = query(api[0])
    assert response.status_code == 503 and response.json()["code"] == code
    assert "secret" not in response.text


def test_independent_sqlite_reopen_reads_same_frozen_content(api):
    client, _, db = api
    expected = query(client).json()["data"]
    second = create_engine("sqlite:///" + db.as_posix())
    try:
        actual = service.network("P1", "T1", "SNAP-P02", factory=sessionmaker(bind=second))
        assert actual == expected
    finally:
        second.dispose()


def test_isolated_socket_http_projection_and_errors(api, monkeypatch):
    # 使用本组固定端口及构造库，只证明真实HTTP传输，不冒充主页面或算法验收。
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(("127.0.0.12", 8112))
    except OSError:
        listener.close()
        pytest.skip("P02隔离端口不可绑定，不抢占或改用其他端口")
    config = uvicorn.Config(api[0].app, log_level="error", access_log=False, lifespan="off", ws="none")
    server = uvicorn.Server(config)
    thread = Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    try:
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert server.started, "隔离服务未启动"
        with httpx.Client(base_url="http://127.0.0.12:8112", trust_env=False, timeout=5) as client:
            root = "/api/v1/gis/plans/P1/"
            args = {"context": "gis", "task_id": "T1", "snapshot_id": "SNAP-P02"}
            for suffix in ("network", "links/L1", "paths"):
                response = client.get(root + suffix, params=args)
                assert response.status_code == 200 and response.json()["code"] == 0
                assert response.json()["data"]["identity"]["snapshot_id"] == "SNAP-P02"
            for suffix, fields, status, code in [
                ("network", {**args, "task_id": "other"}, 404, 2001),
                ("network", {**args, "snapshot_id": "other"}, 409, 1203),
                ("network", {**args, "extra": "unknown"}, 422, 1001),
                ("links/missing", args, 404, 1002),
            ]:
                response = client.get(root + suffix, params=fields)
                assert response.status_code == status and response.json()["code"] == code
            monkeypatch.delenv("FRONTEND_INTEGRATION_DEMO")
            response = client.get(root + "network", params=args)
            assert response.status_code == 401 and response.json()["code"] == 1101
    finally:
        server.should_exit = True
        if thread.ident is not None:
            thread.join(timeout=10)
        listener.close()
    assert not thread.is_alive(), "隔离HTTP服务未正常退出"


def _main_plans_get_rows(factory):
    with factory() as session:
        return {
            model.__tablename__: [
                {column.key: deepcopy(getattr(row, column.key)) for column in model.__table__.columns}
                for row in session.scalars(select(model)).all()
            ]
            for model in (PlanningTask, PlanningTaskRevision, PlanningJob, PlanningPlan, PlanningCurrentPlan)
        }


@pytest.fixture
def main_plans_get_api(api, monkeypatch):
    """真实main handler/service + 现有构造库；身份仅stub边界，不是LOCAL集成。"""
    client, factory, db = api
    # 不启动main.app的middleware/lifespan，也不使用调用进程的运行数据库。
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + db.as_posix())
    from app import main as main_module

    monkeypatch.setattr(main_module.planning_plan_service, "get_session_factory", lambda: factory)
    auth = {"authenticated": True, "permissions": {"planning.view", "situation.view"}, "calls": []}

    def require_stub(request, permission=None, *, writing=False):
        assert request.method == "GET" and writing is False
        auth["calls"].append(permission)
        if not auth["authenticated"]:
            raise identity.IdentityError("handler身份边界stub：未鉴权", 1101, 401)
        if permission not in auth["permissions"]:
            raise identity.IdentityError("handler身份边界stub：缺少权限", 1104, 403)
        return {"permissions": sorted(auth["permissions"])}

    monkeypatch.setattr(main_module.integration_identity, "require", require_stub)
    client.app.add_api_route("/api/v1/plans/{solution_id}", main_module.plans_get, methods=["GET"])
    before = _main_plans_get_rows(factory)
    with factory() as session:
        engine = session.get_bind()
    mutations = []

    def observe_sql(_connection, _cursor, statement, _parameters, _context, _executemany):
        operation = statement.lstrip().split(None, 1)[0].upper()
        if operation in {"INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP", "TRUNCATE"}:
            mutations.append(statement)

    event.listen(engine, "before_cursor_execute", observe_sql)
    try:
        yield client, factory, auth
    finally:
        event.remove(engine, "before_cursor_execute", observe_sql)
        assert mutations == [], "main详情GET不得发出业务或DDL写入"
        assert _main_plans_get_rows(factory) == before, "main详情GET不得改任务/作业/冻结方案/当前指针"


def test_main_plans_get_gis_matches_planning_and_keeps_historical_snapshot(main_plans_get_api, monkeypatch):
    client, factory, auth = main_plans_get_api
    monkeypatch.setattr(resources, "_rows", lambda *args: pytest.fail("不得用当前资源修补历史方案"))
    planning = client.get("/api/v1/plans/P1", params={"context": "planning", "task_id": "T1"})
    assert planning.status_code == 200, planning.text
    # planning分支的身份middleware不在本handler测试宿主中；这里只验兼容响应。
    assert auth["calls"] == []
    gis = client.get("/api/v1/plans/P1", params={"context": "gis", "task_id": "T1"})
    assert gis.status_code == 200, gis.text
    assert auth["calls"] == ["planning.view", "situation.view"]
    assert gis.json() == planning.json()
    data = gis.json()["data"]
    assert data["plan_id"] == "P1" and data["task_id"] == "T1" and data["version"] == "V1"
    assert data["input_version"] == "I1" and data["condition_version"] == "C1"
    assert data["resource_revision"] == "resource-old"
    assert data["source_changed"] is True and data["current"] is False
    assert data["state"] == "CONFIRMED"
    assert data["input"] == frozen_input() and data["result"] == frozen_result()
    with factory() as session:
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").result_snapshot == frozen_result()


@pytest.mark.parametrize("context", ["ledger", "demo", "unknown", "", None])
def test_main_plans_get_rejects_unknown_context(main_plans_get_api, context):
    client, _, auth = main_plans_get_api
    params = {"task_id": "T1", **({"context": context} if context is not None else {})}
    response = client.get("/api/v1/plans/P1", params=params)
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert response.json()["data"] is None
    assert auth["calls"] == []


@pytest.mark.parametrize("permissions", [set(), {"planning.view"}, {"situation.view"}])
def test_main_plans_get_gis_requires_both_permissions(main_plans_get_api, permissions):
    client, _, auth = main_plans_get_api
    auth["permissions"] = permissions
    response = client.get("/api/v1/plans/P1", params={"context": "gis", "task_id": "T1"})
    assert response.status_code == 403 and response.json()["code"] == 1104, response.text
    assert response.json()["data"] is None
    assert auth["calls"] == (["planning.view", "situation.view"]
                             if "planning.view" in permissions else ["planning.view"])


def test_main_plans_get_gis_unauthenticated_preserves_401(main_plans_get_api):
    client, _, auth = main_plans_get_api
    auth["authenticated"] = False
    response = client.get("/api/v1/plans/P1", params={"context": "gis", "task_id": "T1"})
    assert response.status_code == 401 and response.json()["code"] == 1101, response.text
    assert response.json()["data"] is None
    assert auth["calls"] == ["planning.view"]


@pytest.mark.parametrize("plan_id,task_id", [("P1", "OTHER"), ("MISSING", "T1")])
def test_main_plans_get_gis_task_mismatch_or_missing_is_404(main_plans_get_api, plan_id, task_id):
    client, _, auth = main_plans_get_api
    response = client.get("/api/v1/plans/" + plan_id, params={"context": "gis", "task_id": task_id})
    assert response.status_code == 404 and response.json()["code"] == 2001, response.text
    assert response.json()["data"] is None
    assert auth["calls"] == ["planning.view", "situation.view"]


def test_main_plans_get_without_task_keeps_legacy_dispatch(main_plans_get_api, monkeypatch):
    from app import main as main_module
    client, _, auth = main_plans_get_api
    calls = []
    expected = {"code": 0, "message": "legacy-dispatch-stub", "data": {"solution_id": "OLD1"}}

    def legacy(plan_id):
        calls.append(plan_id)
        return expected

    monkeypatch.setattr(main_module, "get_plan", legacy)
    response = client.get("/api/v1/plans/OLD1", params={"context": "gis"})
    assert response.status_code == 200 and response.json() == expected
    assert calls == ["OLD1"] and auth["calls"] == []
