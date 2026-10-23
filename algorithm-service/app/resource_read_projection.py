"""Read-only, revision-bound resource projections for the existing GET routes.

Handlers validate duplicate keys before constructing these DTOs and wrap returned
data in the application's envelope. No files, observations or receipts are written.
"""
from __future__ import annotations

import base64
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
import re

from pydantic import ValidationError

from . import frontend_integration as frontend, resource_dataset_service as datasets
from .resource_dataset_service import ResourceDatasetError
from .resource_export_schemas import ResourceDeviceFilter
from .resource_read_filter import filter_device_items, sort_device_items
from .resource_read_query_schemas import (
    ResourceDeviceReadQuery, ResourceInterferenceQuery, ResourceMapQuery,
    ResourceNodeQuery, ResourceObjectQuery, _NodeFilters,
)
from .task_input_schemas import Identifier, InputModel

MAP_LIMIT = 2000
GRID_SIZE = 31  # At most 31 * 31 cells per kind, hence 1922 display objects.


def _invalid(message):
    return ResourceDatasetError(message, 1001, 422)


def _coerce(schema, query):
    try:
        return schema.model_validate(query)
    except ValidationError as exc:
        raise _invalid(str(exc)) from exc


def _snapshot(query):
    # Always use the database reader, even if legacy file-mode GETs are enabled.
    snapshot = datasets.current()
    if snapshot["revision"] != query.revision:
        raise ResourceDatasetError("Resource revision has changed", 1205, 409)
    return snapshot


def _check_source(tables):
    """Legacy wire helpers coerce booleans; reject malformed values beforehand."""
    numeric = {
        "node.csv": ("lon", "lat", "elevation_m"),
        "device.csv": ("antenna_height_m", "tx_power_dbm", "work_freq_khz", "tilt_deg", "azimuth_deg"),
        "device_model.csv": ("freq_min_khz", "freq_max_khz", "tx_power_max_dbm"),
        "interference_source.csv": ("lon", "lat", "elevation_m", "antenna_height_m", "center_freq_khz",
                                    "bandwidth_khz", "tx_power_dbm", "antenna_gain_dbi", "azimuth_deg", "duty_cycle"),
    }
    for name, fields in numeric.items():
        for row in tables[name]:
            for field in fields:
                if row.get(field) not in (None, "") and not math.isfinite(float(row[field])):
                    raise ValueError("Nonfinite source number: " + field)
            if "lon" in fields:
                lon, lat = float(row["lon"]), float(row["lat"])
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise ValueError("Invalid source coordinate")
            if row.get("origin") not in (None, "", "SOURCE", "MANUAL", "IMPORT"):
                raise ValueError("Invalid source origin")
    for name, fields in (("node.csv", ("relay_capable", "is_key")),
                         ("interference_source.csv", ("active",))):
        for row in tables[name]:
            if any(row.get(field) not in ("true", "false") for field in fields):
                raise ValueError("Invalid source boolean")
    for name in ("node.csv", "device.csv"):
        for row in tables[name]:
            if row.get("status") not in (None, "", "UNKNOWN", "NORMAL", "FAULT", "OFFLINE"):
                raise ValueError("Invalid source status")
    for row in tables["node.csv"]:
        classes = row.get("device_class", "").split(";")
        if any(value not in ("HF", "VUHF") for value in classes) or len(set(classes)) != len(classes):
            raise ValueError("Invalid node classes")
    for row in tables["device_model.csv"]:
        if row.get("device_class") not in ("HF", "VUHF"):
            raise ValueError("Invalid model class")
        lo, hi = row.get("freq_min_khz"), row.get("freq_max_khz")
        if lo and hi and not 0 <= float(lo) <= float(hi):
            raise ValueError("Invalid model frequency range")


class _View:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.tables = snapshot["tables"]
        self._items = {}
        try:
            _check_source(self.tables)
        except (KeyError, ValueError, TypeError, OverflowError) as exc:
            raise ResourceDatasetError("Resource source is damaged") from exc

    def items(self, kind):
        if kind not in self._items:
            self._items[kind] = self._build_items(kind)
        return self._items[kind]

    def _build_items(self, kind):
        t = self.tables
        try:
            if kind == "device":
                nodes = {row["node_id"]: row for row in t["node.csv"]}
                models = {row["model_id"]: row for row in t["device_model.csv"]}
                antennas = {row["antenna_id"]: row for row in t["antenna_model.csv"]}
                return [frontend._device_item(row, [nodes[row["node_id"]]], [models[row["model_id"]]],
                                               [antennas[row["antenna_id"]]])
                        for row in t["device.csv"]]
            if kind == "node":
                children, devices = {}, {}
                for row in t["node.csv"]:
                    for parent in set(row.get("parent_node_id", "").split(";")) - {""}:
                        children.setdefault(parent, []).append(row)
                for row in t["device.csv"]:
                    devices.setdefault(row["node_id"], []).append(row)
                return [frontend._node_item(row, children.get(row["node_id"], []), devices.get(row["node_id"], []))
                        for row in t["node.csv"]]
            return [frontend._interference_item(row) for row in t["interference_source.csv"]]
        except (KeyError, ValueError, TypeError, StopIteration, OverflowError) as exc:
            raise ResourceDatasetError("Resource source or association is damaged") from exc

    def data(self):
        s = self.snapshot
        return {"revision": s["revision"], "data_origin": s["data_origin"], "source": s["source"],
                "content_hash": s["content_hash"], "updated_at": s["source_updated_at"]}


