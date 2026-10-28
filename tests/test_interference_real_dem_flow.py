"""真实仓库DEM + 构造两节点网络的完整流程；结果不是现场实测证据。

仅复用既有小网络的设备、频点和拓扑副本，不使用其引擎或地形指纹。
运行会读取真实DEM/地物栅格并计算影响区域，应由主agent在浏览器结束后串行执行。
"""
from copy import deepcopy
import json
import math
from pathlib import Path

import pytest
from sqlalchemy import select

from test_interference_workbench_api import (
    BASE, body, data, frozen_sample, headers, read, save, scene_api, submit,
)
from app import resource_dataset_service as resources, resource_geography
from app.interference_analysis_engine import FrozenInterferenceEngine, _modules, digest
from app.interference_workbench_models import InterferenceWorkbenchRun as Run
from app.interference_workbench_router import router
from app.interference_workbench_service import InterferenceWorkbenchService
from app.planning_adjustment_service import terrain_fingerprint
from app.planning_plan_models import PlanningPlan
from app.resource_workspace_router import router as workspace_router
from app.task_input_models import PlanningTaskRevision

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = "真实仓库DEM + 构造小网络（realDEM + constructednetwork），非实测"


@pytest.fixture
def real_dem_constructed_network(frozen_sample):
    terrain_module = _modules()["terrain"]
    dem_header = Path(terrain_module.DEM_HEADER).resolve()
    landcover_header = Path(terrain_module.LC_HEADER).resolve()
    assert dem_header == (ROOT / "data/raw/dem/dem_current.json").resolve()
    assert landcover_header == (ROOT / "data/raw/landcover/landcover_taihang.json").resolve()
    assert dem_header.is_file() and landcover_header.is_file(), "真实DEM/地物元数据缺失，禁止合成兜底"
    fingerprint = terrain_fingerprint()
    assert isinstance(fingerprint, str) and len(fingerprint) == 64, "真实地形文件无法生成有效指纹"

    # 无参数构造真实DemTerrain，使用生产默认路径；不修改bbox、不替换采样方法。
    terrain = terrain_module.DemTerrain()
    assert terrain.name == "DEM"
    bounds = resource_geography.read_planning_bounds()
    assert resource_geography.valid_bounds(bounds), "当前真实DEM范围不可用"
    extents = [tuple(terrain.bbox), tuple(terrain._lc.bbox), tuple(bounds)]
    west, south = max(item[0] for item in extents), max(item[1] for item in extents)
    east, north = min(item[2] for item in extents), min(item[3] for item in extents)
    assert west < east and south < north
    offset = min(.005, (east - west) / 16, (north - south) / 16)
    positions = None
    # 有限个真实像元候选，排除NoData；不以DemTerrain的空值补零冒充真实高程。
    for x_fraction, y_fraction in ((.5, .5), (.6, .5), (.4, .5), (.5, .6), (.5, .4)):
        lon, lat = west + (east - west) * x_fraction, south + (north - south) * y_fraction
        candidate = [(lon - offset, lat), (lon + offset, lat), (lon, lat + offset / 5)]
        if all(terrain._dem.sample(*point) is not None and terrain._lc.sample(*point) is not None
               and math.isfinite(terrain.elevation(*point)) for point in candidate):
            positions = candidate
            break
    assert positions is not None, "构造小网络未找到真实DEM/地物有效像元，禁止钳位或补造地形"

    # 不修改模块级旧夹具；其原始构造网络只作为拓扑、设备和频点模板。
    raw = deepcopy(frozen_sample[1]["scene"]["plan_snapshot"]["raw_snapshot"])
    raw["terrain_fingerprint"] = fingerprint
    detail = raw["detail"]
    assert len(detail["nodes"]) == len(detail["devices"]) == 2 and len(detail["links"]) == 1
    for node, point in zip(detail["nodes"], positions[:2]):
        node["lon"], node["lat"] = str(point[0]), str(point[1])
    detail["links"][0]["distance_m"] = str(terrain_module.haversine_m(*positions[0], *positions[1]))
    detail["routes"] = {"routes": [{"demand_id": "C1", "primary": {
        "node_path": [node["node_id"] for node in detail["nodes"]], "link_path": ["L1"]}, "backup": None}]}
    return {"raw": raw, "frequency": frozen_sample[2], "source_coordinate": list(positions[2]),
            "fingerprint": fingerprint, "dem_header": str(dem_header), "landcover_header": str(landcover_header)}


