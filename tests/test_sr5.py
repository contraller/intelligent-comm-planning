import ast
import csv
import io
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "algorithm-service"))

from diagnosis.sr5 import FaultEngine, _eval_condition
from app import fault as service
from app import kg
from app import planning_w3
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(planning_w3, "TASK_DIR", tmp_path / "tasks")
    monkeypatch.setattr(service, "STORE_PATH", tmp_path / "scenarios.json")
    monkeypatch.setattr(service, "REPORT_DIR", tmp_path / "reports")
    monkeypatch.setattr(service, "_SCENARIOS", None)
    monkeypatch.setattr(service, "_ENGINE", None)
    monkeypatch.setattr(kg, "STORE_PATH", tmp_path / "graph.json")
    monkeypatch.setattr(kg, "_GRAPH", None)
    monkeypatch.setattr(kg, "_STATE", None)
    with TestClient(app) as api:
        yield api


def completed(api, task_id):
    for _ in range(100):
        body = api.get("/api/v1/fault/tasks/" + task_id).json()
        if body["code"] != 2002:
            return body
        time.sleep(0.01)
    pytest.fail("SR-5 task did not finish")


def test_graph_has_case_provenance_and_rejects_executable_rules():
    engine = FaultEngine()
    rows = engine.graph.to_rows("fault")
    assert len(rows) >= 500
    with (ROOT / "data" / "fault" / "knowledge_graph" / "fault_triples_v1.csv").open(
            encoding="utf-8", newline="") as handle:
        assert list(csv.DictReader(handle)) == [
            {key: str(value) for key, value in row.items()} for row in rows]
    assert all("#FC-" in row["source_doc"] and "CONSTRUCTED" in row["source_doc"]
               for row in rows)
    with pytest.raises(ValueError, match="Unsupported"):
        _eval_condition(ast.parse("__import__('os').system('echo no')", mode="eval"),
                        {"symptom_ids": set()})


def test_scenario_crud_validation_and_persistence(client):
    example = service._engine().default_scenarios[0]
    invalid = {"scenario_name": "bad", "faults": [{"object_type": "DEVICE",
                "object_id": "DV-0106", "fault_type": "LINK_DOWN"}]}
    assert client.post("/api/v1/fault/scenarios/validate", json=invalid).json()["code"] == 3003
    created = client.post("/api/v1/fault/scenarios", json={
        "scenario_name": "added", "faults": example["faults"]}).json()
    assert created["code"] == 0
    sid = created["data"]["scenario_id"]
    assert client.put(f"/api/v1/fault/scenarios/{sid}", json={
        "scenario_name": "updated", "faults": example["faults"]}).json()["data"]["scenario_name"] == "updated"
    assert client.delete(f"/api/v1/fault/scenarios/{sid}").json()["code"] == 0
    service._SCENARIOS = None
    assert client.get(f"/api/v1/fault/scenarios/{sid}").json()["code"] == 1002


def test_four_fault_types_and_reports(client):
    expected = {"FS-0001": "HW_FAILURE", "FS-0002": "LINK_DOWN",
                "FS-0003": "SW_CONFIG", "FS-0004": "EMI"}
    for sid, kind in expected.items():
        submitted = client.post("/api/v1/fault/diagnose", json={"scenario_id": sid}).json()
        assert submitted["code"] == 0
        diagnosed = completed(client, submitted["data"]["task_id"])
        assert diagnosed["code"] == 0
        result = diagnosed["data"]["results"][0]
        assert diagnosed["data"]["fusion_mode"] == "TWO_WAY_DEGRADED"
        assert result["fused"]["fault_type"] == kind
        assert result["fused"]["need_manual_review"] is True
        assert result["branches"][2]["confidence"] is None
        impact_submit = client.post("/api/v1/fault/impact", json={
            "diagnose_task_id": submitted["data"]["task_id"]}).json()
        assert impact_submit["code"] == 0
        impacted = completed(client, impact_submit["data"]["task_id"])
        assert impacted["code"] == 0
        assert impacted["data"]["summary"]["affected_node_count"] >= 1
        assert {row["level"] for row in impacted["data"]["affected_nodes"]} <= {
            "SEVERE", "MODERATE", "MINOR"}
        node = impacted["data"]["affected_nodes"][0]
        filtered = client.get(f"/api/v1/fault/impact/{impact_submit['data']['task_id']}/nodes",
                              params={"node_role": node["node_role"], "region": node["region"]}).json()
        assert filtered["code"] == 0
        assert node in filtered["data"]["items"]
        assert all(row["node_role"] == node["node_role"] and row["region"] == node["region"]
                   for row in filtered["data"]["items"])
        if kind == "EMI":
            assert all(row["state"] == "DEGRADED" for row in impacted["data"]["affected_links"])
        suggestion = client.get("/api/v1/fault/suggestions", params={
            "diagnose_task_id": submitted["data"]["task_id"],
            "impact_task_id": impact_submit["data"]["task_id"]}).json()
        assert suggestion["code"] == 0
        assert suggestion["data"]["suggestions"]
        if sid == "FS-0001":
            for fmt, signature in (("json", b"{"), ("docx", b"PK"), ("pdf", b"%PDF")):
                report = client.post("/api/v1/fault/report", json={
                    "diagnose_task_id": submitted["data"]["task_id"],
                    "impact_task_id": impact_submit["data"]["task_id"],
                    "format": fmt}).json()
                assert report["code"] == 0
                downloaded = client.get(report["data"]["report_url"])
                assert downloaded.content.startswith(signature)
            xlsx = client.get(f"/api/v1/fault/impact/{impact_submit['data']['task_id']}/export?format=xlsx")
            assert xlsx.content.startswith(b"PK")
            png = client.get(f"/api/v1/fault/impact/{impact_submit['data']['task_id']}/export?format=png")
            assert png.content.startswith(b"\x89PNG")