def _device_projection(view, query):
    items = view.items("device")
    metadata = None
    if query.status_mode == "observed":
        try:
            from .resource_observation_projection import project_device_items
        except ImportError as exc:
            raise ResourceDatasetError("Observation projection is unavailable") from exc
        original = deepcopy(items)
        try:
            items, metadata = project_device_items(items, query.revision, query.observation_snapshot_id)
        except Exception as exc:
            if isinstance(exc, ResourceDatasetError):
                raise
            raise ResourceDatasetError(str(exc), getattr(exc, "code", 5002), getattr(exc, "status", 503)) from exc
        if not isinstance(metadata, dict) or not isinstance(items, list) or len(items) != len(original):
            raise ResourceDatasetError("Observation projection is damaged")
        for base, row in zip(original, items):
            if not isinstance(row, dict) or any(row.get(key) != value for key, value in base.items()
                                              if key not in ("status", "alert", "observed_at")):
                raise ResourceDatasetError("Observation changed frozen resource fields")
            if row.get("status") not in (None, "NORMAL", "FAULT", "OFFLINE") or (
                row.get("alert") is not None and type(row["alert"]) is not bool
            ):
                raise ResourceDatasetError("Observation status projection is damaged")
    return items, {"status_mode": query.status_mode, "observation_snapshot_id": query.observation_snapshot_id,
                   "observation": metadata}


def _stats(view, devices):
    classes = Counter(row["device_class"] for row in devices)
    return {"nodes": len(view.tables["node.csv"]), "devices": len(devices),
            "models": len(view.tables["device_model.csv"]),
            "interferences": len(view.tables["interference_source.csv"]),
            "hf": classes["HF"], "vuhf": classes["VUHF"],
            "alerts": sum(row["alert"] is True for row in devices),
            "unknown_alerts": sum(row["alert"] is None for row in devices),
            "active": sum(row.get("availability") == "ACTIVE" for row in devices),
            "off_shelf": sum(row.get("availability") == "OFF_SHELF" for row in devices),
            "unknown_availability": sum(row.get("availability") is None for row in devices)}


def _page(view, items, query):
    start = (query.page - 1) * query.page_size
    return {**view.data(), "items": items[start:start + query.page_size], "total": len(items),
            "page": query.page, "page_size": query.page_size}


def _sort(items, id_field, name_field, query):
    field = {"id": id_field, "name": name_field, "status": "status"}[query.sort]
    rows = sorted(items, key=lambda row: row[id_field])
    present = [row for row in rows if row.get(field) not in (None, "")]
    missing = [row for row in rows if row.get(field) in (None, "")]
    return sorted(present, key=lambda row: row[field], reverse=query.order == "desc") + missing


def query_devices(query: ResourceDeviceReadQuery) -> dict:
    query = _coerce(ResourceDeviceReadQuery, query)
    view = _View(_snapshot(query))
    all_items, observation = _device_projection(view, query)
    items = filter_device_items(all_items, query.device_filter())
    for field, expected in (("device_id", query.id), ("node_id", query.node_id), ("region", query.region)):
        if expected is not None:
            items = [row for row in items if row.get(field) == expected]
    return {**_page(view, sort_device_items(items, query.sort, query.order), query),
            **observation, "stats": _stats(view, all_items)}


