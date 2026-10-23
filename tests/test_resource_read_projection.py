"""Directed read-service tests with isolated factories, no server or global env."""
import base64
import builtins
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys
from types import ModuleType

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, event, func, select, update
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import frontend_integration as frontend, resource_dataset_service as datasets
from app import resource_read_projection as reads
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetOperation, ResourceDatasetVersion
from app.resource_read_query_schemas import (
    ResourceDeviceReadQuery, ResourceInterferenceQuery, ResourceMapQuery,
    ResourceNodeQuery, ResourceObjectQuery,
)

REV = "resource-0123456789abcdef"


@pytest.fixture
def source(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "read-only.sqlite"))
    for model in (ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation):
        model.__table__.create(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    snapshot = datasets.initialize(factory)
    monkeypatch.setattr(datasets, "get_session_factory", lambda: factory)
    monkeypatch.setattr(frontend, "_rows", lambda *a: pytest.fail("Legacy file reader called"))
    monkeypatch.setattr(frontend, "resource_revision", lambda: pytest.fail("Legacy revision reader called"))
    statements = []

    @event.listens_for(engine, "before_cursor_execute")
    def record(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement.lstrip().split()[0].upper())

    yield factory, snapshot, statements
    engine.dispose()


def args(source, **patch):
    return {"revision": source[1]["revision"], "context": "ledger", **patch}


def publish(source, mutate):
    factory, old, _ = source
    snapshot = {key: deepcopy(old[key]) for key in ("schema_version", "tables", "source_files", "source_updated_at")}
    mutate(snapshot["tables"])
    digest = datasets.content_hash(snapshot)
    revision = "resource-" + digest[:16]
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=revision, snapshot=snapshot, content_hash=digest,
            data_origin=datasets.ORIGIN, source=datasets.SOURCE, created_at=datetime.now(timezone.utc)))
        session.flush()
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = revision
    source[2].clear()
    return revision


def error(call, code, status):
    with pytest.raises(datasets.ResourceDatasetError) as failure:
        call()
    assert (failure.value.code, failure.value.status) == (code, status)


@pytest.mark.parametrize("schema,patch", [
    (ResourceDeviceReadQuery, {"page": "1.0"}),
    (ResourceDeviceReadQuery, {"page": True}),
    (ResourceDeviceReadQuery, {"page_size": "15"}),
    (ResourceDeviceReadQuery, {"page": "-1"}),
    (ResourceDeviceReadQuery, {"min_khz": True, "frequency_mode": "DEVICE"}),
    (ResourceDeviceReadQuery, {"min_khz": "nan", "frequency_mode": "DEVICE"}),
    (ResourceDeviceReadQuery, {"min_khz": "10", "max_khz": "1", "frequency_mode": "MODEL"}),
    (ResourceDeviceReadQuery, {"min_khz": "1"}),
    (ResourceDeviceReadQuery, {"frequency_presence": "PRESENT"}),
    (ResourceDeviceReadQuery, {"search": "bad\nsearch"}),
    (ResourceDeviceReadQuery, {"status_mode": "observed"}),
    (ResourceDeviceReadQuery, {"observation_snapshot_id": "snapshot"}),
    (ResourceDeviceReadQuery, {"status_mode": "observed", "observation_snapshot_id": "snapshot", "context": "planning"}),
    (ResourceDeviceReadQuery, {"status_mode": "unknown"}),
    (ResourceDeviceReadQuery, {"parent_id": ""}),
    (ResourceNodeQuery, {"node_id": "ND-0001"}),
    (ResourceNodeQuery, {"cluster_id": "arbitrary id"}),
    (ResourceNodeQuery, {"sort": "workFreqKhz"}),
    (ResourceNodeQuery, {"relay_capable": "1"}),
    (ResourceNodeQuery, {"parent_id": "bad parent"}),
    (ResourceNodeQuery, {"status_mode": "observed", "observation_snapshot_id": "snapshot"}),
    (ResourceInterferenceQuery, {"status": "NORMAL"}),
    (ResourceInterferenceQuery, {"device_class": "HF"}),
    (ResourceInterferenceQuery, {"frequency_mode": "ALL"}),
    (ResourceInterferenceQuery, {"sort": "status"}),
    (ResourceInterferenceQuery, {"availability": "ACTIVE"}),
    (ResourceInterferenceQuery, {"status_mode": "observed", "observation_snapshot_id": "snapshot"}),
    (ResourceObjectQuery, {"status_mode": "observed"}),
    (ResourceObjectQuery, {"observation_snapshot_id": "snapshot"}),
    (ResourceObjectQuery, {"page": "1"}),
])
def test_invalid_dto(schema, patch):
    with pytest.raises(ValidationError):
        schema.model_validate({"revision": REV, "context": "ledger", **patch})