def test_observation_diagnosis_does_not_require_ground_truth(client):
    example = service._engine().default_scenarios[0]["faults"][0]
    observation = {key: value for key, value in example.items() if key != "fault_type"}
    submitted = client.post("/api/v1/fault/diagnose/observations", json={
        "faults": [observation]}).json()
    assert submitted["code"] == 0
    result = completed(client, submitted["data"]["task_id"])
    assert result["code"] == 0
    assert result["data"]["results"][0]["fused"]["fault_type"] == "HW_FAILURE"
    assert client.post("/api/v1/fault/diagnose/observations", json={
        "faults": [example]}).json()["code"] == 1001
    assert client.post("/api/v1/fault/diagnose/observations", json={
        "faults": [dict(observation, symptom_ids=["UNKNOWN"])]}).json()["code"] == 1002


def test_reviewed_diagnosis_feedback_enters_kg_and_future_inference(client):
    example = service._engine().default_scenarios[0]["faults"][0]
    observation = {key: value for key, value in example.items() if key != "fault_type"}
    submitted = client.post("/api/v1/fault/diagnose/observations", json={
        "scenario_name": "feedback case", "faults": [observation]}).json()
    task_id = submitted["data"]["task_id"]
    diagnosed = completed(client, task_id)
    assert client.get("/api/v1/fault/suggestions", params={
        "diagnose_task_id": task_id}).json()["code"] == 0

    feedback = client.post(f"/api/v1/fault/diagnoses/{task_id}/feedback", json={
        "reviewer": "operator-a", "result_index": 0}).json()
    assert feedback["code"] == 0
    assert feedback["data"]["requires_kg_review"] is True
    case_id = feedback["data"]["case_id"]
    change_id = feedback["data"]["change_id"]
    assert client.post(f"/api/v1/fault/diagnoses/{task_id}/feedback", json={
        "reviewer": "operator-a", "result_index": 0}).json()["code"] == 1001
    assert client.get("/api/v1/kg/triples", params={"entity": case_id}).json()["data"]["total"] == 0
    assert client.post(f"/api/v1/kg/updates/{change_id}/review", json={
        "approve": True, "reviewer": "knowledge-reviewer"}).json()["code"] == 0

    rows = client.get("/api/v1/kg/triples", params={"entity": case_id}).json()["data"]
    assert rows["total"] >= 7
    assert all("UNAUTHENTICATED_REVIEW" in row["source_doc"] for row in rows["items"])
    assert client.get("/api/v1/kg/quality").json()["data"]["status"] == "PASS"
    rerun = client.post("/api/v1/fault/diagnose/observations", json={
        "scenario_name": "feedback reused", "faults": [observation]}).json()
    rerun_result = completed(client, rerun["data"]["task_id"])["data"]
    result = rerun_result["results"][0]
    assert rerun_result["data_source"] == "MIXED_UNVERIFIED"
    kg_branch = next(row for row in result["branches"] if row["source"] == "KG")
    assert case_id in {row["case_id"] for row in kg_branch["evidence"]["candidate_rankings"]}