def _nodes(view, query):
    items = view.items("node")
    term = query.search.strip().casefold()
    if term:
        items = [row for row in items if term in " ".join(str(row.get(key) or "")
                 for key in ("node_id", "node_name", "region")).casefold()]
    for field, expected in (("node_id", query.id), ("region", query.region), ("mobility", query.mobility),
                            ("node_role", query.node_role), ("relay_capable", query.relay_capable)):
        if expected is not None:
            items = [row for row in items if row.get(field) == expected]
    if query.device_class is not None:
        items = [row for row in items if query.device_class in row["device_class"].split(";")]
    if query.status is not None:
        items = [row for row in items if (row["status"] or "UNKNOWN") == query.status]
    if query.alert is not None:
        expected = {"YES": True, "NO": False, "UNKNOWN": None}[query.alert]
        items = [row for row in items if row["alert"] is expected]
    if query.parent_id is not None:
        items = [row for row in items if (not row.get("parent_node_id") if query.parent_id == ""
                 else query.parent_id in row.get("parent_node_id", "").split(";"))]
    if query.availability is not None or query.frequency_mode != "ALL":
        # Association is computed from the complete frozen device set, before paging.
        devices = filter_device_items(view.items("device"), ResourceDeviceFilter(
            availability=query.availability, frequency=query.frequency_filter()))
        ids = {row["node_id"] for row in devices}
        items = [row for row in items if row["node_id"] in ids]
    return items


def query_nodes(query: ResourceNodeQuery) -> dict:
    query = _coerce(ResourceNodeQuery, query)
    view = _View(_snapshot(query))
    items = _nodes(view, query)
    if query.cluster_id is not None:
        ids = _cluster_members(view, query)
        items = [row for row in items if row["node_id"] in ids]
    return _page(view, _sort(items, "node_id", "node_name", query), query)


def _interferences(view, search="", object_id=None):
    items = view.items("interference")
    term = search.strip().casefold()
    return [row for row in items if (object_id is None or row["interference_id"] == object_id)
            and (not term or term in (row["interference_id"] + " " + row["interference_name"]).casefold())]


def query_interferences(query: ResourceInterferenceQuery) -> dict:
    query = _coerce(ResourceInterferenceQuery, query)
    view = _View(_snapshot(query))
    return _page(view, _sort(_interferences(view, query.search, query.id),
                            "interference_id", "interference_name", query), query)


def _inside(row, bbox):
    return bbox[0] <= row["lon"] <= bbox[2] and bbox[1] <= row["lat"] <= bbox[3]


def _point(row, kind):
    if kind == "node":
        return {"kind": kind, "id": row["node_id"], "name": row["node_name"],
                "lon": row["lon"], "lat": row["lat"], "status": row["status"],
                "alert": row["alert"], "origin": row["origin"]}
    return {"kind": kind, "id": row["interference_id"], "name": row["interference_name"],
            "lon": row["lon"], "lat": row["lat"], "active": row["active"], "origin": row["origin"]}


def _filter_hash(query):
    values = {key: getattr(query, key) for key in _NodeFilters.model_fields}
    values["context"] = query.context
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def _token(view, query, kind, x, y):
    value = [1, query.revision, list(query.bbox), query.zoom, GRID_SIZE, kind, x, y,
             _filter_hash(query), view.snapshot["content_hash"], query.show_nodes, query.show_interferences]
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
    token = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    if len(token) > 512:
        raise ResourceDatasetError("Cluster identifier exceeds the wire limit")
    return token


def _cell(row, bbox):
    x = min(GRID_SIZE - 1, int((row["lon"] - bbox[0]) / (bbox[2] - bbox[0]) * GRID_SIZE))
    y = min(GRID_SIZE - 1, int((row["lat"] - bbox[1]) / (bbox[3] - bbox[1]) * GRID_SIZE))
    return x, y


def _map(view, query):
    layers = {
        "node": [row for row in _nodes(view, query) if _inside(row, query.bbox)] if query.show_nodes else [],
        "interference": [row for row in _interferences(view, query.search) if _inside(row, query.bbox)]
        if query.show_interferences else [],
    }
    points, clusters = [], []
    aggregate = sum(map(len, layers.values())) > MAP_LIMIT
    for kind, rows in layers.items():
        id_field = "node_id" if kind == "node" else "interference_id"
        rows = sorted(rows, key=lambda row: row[id_field])
        if not aggregate:
            points.extend(_point(row, kind) for row in rows)
            continue
        groups = {}
        for row in rows:
            groups.setdefault(_cell(row, query.bbox), []).append(row)
        for (x, y), members in sorted(groups.items()):
            if len(members) == 1:
                points.append(_point(members[0], kind))
                continue
            a, b, c, d = query.bbox
            bounds = [a + (c - a) * x / GRID_SIZE, b + (d - b) * y / GRID_SIZE,
                      a + (c - a) * (x + 1) / GRID_SIZE, b + (d - b) * (y + 1) / GRID_SIZE]
            # Float resolution may collapse tiny cells. The original viewport is valid.
            if bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
                bounds = list(query.bbox)
            lon = math.fsum(row["lon"] for row in members) / len(members)
            lat = math.fsum(row["lat"] for row in members) / len(members)
            bounds = [max(a, min(bounds[0], min(row["lon"] for row in members))),
                      max(b, min(bounds[1], min(row["lat"] for row in members))),
                      min(c, max(bounds[2], max(row["lon"] for row in members))),
                      min(d, max(bounds[3], max(row["lat"] for row in members)))]
            clusters.append({"kind": kind, "cluster_id": _token(view, query, kind, x, y),
                             "lon": max(bounds[0], min(bounds[2], lon)),
                             "lat": max(bounds[1], min(bounds[3], lat)),
                             "bounds": bounds, "count": len(members),
                             "expansion_zoom": min(17, math.floor(query.zoom) + 1) if query.zoom < 17 else None})
    return {**view.data(), "bbox": list(query.bbox), "zoom": query.zoom, "points": points,
            "clusters": clusters, "total_nodes": len(layers["node"]),
            "total_interferences": len(layers["interference"])}