@pytest.mark.parametrize("patch", [
    {"bbox": "0,0,1"}, {"bbox": "0,0,1,1,2"}, {"bbox": "nan,0,1,1"},
    {"bbox": "0,0,inf,1"}, {"bbox": "-181,0,1,1"}, {"bbox": "0,-91,1,1"},
    {"bbox": "1,0,0,1"}, {"bbox": "0,1,1,1"}, {"bbox": [False, 0, 1, 1]},
    {"zoom": "20.1"}, {"zoom": "-1"}, {"zoom": True}, {"zoom": "nan"},
    {"show_nodes": "yes"}, {"show_interferences": 1}, {"surprise": "1"},
    {"status_mode": "observed", "observation_snapshot_id": "snapshot"},
])
def test_invalid_map_dto(patch):
    with pytest.raises(ValidationError):
        ResourceMapQuery.model_validate({"revision": REV, "context": "gis", "bbox": "0,0,1,1", "zoom": "3", **patch})


def test_raw_query_conversions_and_defaults():
    for schema in (ResourceDeviceReadQuery, ResourceNodeQuery, ResourceInterferenceQuery):
        q = schema(revision=REV, page="2", page_size="5")
        assert q.page == 2 and q.page_size == 5
        assert schema(revision=REV).page_size == 10
        assert schema(revision=REV, page=2, page_size=20).page_size == 20
    device = ResourceDeviceReadQuery(revision=REV, context="ledger", status_mode="observed",
        observation_snapshot_id="snapshot", frequency_mode="MODEL", min_khz="3e3", max_khz="4000")
    assert device.device_filter().frequency.min_khz == 3000
    q = ResourceMapQuery(revision=REV, bbox="-180,-90,180,90", zoom="20", show_nodes="false", show_interferences="true")
    assert q.bbox == (-180, -90, 180, 90) and q.zoom == 20 and q.show_nodes is False


def test_initial_snapshot_pages_details_and_reads_do_not_write(source):
    snapshot = source[1]
    for function, table, field, kind in (
        (reads.query_devices, "device.csv", "device_id", "device"),
        (reads.query_nodes, "node.csv", "node_id", "node"),
        (reads.query_interferences, "interference_source.csv", "interference_id", "interference"),
    ):
        page = function(args(source, page="2", page_size="5"))
        assert "code" not in page and "data" not in page
        assert page["total"] == len(snapshot["tables"][table])
        expected = sorted(snapshot["tables"][table], key=lambda row: row[field])[5:10]
        assert [row[field] for row in page["items"]] == [row[field] for row in expected]
        detail = reads.query_object(kind, page["items"][0][field], args(source))
        assert detail["item"] == page["items"][0]
        assert detail["data_origin"] == datasets.ORIGIN
        assert detail["content_hash"] == snapshot["content_hash"]
        assert function(args(source, page="999999999", page_size="50"))["items"] == []
    device = reads.query_devices(args(source))["items"][0]
    assert device["work_freq_khz"] is None and device["origin"] == "SOURCE"
    detail = reads.query_object("device", device["device_id"], args(source))
    assert detail["node"]["node_id"] == device["node_id"]
    assert detail["model"]["model_id"] == device["model_id"]
    assert detail["antenna"]["antenna_id"] == device["antenna_id"]
    assert set(source[2]) == {"SELECT"}
    with source[0]() as session:
        assert session.scalar(select(func.count()).select_from(ResourceDatasetOperation)) == 0


