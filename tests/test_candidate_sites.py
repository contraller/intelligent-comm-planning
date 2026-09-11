import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app.candidate_sites import filter_candidate_sites


def load_request(name):
    with (ROOT / "docs" / "api" / "sample_requests" / name).open(encoding="utf-8") as f:
        return json.load(f)


def test_candidate_sites_sample_request_returns_candidates():
    payload = load_request("candidate_sites_request.json")
    result = filter_candidate_sites(payload)

    assert result["code"] == 0
    assert result["data"]["task_id"] == "TS-0001"
    assert result["data"]["candidate_count"] == 120
    assert result["data"]["deployable_count"] >= 20
    assert result["data"]["candidates"]


def test_candidate_sites_rejects_unknown_task():
    payload = load_request("candidate_sites_request.json")
    payload["task_id"] = "TS-NOT-FOUND"

    result = filter_candidate_sites(payload)

    assert result["code"] == 1002
    assert result["data"] is None


def test_candidate_sites_constraint_branch_returns_suggestions():
    payload = load_request("candidate_sites_request.json")
    payload["constraints"]["max_slope_deg"] = 0
    payload["constraints"]["allowed_landcover"] = ["水域"]
    payload["constraints"]["road_max_distance_m"] = 1

    result = filter_candidate_sites(payload)

    assert result["code"] == 3001
    assert result["data"]["deployable_count"] < 20
    assert result["data"]["suggestions"]
