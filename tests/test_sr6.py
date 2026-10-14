import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import fault, kg
from app.main import app
from app.runtime_store import read_json, write_json


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(kg, "STORE_PATH", tmp_path / "graph.json")
    monkeypatch.setattr(kg, "_GRAPH", None)
    monkeypatch.setattr(kg, "_STATE", None)
    with TestClient(app) as api:
        yield api


def test_three_domains_and_device_query(client):
    stats = client.get("/api/v1/kg/stats").json()["data"]
    assert stats["graph"]["by_graph"]["fault"] == 2742
    assert stats["graph"]["by_relation"]["recordedIn"] == 240
    assert stats["graph"]["by_relation"]["diagnosedBy"] == 960
    assert stats["graph"]["by_relation"]["occursOn"] == 240
    assert stats["graph"]["by_relation"]["hasRole"] == 132
    assert stats["graph"]["by_graph"]["device"] > 0
    assert stats["graph"]["by_graph"]["network"] > 0
    assert stats["link_state"]["records"] == 2500
    assert stats["sr4_plan_validated"] is False
    device = client.get("/api/v1/kg/device/DM-0001/knowledge").json()
    assert device["code"] == 0
    assert device["data"]["model"]["attrs"]["dataset_origin"] == "CONSTRUCTED"
    assert device["data"]["model"]["attrs"]["source_doc"]
    eid = device["data"]["model"]["eid"]
    assert client.get(f"/api/v1/kg/entity/{eid}").json()["code"] == 0
    assert client.post("/api/v1/kg/query", json={"entity_id": eid, "relations": ["hasParameter"]}).json()["data"]["paths"]
    assert client.get("/api/v1/kg/search", params={"q": "DM-0001", "type": "DeviceModel"}).json()["code"] == 0


def test_fault_inference_and_link_state(client):
    result = client.post("/api/v1/kg/infer", json={"symptom_ids": ["SY-0001"]}).json()
    assert result["code"] == 0
    assert result["data"]["candidates"]
    assert "CONSTRUCTED" in result["data"]["candidates"][0]["evidence"][0]["source_doc"]
    assert client.post("/api/v1/kg/infer", json={"symptom_ids": ["NOPE"]}).json()["code"] == 1001
    assessed = client.post("/api/v1/kg/link-state/evaluate", json={"metrics": [
        {"link_id": "LK-0001", "snr_db": 8.4, "ber": 0.00021,
         "packet_loss_rate": 0.06, "delay_ms": 95, "throughput_kbps": 38}
    ]}).json()
    assert assessed["code"] == 0
    assert assessed["data"]["results"][0]["link_state"] in {
        "FAULT", "WARNING", "GOOD", "EXCELLENT"}
    assert assessed["data"]["calibrated_on_real_data"] is False
    assert client.post("/api/v1/kg/link-state/evaluate", json={"metrics": [{"snr_db": "abc"}]}).json()["code"] == 1001


def test_review_persistence_and_rollback(client):
    before = client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"]
    submitted = client.post("/api/v1/kg/updates", json={"submitter": "tester", "ops": [{
        "op": "add_triple", "head_type": "DeviceModel", "head": "DM-0001",
        "relation": "hasFunction", "tail_type": "Function", "tail": "测试功能",
        "source": "test_sr6.py [CONSTRUCTED]"
    }]}).json()
    assert submitted["data"]["status"] == "PENDING"
    assert client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"] == before
    cid = submitted["data"]["change_id"]
    assert client.post(f"/api/v1/kg/updates/{cid}/review", json={"approve": True,
                       "reviewer": "reviewer"}).json()["data"]["version"] == 2
    assert client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"] == before + 1
    kg._GRAPH = None
    kg._STATE = None
    assert client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"] == before + 1
    rolled = client.post("/api/v1/kg/versions/1/rollback", json={"reviewer": "reviewer"}).json()
    assert rolled["data"]["version"] == 3
    assert client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"] == before
    assert any(item["op"] == "ROLLBACK_REVIEWER" for item in
               client.get("/api/v1/kg/audit").json()["data"]["items"])


def test_invalid_query_and_update_are_rejected(client):
    assert client.get("/api/v1/kg/entity/missing").json()["code"] == 4001
    assert client.post("/api/v1/kg/query", json={"entity_id": "E-00001",
                       "relations": ["notARelation"]}).json()["code"] == 1001
    assert client.post("/api/v1/kg/updates", json={"ops": [{
        "op": "add_triple", "head_type": "Fault", "head": "test",
        "relation": "hasSymptom", "tail_type": "Symptom", "tail": "missing source"
    }]}).json()["code"] == 1001
    assert client.post("/api/v1/kg/updates", json={"ops": ["not an object"]}).json()["code"] == 1001
    assert client.post("/api/v1/kg/updates", json={"ops": [{
        "op": "add_triple", "head_type": "Device", "head": "DV-0001",
        "relation": "hasSymptom", "tail_type": "Parameter", "tail": "bad",
        "source": "test"
    }]}).json()["code"] == 1001


def test_quality_and_traceable_triple_query(client):
    quality = client.get("/api/v1/kg/quality").json()
    assert quality["code"] == 0
    assert quality["data"]["status"] == "PASS"
    assert quality["data"]["checks"]["incomplete_fault_cases"] == 0
    assert quality["data"]["provenance"]["field_validated"] is False
    triples = client.get("/api/v1/kg/triples", params={
        "graph": "fault", "relation": "hasSymptom", "source": "FC-0001", "limit": 10
    }).json()
    assert triples["code"] == 0
    assert triples["data"]["total"] >= 1
    assert all(row["relation"] == "hasSymptom" for row in triples["data"]["items"])
    assert all("FC-0001" in row["source_doc"] for row in triples["data"]["items"])
    assert client.get("/api/v1/kg/triples", params={"relation": "bad"}).json()["code"] == 1001