def test_device_full_filter_before_page_stable_sort_and_global_stats(source):
    def change(t):
        rows = t["device.csv"]
        for row in rows:
            row["status"], row["work_freq_khz"] = "NORMAL", ""
        for row in rows[-13:]:
            row["status"], row["work_freq_khz"] = "FAULT", "3000"
        rows[-1]["availability"] = "OFF_SHELF"
        rows[-2]["status"] = "UNKNOWN"
    revision = publish(source, change)
    q = {**args(source), "revision": revision, "status": "FAULT", "alert": "YES", "availability": "ACTIVE",
         "frequency_mode": "DEVICE", "frequency_presence": "PRESENT", "min_khz": "3000", "max_khz": "3000",
         "sort": "workFreqKhz", "order": "desc", "page": "2", "page_size": "5"}
    page = reads.query_devices(q)
    rows = source[1]["tables"]["device.csv"]
    assert page["total"] == 11 and len(page["items"]) == 5
    assert [r["device_id"] for r in page["items"]] == sorted(r["device_id"] for r in rows[-13:-2])[5:10]
    assert page["stats"]["devices"] == len(rows) and page["stats"]["alerts"] == 12
    assert page["stats"]["unknown_alerts"] == 1
    nulls = reads.query_devices({**args(source), "revision": revision, "frequency_mode": "DEVICE",
                               "frequency_presence": "MISSING", "page_size": "50"})
    assert nulls["total"] == len(rows) - 13 and all(r["work_freq_khz"] is None for r in nulls["items"])


def test_node_own_classification_parents_and_device_association(source):
    def change(t):
        nodes = t["node.csv"]
        target = nodes[-1]
        target.update(node_name="target", region="region", node_role="ROLE", mobility="FIXED",
                      device_class="HF;VUHF", relay_capable="true", status="UNKNOWN",
                      parent_node_id=nodes[0]["node_id"] + ";" + nodes[1]["node_id"])
        for row in t["device.csv"]:
            row.update(work_freq_khz="", availability="ACTIVE")
        t["device.csv"][-1].update(node_id=target["node_id"], work_freq_khz="5000", availability="OFF_SHELF")
    revision = publish(source, change)
    nodes = source[1]["tables"]["node.csv"]
    q = {**args(source), "revision": revision, "search": "region", "region": "region", "node_role": "ROLE",
         "mobility": "FIXED", "device_class": "VUHF", "status": "UNKNOWN", "alert": "UNKNOWN",
         "relay_capable": "true", "parent_id": nodes[1]["node_id"], "availability": "OFF_SHELF",
         "frequency_mode": "DEVICE", "frequency_presence": "PRESENT", "min_khz": "5000", "max_khz": "5000"}
    result = reads.query_nodes(q)
    assert result["total"] == 1 and result["items"][0]["node_id"] == nodes[-1]["node_id"]
    assert result["items"][0]["status"] is None and result["items"][0]["alert"] is None
    frame = reads.query_map({**q, "bbox": "-180,-90,180,90", "zoom": "3"})
    assert frame["total_nodes"] == 1 and frame["points"][0]["status"] is None
    assert_map_contract(frame)
    roots = reads.query_nodes({**args(source), "revision": revision, "parent_id": "", "page_size": "50"})
    assert all(not row["parent_node_id"] for row in roots["items"])
    assert roots["total"] < reads.query_nodes({**args(source), "revision": revision})["total"]
    for key, value in (("region", "absent"), ("status", "NORMAL"), ("device_class", "HF")):
        result = reads.query_nodes({**q, key: value})
        assert result["total"] == (1 if key == "device_class" else 0)