def query_map(query: ResourceMapQuery) -> dict:
    query = _coerce(ResourceMapQuery, query)
    return _map(_View(_snapshot(query)), query)


def _cluster_members(view, query):
    try:
        raw = base64.b64decode(query.cluster_id + "=" * (-len(query.cluster_id) % 4), altchars=b"-_", validate=True)
        value = json.loads(raw)
        if not isinstance(value, list) or len(value) != 12:
            raise ValueError("Invalid cluster structure")
        version, revision, bbox, zoom, grid, kind, x, y, filters, digest, show_nodes, show_interferences = value
        if (type(version) is not int or version != 1 or type(grid) is not int or grid != GRID_SIZE
            or kind != "node" or type(x) is not int or type(y) is not int
            or not 0 <= x < GRID_SIZE or not 0 <= y < GRID_SIZE or show_nodes is not True
            or type(show_interferences) is not bool or not isinstance(revision, str)
            or not re.fullmatch(r"resource-[0-9a-f]{16}", revision)
            or any(not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{64}", v) for v in (filters, digest))):
            raise ValueError("Invalid cluster cell")
        values = {key: getattr(query, key) for key in _NodeFilters.model_fields}
        original = ResourceMapQuery(**values, context=query.context, revision=query.revision,
                                    bbox=bbox, zoom=zoom, show_nodes=show_nodes, show_interferences=show_interferences)
        if revision != query.revision or filters != _filter_hash(query) or digest != view.snapshot["content_hash"]:
            raise ResourceDatasetError("Cluster resource revision or filters have changed", 1205, 409)
        if _token(view, original, kind, x, y) != query.cluster_id:
            raise ValueError("Noncanonical cluster identifier")
    except ResourceDatasetError:
        raise
    except (ValueError, TypeError, KeyError, OverflowError, UnicodeError) as exc:
        raise _invalid("Invalid cluster identifier") from exc
    members = [row for row in _nodes(view, query) if _inside(row, original.bbox)
               and _cell(row, original.bbox) == (x, y)]
    if len(members) < 2:
        raise _invalid("Cluster does not identify an aggregate")
    # A syntactically valid token must name an aggregate actually emitted by the map.
    frame = _map(view, original)
    if not any(row["cluster_id"] == query.cluster_id for row in frame["clusters"]):
        raise _invalid("Cluster was not emitted for this viewport")
    return {row["node_id"] for row in members}


class _ObjectPath(InputModel):
    kind: str
    id: Identifier


def query_object(kind: str, id: str, query: ResourceObjectQuery) -> dict:
    query = _coerce(ResourceObjectQuery, query)
    _coerce(_ObjectPath, {"kind": kind, "id": id})
    if kind not in ("node", "device", "interference"):
        raise _invalid("Unsupported resource kind")
    if kind != "device" and query.status_mode == "observed":
        raise _invalid("Observed node/interference status aggregation is unsupported")
    view = _View(_snapshot(query))
    metadata = {}
    if kind == "device":
        items, metadata = _device_projection(view, query)
    else:
        items = view.items(kind)
    field = {"node": "node_id", "device": "device_id", "interference": "interference_id"}[kind]
    item = next((row for row in items if row[field] == id), None)
    if item is None:
        raise ResourceDatasetError("Resource object not found", 1002, 404)
    result = {**view.data(), "item": item, **metadata}
    if kind == "device":
        result["node"] = next(row for row in view.items("node") if row["node_id"] == item["node_id"])
        result["model"] = deepcopy(next(row for row in view.tables["device_model.csv"] if row["model_id"] == item["model_id"]))
        for key in ("freq_min_khz", "freq_max_khz", "tx_power_max_dbm"):
            result["model"][key] = frontend._optional_number(result["model"].get(key))
        result["antenna"] = deepcopy(next(row for row in view.tables["antenna_model.csv"] if row["antenna_id"] == item["antenna_id"]))
    return result