def test_minor_impact_for_nonmandatory_degraded_endpoint(monkeypatch):
    engine = FaultEngine()
    scenario = next(s for s in engine.default_scenarios if s["scenario_id"] == "FS-0004")
    lid = scenario["faults"][0]["object_id"]
    link = engine.links[lid]
    endpoints = {link["node_a_id"], link["node_b_id"]}
    outer = [nid for nid in engine.nodes if nid not in endpoints][:2]
    demand = next(d for d in engine.demands.values() if d["is_mandatory"] != "true")
    route = {"demand_id": demand["demand_id"], "primary": {
        "node_path": [outer[0], link["node_a_id"], link["node_b_id"], outer[1]],
        "link_path": [lid]}, "backup": None}
    monkeypatch.setattr(engine, "_routes", lambda _: ([route], {lid: link}, "TEST"))
    impact = engine.impact(scenario, {})
    levels = {row["node_id"]: row["level"] for row in impact["affected_nodes"]}
    assert levels[outer[0]] == "MINOR"
    assert levels[outer[1]] == "MINOR"
    assert all(levels[nid] == "MODERATE" for nid in endpoints)


def test_csv_and_xlsx_batch_import(client):
    example = service._engine().default_scenarios[0]
    import json
    row = {"scenario_name": "bulk", "faults": json.dumps(example["faults"], ensure_ascii=False)}
    csv_buffer = io.StringIO()
    writer = csv.DictWriter(csv_buffer, fieldnames=list(row))
    writer.writeheader()
    writer.writerow(row)
    response = client.post("/api/v1/fault/scenarios/import", files={
        "file": ("scenarios.csv", csv_buffer.getvalue().encode("utf-8"), "text/csv")}).json()
    assert response["data"]["imported"] == 1

    from openpyxl import Workbook
    book = Workbook()
    book.active.append(list(row))
    book.active.append(list(row.values()))
    xlsx_buffer = io.BytesIO()
    book.save(xlsx_buffer)
    response = client.post("/api/v1/fault/scenarios/import", files={
        "file": ("scenarios.xlsx", xlsx_buffer.getvalue(),
                 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}).json()
    assert response["data"]["imported"] == 1


def test_plan_impact_and_invalid_input(client, tmp_path, monkeypatch):
    from app import planning_w4
    monkeypatch.setattr(planning_w4, "PLAN_DIR", tmp_path / "plans")
    scenario = service._scenarios()["FS-0002"]
    link_id = next(f["object_id"] for f in scenario["faults"]
                   if f["object_type"] == "LINK")
    link = service._engine().links[link_id]
    plan_id = planning_w4._save_plan("SR4_FLOW", {"check_passed": False},
                                     {"links": [link], "routes": {"routes": [{
                                         "demand_id": "CD-0010", "primary": {
                                             "node_path": [link["node_a_id"], link["node_b_id"]],
                                             "link_path": [link["link_id"]]}, "backup": None}]}})
    planning_w4._PLANS.pop(plan_id)
    try:
        invalid = client.post("/api/v1/fault/scenarios/validate", json={
            "scenario_name": "bad params", "faults": [{"object_type": "LINK",
            "object_id": link_id, "fault_type": "LINK_DOWN", "params": "bad"}]}).json()
        assert invalid["code"] == 1001
        diagnosis = client.post("/api/v1/fault/diagnose", json={
            "scenario_id": "FS-0002", "network_solution_id": plan_id}).json()
        assert completed(client, diagnosis["data"]["task_id"])["code"] == 0
        impact = client.post("/api/v1/fault/impact", json={
            "diagnose_task_id": diagnosis["data"]["task_id"]}).json()
        result = completed(client, impact["data"]["task_id"])
        assert result["data"]["network_solution_id"] == plan_id
        assert result["data"]["affected_links"][0]["link_id"] == link_id
        assert result["data"]["affected_demands"][0]["state"] == "INTERRUPTED"
        assert result["data"]["summary"]["total_bandwidth_loss_kbps"] > 0
        planning_w4._PLANS[plan_id]["detail"]["links"] = []
        rejected = client.post("/api/v1/fault/impact", json={
            "diagnose_task_id": diagnosis["data"]["task_id"]}).json()
        assert rejected["code"] == 1002
    finally:
        planning_w4._PLANS.pop(plan_id, None)