def test_node_and_interference_name_sort_and_search(source):
    for function, table, field, name in (
        (reads.query_nodes, "node.csv", "node_id", "node_name"),
        (reads.query_interferences, "interference_source.csv", "interference_id", "name"),
    ):
        expected = sorted(source[1]["tables"][table], key=lambda r: r[field])
        expected = sorted(expected, key=lambda r: r[name], reverse=True)
        result = function(args(source, sort="name", order="desc", page_size="5"))
        assert [r[field] for r in result["items"]] == [r[field] for r in expected[:5]]
        result = function(args(source, search=expected[-1][field], sort="id", order="desc"))
        assert result["total"] == 1 and result["items"][0][field] == expected[-1][field]


def observation_stub(monkeypatch, projector):
    module = ModuleType("app.resource_observation_projection")
    module.project_device_items = projector
    monkeypatch.setitem(sys.modules, module.__name__, module)


def test_observed_projection_precedes_filters_sort_page_and_detail(source, monkeypatch):
    seen = []
    ids = sorted(r["device_id"] for r in source[1]["tables"]["device.csv"])[-13:]
    def projector(items, revision, snapshot_id):
        assert revision == source[1]["revision"] and snapshot_id == "snapshot-a"
        assert len(items) == len(source[1]["tables"]["device.csv"])
        seen.append(len(items))
        for row in items:
            covered = row["device_id"] in ids
            row.update(status="FAULT" if covered else None, alert=True if covered else None,
                       observed_at="2026-10-23T00:00:00Z" if covered else None)
        return items, {"snapshot_id": snapshot_id, "data_origin": "SYNTHETIC_INTEGRATION", "covered": len(ids)}
    observation_stub(monkeypatch, projector)
    q = args(source, status_mode="observed", observation_snapshot_id="snapshot-a", status="FAULT",
             sort="status", order="desc", page="2", page_size="5")
    page = reads.query_devices(q)
    assert page["total"] == 13 and [r["device_id"] for r in page["items"]] == ids[5:10]
    assert page["observation_snapshot_id"] == "snapshot-a" and page["observation"]["covered"] == 13
    assert page["stats"]["alerts"] == 13
    assert page["stats"]["unknown_alerts"] == len(source[1]["tables"]["device.csv"]) - 13
    detail = reads.query_object("device", ids[5], args(source, status_mode="observed", observation_snapshot_id="snapshot-a"))
    assert detail["item"] == page["items"][0] and detail["observation"] == page["observation"]
    unknown = reads.query_devices({**q, "page": "1", "status": "UNKNOWN"})
    assert unknown["items"][0]["status"] is None and unknown["items"][0]["observed_at"] is None
    assert len(seen) == 3 and set(source[2]) == {"SELECT"}
    original = next(r for r in source[1]["tables"]["device.csv"] if r["device_id"] == ids[5])
    assert reads.query_object("device", ids[5], args(source))["item"]["status"] == frontend._status(original["status"])


def test_missing_or_corrupt_observation_does_not_return_baseline(source, monkeypatch):
    original_import = builtins.__import__
    def missing(name, *a, **kw):
        if name.endswith("resource_observation_projection"):
            raise ModuleNotFoundError(name)
        return original_import(name, *a, **kw)
    monkeypatch.setattr(builtins, "__import__", missing)
    q = args(source, status_mode="observed", observation_snapshot_id="snapshot-a")
    error(lambda: reads.query_devices(q), 5002, 503)
    monkeypatch.setattr(builtins, "__import__", original_import)
    def corrupt(items, revision, snapshot_id):
        raise datasets.ResourceDatasetError("Observation hash mismatch")
    observation_stub(monkeypatch, corrupt)
    error(lambda: reads.query_devices(q), 5002, 503)
    error(lambda: reads.query_object("device", "DV-0001", q), 5002, 503)
    def overwrite(items, revision, snapshot_id):
        items[0]["availability"] = "OFF_SHELF"
        return items, {}
    observation_stub(monkeypatch, overwrite)
    error(lambda: reads.query_devices(q), 5002, 503)