def test_approved_fault_knowledge_reaches_diagnosis_and_rollback(client):
    scenario = fault._engine().default_scenarios[0]
    before = fault._diagnose_live(scenario, {})["results"][0]["branches"][1]
    case_id = before["evidence"]["case_id"]
    graph, _ = kg._load()
    fault_id = graph.get("Fault", case_id)
    old_cause = next(graph.outgoing(fault_id, "causedBy"))
    old_step = next(graph.outgoing(fault_id, "diagnosedBy"))
    new_step = graph.ent(old_step["tail"])["name"].split(":", 1)[0] + ":reviewed test step"
    new_cause = "reviewed test cause"
    submitted = client.post("/api/v1/kg/updates", json={"submitter": "tester", "ops": [
        {"op": "remove_triple", "triple_id": old_cause["tid"]},
        {"op": "remove_triple", "triple_id": old_step["tid"]},
        {"op": "add_triple", "head_type": "Fault", "head": case_id,
         "relation": "causedBy", "tail_type": "Cause", "tail": new_cause,
         "source": "test_sr6.py [CONSTRUCTED]"},
        {"op": "add_triple", "head_type": "Fault", "head": case_id,
         "relation": "diagnosedBy", "tail_type": "DiagnosisStep", "tail": new_step,
         "source": "test_sr6.py [CONSTRUCTED]"}
    ]}).json()
    assert submitted["code"] == 0
    assert fault._diagnose_live(scenario, {})["results"][0]["branches"][1]["root_cause"] == before["root_cause"]
    cid = submitted["data"]["change_id"]
    assert client.post(f"/api/v1/kg/updates/{cid}/review", json={
        "approve": True, "reviewer": "reviewer"}).json()["code"] == 0
    after = fault._diagnose_live(scenario, {})["results"][0]["branches"][1]
    assert after["root_cause"] == new_cause
    assert "reviewed test step" in after["steps"]
    assert "test_sr6.py [CONSTRUCTED]" in after["evidence"]["source_docs"]
    diagnosis = fault._diagnose_live(scenario, {})
    assert "reviewed test step" in fault._engine().suggestions(diagnosis)["suggestions"][-1]["steps"]
    assert client.post("/api/v1/kg/versions/1/rollback", json={
        "reviewer": "reviewer"}).json()["code"] == 0
    restored = fault._diagnose_live(scenario, {})["results"][0]["branches"][1]
    assert restored["root_cause"] == before["root_cause"]
    assert restored["steps"] == before["steps"]


def test_reviewed_link_threshold_updates_evaluator_and_rollback(client):
    _, state = kg._load()
    rule = next(r for r in state.rules if r["band"] == "HF" and r["metric"] == "snr_db"
                and r["state"] == "EXCELLENT")
    value = rule["threshold"] + 1
    observation = {"metrics": [{"band": "HF", "snr_db": value}]}
    url = "/api/v1/kg/link-state/evaluate"
    assert client.post(url, json=observation).json()["data"]["results"][0]["link_state"] == "EXCELLENT"
    submitted = client.post("/api/v1/kg/updates", json={"submitter": "tester", "ops": [{
        "op": "set_link_rule", "rule_id": rule["rule_id"],
        "threshold_value": value + 100, "source": "test_sr6.py [CONSTRUCTED]"
    }]}).json()
    assert submitted["code"] == 0
    cid = submitted["data"]["change_id"]
    assert client.post(f"/api/v1/kg/updates/{cid}/review", json={
        "approve": True, "reviewer": "reviewer"}).json()["code"] == 0
    assert client.post(url, json=observation).json()["data"]["results"][0]["link_state"] != "EXCELLENT"
    kg._GRAPH = None
    kg._STATE = None
    assert client.post(url, json=observation).json()["data"]["results"][0]["link_state"] != "EXCELLENT"
    assert client.post("/api/v1/kg/versions/1/rollback", json={
        "reviewer": "reviewer"}).json()["code"] == 0
    assert client.post(url, json=observation).json()["data"]["results"][0]["link_state"] == "EXCELLENT"


def test_failed_batch_review_does_not_partially_apply(client):
    graph, _ = kg._load()
    tid = next(iter(graph.triples))
    submitted = client.post("/api/v1/kg/updates", json={"submitter": "tester", "ops": [
        {"op": "remove_triple", "triple_id": tid},
        {"op": "set_weight", "triple_id": tid, "weight": 0.1}
    ]}).json()
    assert submitted["code"] == 0
    cid = submitted["data"]["change_id"]
    assert client.post(f"/api/v1/kg/updates/{cid}/review", json={
        "approve": True, "reviewer": "reviewer"}).json()["code"] == 1001
    assert tid in graph.triples
    assert graph.version == 1
    assert next(p for p in graph.pending if p["change_id"] == cid)["status"] == "PENDING"


def test_old_saved_graph_migrates_diagnostic_steps(client):
    graph, _ = kg._load()
    for tid, triple in list(graph.triples.items()):
        if triple["relation"] == "diagnosedBy":
            graph.remove_triple(tid)
    graph.versions[0]["snapshot"] = graph._snapshot()
    write_json(kg.STORE_PATH, {"snapshot": graph._snapshot(), "version": 1,
                               "versions": graph.versions, "pending": graph.pending,
                               "log": graph.log})
    kg._GRAPH = None
    kg._STATE = None
    migrated, _ = kg._load()
    assert migrated.version == 2
    assert migrated.stats()["by_relation"]["diagnosedBy"] == 960
    assert migrated.stats()["by_relation"]["occursOn"] == 240
    assert read_json(kg.STORE_PATH)["schema_revision"] == 3
