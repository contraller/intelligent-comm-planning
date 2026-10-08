import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import kg
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(kg, "STORE_PATH", tmp_path / "graph.json")
    monkeypatch.setattr(kg, "_GRAPH", None)
    monkeypatch.setattr(kg, "_STATE", None)
    with TestClient(app) as api:
        yield api


def test_three_domains_and_device_query(client):
    stats = client.get("/api/v1/kg/stats").json()["data"]
    assert stats["graph"]["by_graph"]["fault"] == 1302
    assert stats["graph"]["by_relation"]["recordedIn"] == 240
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