def map_args(source, **patch):
    return args(source, bbox="-180,-90,180,90", zoom="4", **patch)


def assert_map_contract(frame):
    assert len(frame["points"]) + len(frame["clusters"]) <= 2000
    a, b, c, d = frame["bbox"]
    keys = []
    for row in frame["points"] + frame["clusters"]:
        assert math.isfinite(row["lon"]) and math.isfinite(row["lat"])
        assert a <= row["lon"] <= c and b <= row["lat"] <= d
        keys.append((row["kind"], row.get("id", row.get("cluster_id"))))
    assert len(keys) == len(set(keys))
    for kind, total in (("node", "total_nodes"), ("interference", "total_interferences")):
        actual = sum(r["kind"] == kind for r in frame["points"])
        actual += sum(r["count"] for r in frame["clusters"] if r["kind"] == kind)
        assert actual == frame[total]
    for row in frame["clusters"]:
        lo, bottom, hi, top = row["bounds"]
        assert a <= lo < hi <= c and b <= bottom < top <= d
        assert lo <= row["lon"] <= hi and bottom <= row["lat"] <= top
        assert row["count"] >= 2 and len(row["cluster_id"]) <= 512
        assert row["expansion_zoom"] is None or frame["zoom"] < row["expansion_zoom"] <= 17


def test_baseline_map_filters_visible_counts_bounds_and_layer_flags(source):
    frame = reads.query_map(map_args(source))
    assert_map_contract(frame)
    assert not frame["clusters"] and frame["total_nodes"] == len(source[1]["tables"]["node.csv"])
    q = map_args(source, device_class="HF", mobility="FIXED", relay_capable="true")
    selected = reads.query_nodes(args(source, device_class="HF", mobility="FIXED", relay_capable="true", page_size="50"))
    filtered = reads.query_map(q)
    assert_map_contract(filtered)
    assert filtered["total_nodes"] == selected["total"]
    assert reads.query_map({**q, "show_nodes": "false"})["total_nodes"] == 0
    assert reads.query_map({**q, "show_interferences": "false"})["total_interferences"] == 0
    point = frame["points"][0]
    bbox = [point["lon"], point["lat"], min(180, point["lon"] + .0001), min(90, point["lat"] + .0001)]
    tiny = reads.query_map({**map_args(source), "bbox": bbox})
    assert point["id"] in [p["id"] for p in tiny["points"]]
    assert_map_contract(tiny)
    assert set(source[2]) == {"SELECT"}


