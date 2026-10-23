"""M5 pure geography and service orchestration; no HTTP or database calls."""
from copy import deepcopy
import base64
import csv
from io import StringIO
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import resource_geography as geo
from app import resource_import_parser as parser
from app import resource_import_service as imports
from app import resource_workspace_service as workspace
from app.resource_dataset_service import ResourceDatasetError

BOUNDS = (113.14986111114996, 36.27597222221908, 114.9498611111502, 37.72402777777483)


@pytest.fixture
def snapshot():
    tables = {name: [] for name in parser.TABLE_IDS}
    tables["node.csv"] = [{"node_id": "N1", "node_name": "west station", "echelon": "I",
        "node_subtype": "I_FIXED", "parent_node_id": "", "node_role": "FIXED_STATION", "mobility": "FIXED",
        "lon": "113.500000123", "lat": "37.123456789", "elevation_m": "", "region": "", "device_class": "HF",
        "relay_capable": "true", "status": "", "is_key": "false", "remark": ""}]
    tables["device.csv"] = [{"device_id": "D1", "node_id": "N1", "model_id": "M1", "antenna_id": "A1",
        "antenna_height_m": "10", "tilt_deg": "", "azimuth_deg": "", "tx_power_dbm": "40",
        "work_freq_khz": "", "status": "", "install_time": "", "availability": "ACTIVE"}]
    tables["device_model.csv"] = [{"model_id": "M1", "model_name": "existing model", "device_class": "HF",
        "freq_min_khz": "1500", "freq_max_khz": "30000", "tx_power_max_dbm": "50"}]
    tables["antenna_model.csv"] = [{"antenna_id": "A1", "antenna_name": "existing antenna", "device_class": "HF"}]
    tables["interference_source.csv"] = [{"interference_id": "I1", "name": "west interference", "lon": "113.5",
        "lat": "37.1", "elevation_m": "", "antenna_height_m": "0", "center_freq_khz": "1500",
        "bandwidth_khz": "10", "tx_power_dbm": "-10", "antenna_gain_dbi": "", "interference_type": "NOISE",
        "pattern_type": "", "azimuth_deg": "", "duty_cycle": "", "active": "false"}]
    return {"revision": "resource-1111111111111111", "source_updated_at": "2026-10-24T00:00:00Z", "tables": tables}


def metadata():
    return {"crs": "EPSG:4326", "bbox": list(BOUNDS), "planning_bbox": [113.4, 36.5, 114.7, 37.5],
        "source_sha256": "a" * 64, "source": "declared DEM source"}


def csv_bytes(kind, rows):
    output = StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=parser.HEADERS[kind], extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


def parse(snapshot, kind, rows, bounds=BOUNDS, format="csv"):
    if format == "csv":
        data = csv_bytes(kind, rows)
    else:
        book = Workbook()
        book.remove(book.active)
        for sheet_kind, headers in parser.HEADERS.items():
            sheet = book.create_sheet(sheet_kind)
            sheet.append(headers)
            selected = rows if sheet_kind == kind else snapshot["tables"][parser.TABLES[sheet_kind]]
            for row in selected:
                sheet.append([row.get(field, "") for field in headers])
        data = parser._save_memory(book)
        book.close()
    return parser.parse_import(snapshot["tables"], "input." + format, data, kind, bounds)


def test_current_metadata_matches_declared_coverage_not_planning_subset():
    raw = json.loads((ROOT / "data/raw/dem/dem_current.json").read_text(encoding="utf-8"))
    assert geo.read_planning_bounds() == tuple(raw["bbox"])
    assert geo.read_planning_bounds() != tuple(raw["planning_bbox"])


@pytest.mark.parametrize("change", [None, {"crs": "EPSG:3857"}, {"bbox": None}, {"bbox": [True, 0, 1, 1]},
    {"bbox": [1, 0, 0, 1]}, {"bbox": [-181, 0, 1, 1]}, {"bbox": [0, -91, 1, 1]},
    {"source_sha256": "invalid"}, {"source": " "}])