def test_manual_source_full_flow_real_repository_dem_constructed_network(
        scene_api, real_dem_constructed_network, record_property):
    sample = real_dem_constructed_network
    client, factory, baseline, database_path, original_raw = scene_api
    assert database_path.resolve().is_relative_to((ROOT / "data/runtime/tmp").resolve())
    record_property("evidence", EVIDENCE)
    record_property("terrain_fingerprint", sample["fingerprint"])
    record_property("dem_header", sample["dem_header"])
    print(json.dumps({"evidence": EVIDENCE, "dem_header": sample["dem_header"],
        "landcover_header": sample["landcover_header"], "terrain_fingerprint": sample["fingerprint"],
        "nodes": 2, "links": 1, "database": str(database_path)}, ensure_ascii=False))

    client.app.include_router(workspace_router)
    data(client.post("/api/v1/auth/integration/switch", json={"accountId": "integration-editor"}, headers=headers(client)))
    manual = {"id": "REAL-DEM-MANUAL-J", "name": "真实DEM构造网络干扰源（非实测）",
        "coordinate": sample["source_coordinate"], "elevationM": None, "antennaHeightM": 0,
        "centerFreqKhz": sample["frequency"], "bandwidthKhz": 25, "txPowerDbm": -10,
        "antennaGainDbi": 0, "interferenceType": "NOISE", "patternType": "OMNI", "azimuthDeg": None,
        "dutyCycle": None, "active": True, "origin": "MANUAL"}
    saved = data(client.post("/api/v1/resource/workspace/changes", headers=headers(client), json={
        "context": "gis", "base_revision": baseline["revision"], "request_id": "real-dem-save-manual-source",
        "changes": {"newInterferences": [manual]}}))
    revision = saved["receipt"]["revision"]
    assert saved["receipt"]["changed"] is True
    saved_source = next(row for row in saved["result"]["resources"]["interferences"] if row["id"] == manual["id"])
    assert saved_source["antennaGainDbi"] == saved_source["antennaHeightM"] == 0
    assert saved_source["elevationM"] is saved_source["azimuthDeg"] is None
    assert saved_source["patternType"] == "OMNI"

    # 仅更新隔离夹具中的新计划；真实指纹随计划原始快照进入关联场景。
    plan_raw = {**deepcopy(original_raw), **sample["raw"]}
    with factory.begin() as session:
        plan = session.get(PlanningPlan, "P1")
        plan.resource_revision, plan.raw_snapshot = revision, plan_raw
        session.get(PlanningTaskRevision, "REV-P1").resource_revision = revision
    data(client.post("/api/v1/auth/integration/switch", json={"accountId": "integration-planner"}, headers=headers(client)))
    data(save(scene_api, body(scene_api, request_id="real-dem-save-scene", resource_revision=revision,
        interference_ids=[manual["id"]], name="真实DEM构造网络场景（非实测）", note=EVIDENCE)))
    scene = data(read(scene_api))["version"]
    assert scene["plan_snapshot"]["raw_snapshot"] == plan_raw
    assert scene["plan_snapshot"]["raw_snapshot"]["terrain_fingerprint"] == sample["fingerprint"]
    assert scene["interference_sources"][0]["source_row"]["elevation_m"] == ""
    assert scene["interference_sources"][0]["source_row"]["azimuth_deg"] == ""

    # 无terrain_provider、无fingerprint_provider：校验和执行均走默认真实地形与真实指纹。
    engine = FrozenInterferenceEngine()
    assert engine.terrain_provider is None and engine.fingerprint_provider is None
    assert engine.fingerprint() == sample["fingerprint"] == terrain_fingerprint()
    assert engine.probe_plan(scene["plan_snapshot"]) == []
    service = InterferenceWorkbenchService(factory, engine=engine)
    client.app.include_router(router)
    client.app.state.interference_workbench = service
    wb = (scene_api, service, engine, scene)
    resource_before = digest(resources.current())
    receipt = data(submit(wb, request_id="real-dem-submit-analysis"))
    path = BASE + "/runs/" + receipt["object_id"]
    accepted = data(client.get(path, params={"task_id": "T1"}))
    assert accepted["state"] == "PENDING" and accepted["source"] == scene
    assert len(accepted["analysis_parameters"]) == 1
    parameter_row = accepted["analysis_parameters"][0]
    assert parameter_row["interference_id"] == manual["id"]
    effective = parameter_row["parameters"]
    assert effective["antenna_gain_dbi"] == effective["antenna_height_m"] == 0
    assert effective["elevation_m"] is effective["azimuth_deg"] is None
    assert effective["pattern_type"] == "OMNI" and effective["duty_cycle"] == 1
    assert "DEM" in parameter_row["sources"]["elevation_m"]
    assert "冻结场景" in parameter_row["sources"]["antenna_gain_dbi"]

    assert service.run_once()
    final = data(client.get(path, params={"task_id": "T1"}))
    assert final["state"] == "SUCCESS", final["error"]
    assert final["result"]["summary"]["jammers"] == final["result"]["summary"]["links"] == 1
    assert final["result"]["affected_area"]["type"] == "FeatureCollection"
    assert all(math.isfinite(row["sinr_after_db"]) for field in ("affected_nodes", "affected_links")
               for row in final["result"][field])
    assert final["analysis_parameters"] == accepted["analysis_parameters"]
    assert final["source"] == scene and final["source_hash"] == accepted["source_hash"]
    assert terrain_fingerprint() == sample["fingerprint"]
    assert digest(resources.current()) == resource_before, "分析不得回写正式资源参数"
    with factory() as session:
        run = session.scalar(select(Run).where(Run.run_id == receipt["object_id"]))
        assert run.source_hash == digest(run.source_snapshot)
        assert run.result_hash == digest(run.result_snapshot)
        assert run.source_snapshot["scene"]["plan_snapshot"]["raw_snapshot"]["terrain_fingerprint"] == sample["fingerprint"]
        assert run.source_snapshot["analysis_parameters"] == accepted["analysis_parameters"]
    print(json.dumps({"evidence": EVIDENCE, "run_id": receipt["object_id"], "state": final["state"],
        "terrain_fingerprint": sample["fingerprint"], "effective_parameters": effective,
        "summary": final["result"]["summary"]}, ensure_ascii=False))