def test_5000_node_display_mixed_kinds_cluster_recompute_and_rejection(source):
    def change(t):
        base = deepcopy(t["node.csv"][0])
        for i in range(5000 - len(t["node.csv"])):
            t["node.csv"].append({**base, "node_id": "BULK-%05d" % i, "node_name": "bulk-%05d" % i,
                "parent_node_id": "", "lon": str(-179 + (i % 100) * 3.58), "lat": str(-89 + (i // 100) * 3.5),
                "origin": "IMPORT"})
        interference = deepcopy(t["interference_source.csv"][0])
        for i in range(2100):
            t["interference_source.csv"].append({**interference, "interference_id": "IB-%05d" % i,
                "name": "bulk-%05d" % i, "lon": str(-179 + (i % 100) * 3.58), "lat": str(-89 + (i // 100) * 3.5)})
        for lon, lat in ((-180, -90), (180, 90)):
            t["node.csv"][-2 if lon < 0 else -1].update(lon=str(lon), lat=str(lat))
    revision = publish(source, change)
    q = {**map_args(source), "revision": revision}
    frame = reads.query_map(q)
    assert_map_contract(frame)
    assert frame["total_nodes"] == 5000 and frame["total_interferences"] > 2100
    assert frame["clusters"] and reads.query_map(q) == frame
    cluster = next(row for row in frame["clusters"] if row["kind"] == "node")
    members = reads.query_nodes({**args(source), "revision": revision, "cluster_id": cluster["cluster_id"], "page_size": "50"})
    assert members["total"] == cluster["count"] and members["total"] < 5000
    lo, bottom, hi, top = cluster["bounds"]
    assert all(lo <= r["lon"] <= hi and bottom <= r["lat"] <= top for r in members["items"])
    error(lambda: reads.query_nodes({**args(source), "revision": revision, "cluster_id": cluster["cluster_id"], "search": "bulk"}), 1205, 409)
    error(lambda: reads.query_nodes({**args(source), "revision": revision, "cluster_id": "arbitrary"}), 1001, 422)
    token = json.loads(base64.urlsafe_b64decode(cluster["cluster_id"] + "=" * (-len(cluster["cluster_id"]) % 4)))
    token[1] = REV
    stale = base64.urlsafe_b64encode(json.dumps(token, separators=(",", ":")).encode()).decode().rstrip("=")
    error(lambda: reads.query_nodes({**args(source), "revision": revision, "cluster_id": stale}), 1205, 409)
    token[1] = {}
    invalid = base64.urlsafe_b64encode(json.dumps(token, separators=(",", ":")).encode()).decode().rstrip("=")
    error(lambda: reads.query_nodes({**args(source), "revision": revision, "cluster_id": invalid}), 1001, 422)
    assert set(source[2]) == {"SELECT"}
    newer = publish(source, lambda tables: tables["node.csv"][0].update(node_name="new revision"))
    error(lambda: reads.query_nodes({**args(source), "revision": newer, "cluster_id": cluster["cluster_id"]}), 1205, 409)


@pytest.mark.parametrize("zoom", ["16.9", "17", "20"])
def test_colocated_clusters_have_ordered_bounds_and_expansion_cap(source, zoom):
    def change(t):
        base = deepcopy(t["interference_source.csv"][0])
        for i in range(2001):
            t["interference_source.csv"].append({**base, "interference_id": "SAME-%05d" % i,
                                               "lon": "180", "lat": "90"})
    revision = publish(source, change)
    frame = reads.query_map({**map_args(source), "revision": revision, "zoom": zoom, "show_nodes": "false"})
    assert_map_contract(frame)
    cluster = next(r for r in frame["clusters"] if r["count"] >= 2001)
    assert cluster["expansion_zoom"] == (17 if float(zoom) < 17 else None)


def test_errors_unknown_missing_stale_and_hash_damage(source):
    for function in (reads.query_devices, reads.query_nodes, reads.query_interferences):
        error(lambda: function(args(source, unknown="value")), 1001, 422)
        error(lambda: function({**args(source), "revision": REV}), 1205, 409)
    error(lambda: reads.query_map({**map_args(source), "revision": REV}), 1205, 409)
    error(lambda: reads.query_map(map_args(source, unknown="value")), 1001, 422)
    for kind in ("device", "node", "interference"):
        error(lambda: reads.query_object(kind, "absent", args(source)), 1002, 404)
    error(lambda: reads.query_object("other", "absent", args(source)), 1001, 422)
    error(lambda: reads.query_object("node", "ND-0001", args(source, status_mode="observed", observation_snapshot_id="snapshot-a")), 1001, 422)
    with source[0].begin() as session:
        session.execute(update(ResourceDatasetVersion).values(content_hash="0" * 64))
    error(lambda: reads.query_map(map_args(source)), 5002, 503)
    error(lambda: reads.query_devices(args(source)), 5002, 503)


@pytest.mark.parametrize("field,value", [("lon", "nan"), ("lon", "181"), ("relay_capable", "yes"), ("status", "BROKEN")])
def test_semantically_damaged_source_is_not_coerced_to_success(source, field, value):
    revision = publish(source, lambda tables: tables["node.csv"][0].update({field: value}))
    error(lambda: reads.query_nodes({**args(source), "revision": revision}), 5002, 503)