def test_metadata_validation_is_read_only(tmp_path, change):
    path = tmp_path / "metadata.json"
    raw = json.dumps({**metadata(), **(change or {})}).encode("utf-8")
    path.write_bytes(raw)
    assert geo.read_planning_bounds(path) == (BOUNDS if change is None else None)
    assert path.read_bytes() == raw


@pytest.mark.parametrize("raw", [b"{", b"\xff", b'{"bbox":NaN}', b'{"crs":"EPSG:4326","crs":"EPSG:4326"}', b" " * (geo.MAX_METADATA_BYTES + 1)],
    ids=["truncated", "binary", "nonfinite", "duplicate", "oversized"])
def test_unreadable_or_unsafe_metadata_is_unknown(tmp_path, raw):
    path = tmp_path / "metadata.json"
    assert geo.read_planning_bounds(path) is None
    path.write_bytes(raw)
    assert geo.read_planning_bounds(path) is None


@pytest.mark.parametrize("bounds", [None, (), [0, 0, 0, 1], [False, 0, 1, 1], [0, 0, float("inf"), 1], [0, -90, 1, 91]])
def test_invalid_bounds_are_not_accepted(bounds):
    assert not geo.valid_bounds(bounds)


def test_huge_metadata_integer_is_unknown_not_an_overflow(tmp_path):
    huge = 10 ** 400
    assert not geo.valid_bounds([0, 0, huge, 1])
    path = tmp_path / "huge.json"
    path.write_text(json.dumps({**metadata(), "bbox": [0, 0, huge, 1]}), encoding="utf-8")
    assert geo.read_planning_bounds(path) is None


@pytest.mark.parametrize("kind,id_key", [("nodes", "node_id"), ("interference_sources", "interference_id")])
@pytest.mark.parametrize("format", ["csv", "xlsx"])
@pytest.mark.parametrize("coordinate", [(113.2, 36.3), (BOUNDS[0], BOUNDS[1]), (BOUNDS[2], BOUNDS[3])])
def test_new_western_and_edge_coordinates_roundtrip(snapshot, kind, id_key, format, coordinate):
    original = deepcopy(snapshot)
    row = {**snapshot["tables"][parser.TABLES[kind]][0], id_key: "NEW", "lon": str(coordinate[0]), "lat": str(coordinate[1])}
    result = parse(snapshot, kind, [row], format=format)
    assert not result["issues"]
    assert next(item for item in result["rows"] if item["id"] == "NEW")["action"] == "NEW"
    assert snapshot == original


@pytest.mark.parametrize("kind", ["nodes", "interference_sources"])
@pytest.mark.parametrize("coordinate", [(BOUNDS[0] - 1e-9, 37), (BOUNDS[2] + 1e-9, 37),
    (114, BOUNDS[1] - 1e-9), (114, BOUNDS[3] + 1e-9), (37, 114), ("NaN", 37)])
def test_modified_coordinates_outside_dem_reject_entire_batch(snapshot, kind, coordinate):
    original = deepcopy(snapshot)
    row = {**snapshot["tables"][parser.TABLES[kind]][0], "lon": str(coordinate[0]), "lat": str(coordinate[1])}
    result = parse(snapshot, kind, [row])
    assert result["issues"] and result["tables"] == snapshot["tables"] and snapshot == original


@pytest.mark.parametrize("kind", ["nodes", "interference_sources"])
def test_unknown_dem_only_blocks_actual_coordinate_changes(snapshot, kind):
    old = snapshot["tables"][parser.TABLES[kind]][0]
    old["lon"] = "115.5"
    rename = {**old, "node_name" if kind == "nodes" else "name": "renamed"}
    assert not parse(snapshot, kind, [rename], None)["issues"]
    equivalent = {**old, "lon": "115.5000"}
    assert not parse(snapshot, kind, [equivalent], None)["issues"]
    changed = {**old, "lat": "37.2"}
    assert "DEM" in parse(snapshot, kind, [changed], None)["issues"][0]["message"]
    assert parse(snapshot, kind, [changed])["issues"]  # Unchanged longitude must also fit.


def test_parser_does_not_implicitly_load_dem(snapshot, monkeypatch):
    monkeypatch.setattr(geo, "read_planning_bounds", lambda: pytest.fail("pure parser read metadata"))
    row = {**snapshot["tables"]["node.csv"][0], "lon": "113.6"}
    result = parser.parse_import(snapshot["tables"], "input.csv", csv_bytes("nodes", [row]), "nodes")
    assert result["issues"] and "DEM" in result["issues"][0]["message"]
    device = {**snapshot["tables"]["device.csv"][0], "antenna_height_m": "12"}
    assert not parser.parse_import(snapshot["tables"], "device.csv", csv_bytes("devices", [device]), "devices")["issues"]


def test_workspace_reads_once_for_mixed_operations_and_does_not_mutate_snapshot(snapshot, monkeypatch):
    reads = []
    monkeypatch.setattr(geo, "read_planning_bounds", lambda: reads.append(True) or BOUNDS)
    original = deepcopy(snapshot)
    tables, warnings = workspace.apply_changes(snapshot, {"stations": [{"id": "N1", "coordinate": [113.2, 36.3]}],
        "devices": [{"id": "D1", "antennaHeightM": 11}], "interferences": [{"id": "I1", "coordinate": [113.25, 36.35]}]})
    assert len(reads) == 1 and not warnings and snapshot == original
    assert tables["node.csv"][0]["lon"] == "113.2"
    assert tables["interference_source.csv"][0]["lon"] == "113.25"


def test_workspace_missing_dem_parameters_allowed_coordinates_rejected(snapshot, monkeypatch):
    monkeypatch.setattr(geo, "read_planning_bounds", lambda: None)
    tables, _ = workspace.apply_changes(snapshot, {"devices": [{"id": "D1", "antennaHeightM": 12}],
        "stations": [{"id": "N1", "remark": "unchanged coordinate"}]})
    assert tables["node.csv"][0]["lon"] == snapshot["tables"]["node.csv"][0]["lon"]
    with pytest.raises(ResourceDatasetError, match="DEM") as error:
        workspace.apply_changes(snapshot, {"stations": [{"id": "N1", "coordinate": [113.2, 37]}]})
    assert (error.value.code, error.value.status) == (1001, 422)


def request(snapshot, row):
    data = csv_bytes("nodes", [row])
    return SimpleNamespace(context="gis", base_revision=snapshot["revision"], kind="nodes", request_id="geography-import",
        file=SimpleNamespace(name="input.csv", base64=base64.b64encode(data).decode("ascii")))


def test_preview_injects_single_current_bounds_and_commit_revalidates(snapshot, monkeypatch):
    original = deepcopy(snapshot)
    reads = []
    monkeypatch.setattr(workspace, "require_snapshot", lambda revision: deepcopy(snapshot))
    monkeypatch.setattr(geo, "read_planning_bounds", lambda: reads.append(True) or BOUNDS)
    body = request(snapshot, {**snapshot["tables"]["node.csv"][0], "lon": "113.2"})
    preview = imports.preview(body)
    assert preview["valid"] and preview["candidate"]["planningBounds"] == list(BOUNDS) and len(reads) == 1
    body.signature = preview["signature"]
    monkeypatch.setattr(geo, "read_planning_bounds", lambda: None)
    def fake_commit(revision, request_id, digest, actor, apply):
        apply(deepcopy(snapshot))
        pytest.fail("coordinate commit accepted missing current metadata")
    monkeypatch.setattr(imports.datasets, "commit_device_change", fake_commit)
    with pytest.raises(ResourceDatasetError, match="DEM"):
        imports.commit(body, "test-actor")
    assert snapshot == original


def test_bounds_are_only_response_metadata(snapshot, monkeypatch):
    original = deepcopy(snapshot)
    monkeypatch.setattr(geo, "read_planning_bounds", lambda: BOUNDS)
    data = workspace.resources(snapshot)
    assert data["planningBounds"] == list(BOUNDS) and snapshot == original
    data["planningBounds"][0] = 0
    assert workspace.resources(snapshot)["planningBounds"] == list(BOUNDS)
    assert workspace.changes_between(snapshot, snapshot) == {"stations": [], "devices": []}
    assert "planningBounds" not in snapshot
