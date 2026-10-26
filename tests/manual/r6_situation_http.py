"""Opt-in R6 real HTTP refresh acceptance. Never launches or provisions a server.

prepare is offline; smoke/import/snapshot require --execute. Only the explicitly
authorized .24 workspace is accepted. Credentials are loaded from its private
file in memory and are never copied into evidence. Run with Python -B.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from http.cookiejar import CookieJar
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import time
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4
from xml.etree import ElementTree
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[2]
SERVER_NAME = "r4-f79ea5c1b6c54e38ae495d840c142013"
SERVER_ROOT = ROOT / "data/runtime/r2" / SERVER_NAME
EVIDENCE_ROOT = ROOT / "data/runtime/r6"
FRONTEND = "http://127.0.0.24:5324"
API = "http://127.0.0.24:8124"
TARGETS = (FRONTEND, API)
STATUS = "/api/v1/device-status"
RESOURCE = "/api/v1/resource"
ORIGIN = "SYNTHETIC_INTEGRATION"
STATUS_SCHEMA = "device-status-snapshot-a1"
SOURCE_DOC = ROOT / "docs/input/\u3010\u975e\u5bc6\u3011\u77ed\u6ce2\u89c4\u5212\u8981\u6c42.docx"
SOURCE_SHA256 = "218c3d984d7a1f84c4bf9998ce35618c51e9de06802ca790003a32082a78e613"
SOURCE_QUOTE = "6.\u6001\u52bf\u5237\u65b0\u65f6\u95f4\uff1a\u22641\u5206\u949f\u3002"
THRESHOLD_SECONDS = 60
ID_PATTERN = re.compile(r"[A-Za-z0-9_.:-]{1,120}\Z")
STATE_FIELDS = ("status", "alert", "observed_at")
NOTE = "Explicit R6 synthetic acceptance input; no measured telemetry is claimed."
GET_EXACT = {
    "/api/v1/auth/capabilities", "/api/v1/auth/csrf", "/api/v1/auth/session",
    RESOURCE + "/context", RESOURCE + "/map", RESOURCE + "/nodes",
    RESOURCE + "/devices", STATUS + "/snapshots",
}
GET_OBJECT = re.compile(
    r"/api/v1/(?:resource/devices/[A-Za-z0-9_.:-]{1,120}"
    r"|device-status/imports/[A-Za-z0-9_.:-]{1,120}"
    r"|device-status/snapshots/[A-Za-z0-9_.:-]{1,120}(?:/devices)?)\Z"
)


class Failure(RuntimeError):
    """Messages contain tool labels only, never server responses or credentials."""


def require(condition, label):
    if not condition:
        raise Failure(label)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".new")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    temporary.replace(path)


def identifier(value):
    require(isinstance(value, str) and value not in (".", "..") and ID_PATTERN.fullmatch(value), "invalid identifier")
    return quote(value, safe=":")


def clone_cookies(jar):
    result = CookieJar()
    for cookie in jar:
        result.set_cookie(deepcopy(cookie))
    return result


def in_evidence(path):
    resolved = Path(path).resolve(strict=True)
    relative = resolved.relative_to(EVIDENCE_ROOT.resolve())
    require(len(relative.parts) >= 2, "anchor must be inside an R6 GUID directory")
    UUID(relative.parts[0])
    return resolved


def source_proof():
    raw_hash = hashlib.sha256(SOURCE_DOC.read_bytes()).hexdigest()
    require(raw_hash == SOURCE_SHA256, "source document changed; recheck the metric source")
    with ZipFile(SOURCE_DOC) as archive:
        document = ElementTree.fromstring(archive.read("word/document.xml"))
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = ["".join(p.itertext()) for p in document.findall(".//w:p", ns)]
    matches = [index for index, text in enumerate(paragraphs) if text == SOURCE_QUOTE]
    require(len(matches) == 1, "refresh metric source could not be verified")
    return {"document": str(SOURCE_DOC.relative_to(ROOT)), "sha256": raw_hash,
        "paragraph_index_zero_based": matches[0], "quote": SOURCE_QUOTE,
        "cross_reference": "docs/design/05_\u79fb\u52a8\u7535\u53f0\u90e8\u7f72\u89c4\u5212\u7b97\u6cd5\u65b9\u6848.md:49",
        "threshold_seconds": THRESHOLD_SECONDS,
        "requirement_references_supplied_by_main": ["SR-3.2-053", "SR-3.11-012"],
        "scope": "Existing project situation-refresh metric; HTTP evidence is only one component.",
        "formal_requirements_modified": False}


def environment(args):
    require(ROOT.drive.lower() == "f:", "this tool must remain in the authorized F-drive tree")
    runtime = Path(args.runtime_root).resolve(strict=True)
    require(runtime == SERVER_ROOT.resolve(strict=True), "workspace is not this authorized R6 server")
    workspace = load_json(runtime / "workspace.json")
    require(Path(workspace["runtime_root"]).resolve(strict=True) == runtime, "workspace root mismatch")
    require(workspace["frontend"] == FRONTEND and workspace["api"] == API, "workspace URL mismatch")
    require(args.target in TARGETS, "target outside .24 allowlist")
    require(args.database_url == workspace["database_url"], "explicit database URL mismatch")
    require(args.database_url.startswith("sqlite:///"), "only the authorized SQLite workspace is supported")
    raw_path = args.database_url[len("sqlite:///"):]
    require(not any(token in raw_path for token in ("?", "#", "@")), "database URI options are not allowed")
    require(Path(raw_path).is_absolute(), "database path must be absolute")
    database = Path(raw_path).resolve(strict=True)
    paired = (ROOT / "data/runtime/tmp" / SERVER_NAME).resolve()
    require(database.is_relative_to(runtime) or database.is_relative_to(paired), "database is outside this server's isolated roots")
    require(database.is_file() and database.suffix.lower() in (".sqlite", ".sqlite3", ".db"), "invalid existing database file")
    private_path = Path(workspace["key_file"]).resolve(strict=True)
    require(private_path.is_file() and private_path.is_relative_to(runtime), "private configuration is outside this workspace")
    if args.private_config:
        require(Path(args.private_config).resolve(strict=True) == private_path, "private configuration mismatch")
    return runtime, private_path, {"runtime_root": str(runtime), "database_path": str(database),
        "frontend": FRONTEND, "api": API, "target": args.target,
        "workspace_sha256": hashlib.sha256((runtime / "workspace.json").read_bytes()).hexdigest(),
        "database_access": "PATH_VALIDATION_ONLY_NO_SQL_CONNECTION"}


class Evidence:
    def __init__(self, args, public):
        self.directory = EVIDENCE_ROOT / uuid4().hex
        self.directory.mkdir(parents=True, exist_ok=False)
        self.state = {"schema": "r6-situation-http-v1", "action": args.action,
            "environment": public, "started_at": utc_now(), "completed": False,
            "outcome": "NOT_RUN", "source": source_proof(), "requests": [],
            "samples": [], "checks": [], "browser_rendering": "NOT_RUN_BY_SUBGROUP_B",
            "rounds_per_lane": args.rounds, "max_read_concurrency": args.concurrency,
            "warmup": "No discarded warmup samples; setup/auth/baseline reads are outside measured groups.",
            "percentile_method": "nearest rank: sorted[ceil(p*n)-1]; successful samples only; failures separately counted"}
        self.save()
        print(json.dumps({"phase": "STARTED", "action": args.action,
            "evidence": str(self.directory / "report.json")}), flush=True)

    def save(self):
        write_json(self.directory / "report.json", self.state)

    def check(self, label):
        self.state["checks"].append({"label": label, "outcome": "PASS"})
        self.save()


def r4_module():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("r6_local_r4_probe", ROOT / "tests/manual/r4_internal_http.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # This private module instance owns its globals; the R4 file is never edited.
    module.ORIGIN, module.API = FRONTEND, API
    return module


class Probe:
    def __init__(self, shared, args, runtime, account, records, *, cookies=None, session_id=None, read_only=False):
        import httpx
        self.args, self.records, self.read_only = args, records, read_only
        self.base = shared.Probe(runtime, account, [])
        self.base.client.base_url = args.target
        self.base.client.timeout = httpx.Timeout(args.timeout)
        self.base.client.event_hooks = {"request": [self.guard]}
        if cookies is not None:
            self.base.client.cookies = httpx.Cookies(clone_cookies(cookies))
        self.session_id = session_id
        if session_id is not None:
            self.base.client.headers["X-Session-Id"] = session_id
        self.transport_paths = []

    def guard(self, request):
        parsed = urlsplit(str(request.url))
        require(f"{parsed.scheme}://{parsed.netloc}" == self.args.target, "transport attempted a different origin")
        require(not parsed.fragment and not parsed.username and not parsed.password, "invalid transport URL")
        path, method = parsed.path, request.method
        if method == "GET":
            require(path in GET_EXACT or GET_OBJECT.fullmatch(path), "out-of-scope GET")
        elif method == "POST":
            require(not self.read_only and path in ("/api/v1/auth/login", STATUS + "/imports"), "out-of-scope or concurrent POST")
        else:
            raise Failure("HTTP method outside the R6 allowlist")
        self.transport_paths.append({"method": method, "path": path})

    def call(self, method, path, body=None, *, params=None, expected=(200,), code=0, deadline=None):
        require(self.args.execute, "network requires explicit --execute")
        require(path.startswith("/api/v1/") and not any(c in path for c in ("?", "#", "\\")), "unsafe relative request path")
        if deadline is not None:
            remaining = deadline - time.perf_counter()
            require(remaining > 0, "refresh group exceeded 60 seconds before its next request")
            self.base.client.timeout = min(self.args.timeout, remaining)
        else:
            self.base.client.timeout = self.args.timeout
        record = {"method": method, "path": path, "parameters": params,
            "expected_status": list(expected), "expected_code": code, "outcome": "UNKNOWN",
            "phase": getattr(self, "phase", "setup")}
        if body is not None and path != "/api/v1/auth/login":
            record["request_body_sha256"] = digest(body)
            record["request_id"] = body.get("request_id")
        self.records.append(record)
        self.transport_paths = []
        before, started = len(self.base.records), time.perf_counter()
        try:
            value = self.base.call(method, path, body, expected=expected, code=code, params=params)
            record.update(status=self.base.records[-1]["status"], code=self.base.records[-1]["code"], outcome="PASS")
            if deadline is not None:
                require(time.perf_counter() <= deadline, "refresh group exceeded 60 seconds after response read")
            return value
        except BaseException as exc:
            record.update(outcome="FAIL", error_type=type(exc).__name__)
            if isinstance(exc, Failure):
                record["failure_reason"] = str(exc)
            if len(self.base.records) > before:
                record.update(status=self.base.records[-1]["status"], code=self.base.records[-1]["code"])
            raise Failure("HTTP step failed: " + method + " " + path + "; inspect redacted evidence") from None
        finally:
            record["elapsed_seconds"] = time.perf_counter() - started
            record["transport_requests"] = self.transport_paths
            record["csrf_preflight_included_in_elapsed"] = method == "POST"
            # Parent Probe temporarily retains redacted bodies. Evidence keeps only hashes/IDs.
            self.base.records.clear()

    def login(self, account, *, importing):
        caps = self.call("GET", "/api/v1/auth/capabilities")
        require(caps.get("authMode") == "LOCAL_PASSWORD" and caps.get("initialized") is True, "LOCAL_PASSWORD prerequisite failed")
        session = self.call("POST", "/api/v1/auth/login", {"username": account["username"], "password": account["password"]})
        require(session.get("integration_mode") is False and session.get("data_origin") == "FORMAL_VERIFIED", "LOCAL identity was not verified")
        required = {"resources.view", "situation.view"}
        if importing:
            required.add("resources.device.status.import")
        require(required <= set(session.get("permissions", [])), "account lacks R6 permissions")
        self.session_id = session["session_id"]
        self.base.client.headers["X-Session-Id"] = self.session_id
        current = self.call("GET", "/api/v1/auth/session")
        require(current["account_id"] == session["account_id"], "authenticated account mismatch")
        caps = self.call("GET", "/api/v1/auth/capabilities")
        require(caps.get("passwordChangeRequired") is False, "main must complete password provisioning first")
        return session["account_id"]

    def close(self):
        self.base.close()


def resource_identity(value, revision, content_hash):
    require(value.get("revision") == revision and value.get("content_hash") == content_hash, "resource version/hash mismatch")


def read_all(client, path, params, key, *, revision=None, content_hash=None, deadline=None, validate=None):
    items, total = [], None
    for page in range(1, 102):
        value = client.call("GET", path, params={**params, "page": page, "page_size": 50}, deadline=deadline)
        if revision is not None:
            resource_identity(value, revision, content_hash)
        if validate:
            validate(value)
        require(value.get("page") == page and value.get("page_size") == 50, "pagination echo mismatch")
        require(type(value.get("total")) is int and 0 <= value["total"] <= 5000, "invalid bounded collection total")
        if total is None:
            total = value["total"]
        require(value["total"] == total and isinstance(value.get("items"), list), "collection changed during pagination")
        require(len(value["items"]) == min(50, max(0, total - (page - 1) * 50)), "page was truncated or padded")
        items.extend(value["items"])
        if len(items) >= total:
            break
    require(total is not None and len(items) == total, "incomplete collection")
    ids = [item[key] for item in items]
    require(len(set(ids)) == len(ids), "duplicate collection members")
    return items


def baseline(client, args):
    context = client.call("GET", RESOURCE + "/context", params={"context": "ledger"})
    revision = context["revision"]
    if args.expected_revision:
        require(revision == args.expected_revision, "resource changed from the explicitly supplied version")
    query = {"context": "ledger", "revision": revision, "sort": "id", "order": "asc"}
    first = client.call("GET", RESOURCE + "/devices", params={**query, "page": 1, "page_size": 5})
    content_hash = first["content_hash"]
    require(first.get("data_origin") == ORIGIN and re.fullmatch(r"[0-9a-f]{64}", content_hash), "resource is not a hash-bound synthetic fixture")
    if args.expected_content_hash:
        require(content_hash == args.expected_content_hash, "resource content differs from the explicitly supplied hash")
    devices = read_all(client, RESOURCE + "/devices", query, "device_id", revision=revision, content_hash=content_hash)
    require(len(devices) == args.device_count == 414, "R6 fixture must contain exactly 414 existing devices")
    require([row["device_id"] for row in devices] == sorted(row["device_id"] for row in devices), "unstable baseline device order")
    nodes = read_all(client, RESOURCE + "/nodes", query, "node_id", revision=revision, content_hash=content_hash)
    node_ids = {row["node_id"] for row in nodes}
    require(all(row["node_id"] in node_ids and row["device_class"] in ("HF", "VUHF") for row in devices), "device/node/class association mismatch")
    counts = {kind: len({row["node_id"] for row in devices if row["device_class"] == kind}) for kind in ("HF", "VUHF")}
    require(counts["HF"] >= 50 and counts["VUHF"] >= 100, "fixture lacks 50 HF or 100 VUHF distinct corresponding nodes")
    require(context["stats"]["devices"] == len(devices) and context["stats"]["nodes"] == len(nodes), "context/list counts disagree")
    map_query = {"context": "gis", "revision": revision, "bbox": ",".join(str(v) for v in context["bounds"]),
        "zoom": 8, "show_nodes": "true", "show_interferences": "false"}
    map_value = client.call("GET", RESOURCE + "/map", params=map_query)
    resource_identity(map_value, revision, content_hash)
    validate_map(map_value, nodes)
    return {"context": context, "revision": revision, "content_hash": content_hash,
        "devices": devices, "nodes": nodes, "class_node_counts": counts,
        "shared_class_nodes": len({row["node_id"] for row in devices if row["device_class"] == "HF"}
            & {row["node_id"] for row in devices if row["device_class"] == "VUHF"}),
        "map_query": map_query, "map": map_value}


def validate_map(value, nodes):
    require(value.get("clusters") == [], "this fixture requires an unaggregated baseline map; no members are invented")
    points = {point["id"]: point for point in value["points"]}
    require(value["total_nodes"] == len(nodes) and len(points) == len(nodes), "map/list node counts disagree")
    for node in nodes:
        point = points.get(node["node_id"])
        require(point is not None and point["kind"] == "node", "node missing from baseline map")
        require(all(point[field] == node[field] for field in ("lon", "lat", "status", "alert")), "baseline map/node fields disagree")


def state_payload(base, namespace, index):
    timestamp, records = utc_now(), []
    states = (("NORMAL", False), ("FAULT", True), ("OFFLINE", True), (None, None))
    for offset, device in enumerate(base["devices"]):
        status, alert = states[(offset + index) % len(states)]
        records.append({"device_id": device["device_id"], "node_id": device["node_id"],
            "model_id": device["model_id"], "observed_at": timestamp if status is not None else None,
            "status": status, "alert": alert, "unknown_reasons": [NOTE] if status is None else []})
    return {"schema_version": STATUS_SCHEMA, "context": "ledger",
        "request_id": namespace + "-state-" + str(index), "base_revision": base["revision"],
        "data_origin": ORIGIN, "source_label": namespace + "-round-" + str(index),
        "provenance_note": NOTE, "records": records}


def observed_params(anchor, context="ledger"):
    return {"context": context, "revision": anchor["resource_revision"], "status_mode": "observed",
        "observation_snapshot_id": anchor["snapshot_id"]}


def validate_observation(value, anchor):
    resource_identity(value, anchor["resource_revision"], anchor["resource_content_hash"])
    require(value.get("status_mode") == "observed" and value.get("observation_snapshot_id") == anchor["snapshot_id"], "observed mode echo mismatch")
    observation = value.get("observation")
    require(isinstance(observation, dict) and all(observation.get(key) == anchor[key] for key in
        ("snapshot_id", "snapshot_revision", "resource_revision", "data_origin", "source_label")), "observed projection anchor mismatch")


def verify_devices(items, base, payload):
    expected = {record["device_id"]: record for record in payload["records"]}
    frozen = {row["device_id"]: row for row in base["devices"]}
    require(set(row["device_id"] for row in items) == set(expected), "projected device membership mismatch")
    for item in items:
        original, wanted = frozen[item["device_id"]], expected[item["device_id"]]
        require(all(item.get(field) == wanted[field] for field in STATE_FIELDS), "projected state differs from imported state")
        require(all(item.get(key) == value for key, value in original.items() if key not in STATE_FIELDS), "state projection changed a frozen resource field")


def audit_snapshot(client, base, anchor, payload, *, deadline):
    revision, content_hash = base["revision"], base["content_hash"]
    context = client.call("GET", RESOURCE + "/context", params={"context": "ledger"}, deadline=deadline)
    require(context == base["context"], "resource context changed during status-only refresh")
    query = {"context": "ledger", "snapshot_revision": anchor["snapshot_revision"]}
    path = STATUS + "/snapshots/" + identifier(anchor["snapshot_id"])
    header = client.call("GET", path, params=query, deadline=deadline)
    for field in ("snapshot_id", "snapshot_revision", "resource_revision", "resource_content_hash", "content_hash", "data_origin", "source_label"):
        require(header.get(field) == anchor[field], "snapshot header anchor mismatch")
    records = read_all(client, path + "/devices", query, "device_id", deadline=deadline,
        validate=lambda value: require(all(value.get(key) == anchor[key] for key in
            ("snapshot_id", "snapshot_revision", "resource_revision")), "status record page anchor mismatch"))
    require([dict((key, value) for key, value in row.items() if key != "availability") for row in records] == payload["records"], "frozen imported records differ from original payload")
    counts = Counter(record["status"] or "UNKNOWN" for record in records)
    require(header["counts"] == {**dict(counts), "total": len(records)} and header["total"] == len(records) == 414, "snapshot status counts disagree")
    expected_alerts = sum(record["alert"] is True for record in records)
    for context_name in ("ledger", "gis"):
        params = {**observed_params(anchor, context_name), "sort": "id", "order": "asc"}
        items = read_all(client, RESOURCE + "/devices", params, "device_id", revision=revision,
            content_hash=content_hash, deadline=deadline,
            validate=lambda value: (validate_observation(value, anchor), require(
                value["stats"]["alerts"] == expected_alerts and value["stats"]["unknown_alerts"] == counts["UNKNOWN"], "observed statistics disagree")))
        verify_devices(items, base, payload)
    representatives = {}
    for record in payload["records"]:
        representatives.setdefault(record["status"] or "UNKNOWN", record)
    for status, representative in representatives.items():
        filtered = read_all(client, RESOURCE + "/devices", {**observed_params(anchor), "status": status, "sort": "id", "order": "asc"},
            "device_id", revision=revision, content_hash=content_hash, deadline=deadline,
            validate=lambda value: validate_observation(value, anchor))
        wanted_ids = {record["device_id"] for record in records if (record["status"] or "UNKNOWN") == status}
        require({row["device_id"] for row in filtered} == wanted_ids, "full-collection state filter mismatch")
        device_path = RESOURCE + "/devices/" + identifier(representative["device_id"])
        detail = client.call("GET", device_path, params=observed_params(anchor, "gis"), deadline=deadline)
        validate_observation(detail, anchor)
        list_item = next(row for row in items if row["device_id"] == representative["device_id"])
        require(detail["item"] == list_item, "observed detail and list disagree")
        point = next(point for point in base["map"]["points"] if point["id"] == list_item["node_id"])
        require(detail["node"]["node_id"] == point["id"] and detail["model"]["model_id"] == list_item["model_id"]
            and list_item["node_lon"] == point["lon"] and list_item["node_lat"] == point["lat"], "detail/map spatial association mismatch")
    for alert, flag in (("YES", True), ("NO", False), ("UNKNOWN", None)):
        filtered = read_all(client, RESOURCE + "/devices", {**observed_params(anchor), "alert": alert, "sort": "id", "order": "asc"},
            "device_id", revision=revision, content_hash=content_hash, deadline=deadline,
            validate=lambda value: validate_observation(value, anchor))
        require({row["device_id"] for row in filtered} == {record["device_id"] for record in records if record["alert"] is flag}, "full-collection alert filter mismatch")
    current_map = client.call("GET", RESOURCE + "/map", params=base["map_query"], deadline=deadline)
    require(current_map == base["map"], "status-only import changed the baseline map")
    require(time.perf_counter() <= deadline, "exhaustive coherence audit exceeded its operational budget")
    return {"devices": len(items), "class_node_counts": base["class_node_counts"],
        "status_counts": dict(counts), "baseline_map": "UNCHANGED_SPATIAL_ASSOCIATION_VERIFIED",
        "browser_state_overlay": "MAIN_GROUP_MUST_VERIFY"}


def refresh_group(client, base, anchor, payload, *, deadline, index=0):
    context = client.call("GET", RESOURCE + "/context", params={"context": "gis"}, deadline=deadline)
    require(context == base["context"], "resource context changed during refresh")
    header = client.call("GET", STATUS + "/snapshots/" + identifier(anchor["snapshot_id"]),
        params={"context": "ledger", "snapshot_revision": anchor["snapshot_revision"]}, deadline=deadline)
    require(all(header.get(key) == anchor[key] for key in
        ("snapshot_id", "snapshot_revision", "resource_revision", "resource_content_hash", "content_hash")), "refresh header anchor mismatch")
    params = {**observed_params(anchor, "gis"), "sort": "id", "order": "asc"}
    items = read_all(client, RESOURCE + "/devices", params, "device_id", revision=base["revision"],
        content_hash=base["content_hash"], deadline=deadline,
        validate=lambda value: validate_observation(value, anchor))
    verify_devices(items, base, payload)
    status = ("NORMAL", "FAULT", "OFFLINE", "UNKNOWN")[index % 4]
    expected = [row for row in items if (row["status"] or "UNKNOWN") == status]
    filtered = client.call("GET", RESOURCE + "/devices", params={**params, "status": status,
        "page": 1, "page_size": 50}, deadline=deadline)
    validate_observation(filtered, anchor)
    require(filtered["total"] == len(expected) and filtered["items"] == expected[:50], "refresh status filter/page mismatch")
    alert, flag = (("YES", True), ("NO", False), ("UNKNOWN", None))[index % 3]
    expected_alert = [row for row in items if row["alert"] is flag]
    alerted = client.call("GET", RESOURCE + "/devices", params={**params, "alert": alert,
        "page": 1, "page_size": 50}, deadline=deadline)
    validate_observation(alerted, anchor)
    require(alerted["total"] == len(expected_alert) and alerted["items"] == expected_alert[:50], "refresh alert filter/page mismatch")
    detail = client.call("GET", RESOURCE + "/devices/" + identifier(expected[0]["device_id"]),
        params=observed_params(anchor, "gis"), deadline=deadline)
    validate_observation(detail, anchor)
    require(detail["item"] == expected[0], "refresh detail differs from the full projected list")
    map_value = client.call("GET", RESOURCE + "/map", params=base["map_query"], deadline=deadline)
    require(map_value == base["map"], "refresh changed the baseline map")
    point = next(row for row in map_value["points"] if row["id"] == expected[0]["node_id"])
    require(point["lon"] == expected[0]["node_lon"] and point["lat"] == expected[0]["node_lat"]
        and detail["node"]["node_id"] == point["id"], "refresh detail/map spatial association mismatch")
    return {"devices": len(items), "status_filter": status, "alert_filter": alert,
        "class_node_counts": base["class_node_counts"], "full_gis_pages": math.ceil(len(items) / 50),
        "baseline_map": "UNCHANGED_SPATIAL_ASSOCIATION_VERIFIED", "browser_state_overlay": "MAIN_GROUP_MUST_VERIFY"}


def make_anchor(base, payload, receipt, public, directory, index, t0_wall_ns):
    content_hash = digest({key: value for key, value in payload.items() if key != "request_id"})
    require(receipt.get("schema_version") == STATUS_SCHEMA and receipt.get("request_id") == payload["request_id"], "import receipt identity mismatch")
    require(receipt.get("resource_revision") == base["revision"] and receipt.get("data_origin") == ORIGIN
        and receipt.get("total") == 414 and receipt.get("content_hash") == content_hash
        and receipt.get("snapshot_revision") == "device-status-" + content_hash, "import receipt hash/version mismatch")
    identifier(receipt["snapshot_id"])
    return {"schema": "r6-situation-anchor-v1", "environment": public,
        "resource_revision": base["revision"], "resource_content_hash": base["content_hash"],
        **{key: receipt[key] for key in ("snapshot_id", "snapshot_revision", "content_hash", "data_origin", "imported_at")},
        "request_id": payload["request_id"], "source_label": payload["source_label"],
        "payload_file": str(directory / ("import-payload-" + str(index) + ".json")),
        "payload_sha256": digest(payload), "class_node_counts": base["class_node_counts"],
        "t0_wall_ns": t0_wall_ns, "t0_epoch_ms": t0_wall_ns // 1000000,
        "t0_utc": datetime.fromtimestamp(t0_wall_ns / 1e9, timezone.utc).isoformat(),
        "validation": "COMMITTED_NOT_YET_VERIFIED", "browser_rendering": "NOT_RUN_BY_SUBGROUP_B"}


def negative_cases(client, base, anchor, payload, run, *, allow_imports):
    params = observed_params(anchor)
    client.call("GET", RESOURCE + "/devices", params={**params, "revision": "resource-0000000000000000"}, expected=(409,), code=1205)
    client.call("GET", RESOURCE + "/devices", params={**params, "observation_snapshot_id": "DSS-" + "0" * 32}, expected=(404,), code=1002)
    client.call("GET", RESOURCE + "/devices", params={**params, "status_mode": "baseline"}, expected=(422,), code=1001)
    client.call("GET", RESOURCE + "/devices", params={**params, "observation_snapshot_id": None}, expected=(422,), code=1001)
    client.call("GET", RESOURCE + "/devices", params={**params, "page_size": 51}, expected=(422,), code=1001)
    client.call("GET", RESOURCE + "/map", params={**base["map_query"], "status_mode": "observed", "observation_snapshot_id": anchor["snapshot_id"]}, expected=(422,), code=1001)
    client.call("GET", STATUS + "/snapshots/" + identifier(anchor["snapshot_id"]),
        params={"context": "ledger", "snapshot_revision": "device-status-" + "0" * 64}, expected=(409,), code=1203)
    if not allow_imports:
        run.check("read-only invalid version/snapshot/query cases; no negative POSTs")
        return
    receipt_path = STATUS + "/imports/" + identifier(payload["request_id"])
    original = client.call("GET", receipt_path, params={"context": "ledger"})
    require(client.call("POST", STATUS + "/imports", payload) == original, "idempotent replay changed the receipt")
    changed = {**payload, "provenance_note": NOTE + " changed"}
    client.call("POST", STATUS + "/imports", changed, expected=(409,), code=1206)
    total_before = client.call("GET", STATUS + "/snapshots", params={"context": "ledger", "resource_revision": base["revision"]})["total"]
    for label, mutation, expected, code in (
        ("stale", "stale", 409, 1205), ("unknown-device", "device_id", 404, 1002),
        ("wrong-node", "node_id", 409, 1203), ("missing-reason", "unknown_reasons", 422, 1001),
    ):
        invalid = deepcopy(payload)
        invalid["request_id"] = "r6-reject-" + uuid4().hex + "-" + label
        if mutation == "stale":
            invalid["base_revision"] = "resource-0000000000000000"
        elif mutation == "unknown_reasons":
            record = next(record for record in invalid["records"] if record["status"] is None)
            record["unknown_reasons"] = []
        else:
            invalid["records"][0][mutation] = "r6-missing-" + uuid4().hex
        client.call("POST", STATUS + "/imports", invalid, expected=(expected,), code=code)
        client.call("GET", STATUS + "/imports/" + invalid["request_id"], params={"context": "ledger"}, expected=(404,), code=1002)
    total_after = client.call("GET", STATUS + "/snapshots", params={"context": "ledger", "resource_revision": base["revision"]})["total"]
    require(total_before == total_after, "rejected imports changed HTTP-visible snapshot count")
    run.check("serial replay/conflict and rejected imports; absent receipts and unchanged HTTP count, not SQL rollback proof")


def metrics(samples):
    values = sorted(row["elapsed_seconds"] for row in samples if row["outcome"] == "PASS")
    return {"attempted": len(samples), "n": len(values), "failed": sum(row["outcome"] != "PASS" for row in samples),
        "p50_seconds": values[math.ceil(len(values) * .50) - 1] if values else None,
        "p95_seconds": values[math.ceil(len(values) * .95) - 1] if values else None,
        "max_seconds": values[-1] if values else None,
        "max_attempt_seconds": max((row["elapsed_seconds"] for row in samples), default=None),
        "successful_over_60_seconds": sum(value > THRESHOLD_SECONDS for value in values),
        "timeout_or_deadline_failures": sum("Timeout" in row.get("error_type", "")
            or "60 seconds" in row.get("failure_reason", "") or row.get("timeout_requests", 0) > 0 for row in samples)}


def endpoint_key(record):
    path = record["path"]
    path = re.sub(r"/device-status/snapshots/[^/]+", "/device-status/snapshots/{snapshot_id}", path)
    path = re.sub(r"/device-status/imports/[^/]+", "/device-status/imports/{request_id}", path)
    path = re.sub(r"/resource/devices/[^/]+", "/resource/devices/{device_id}", path)
    return record["phase"] + " " + record["method"] + " " + path


def read_sample(shared, args, runtime, account, cookies, base, anchor, payload, lane, index):
    records, started = [], time.perf_counter()
    client = Probe(shared, args, runtime, account, records, cookies=cookies[0], session_id=cookies[1], read_only=True)
    client.phase = lane
    sample = {"lane": lane, "index": index, "outcome": "UNKNOWN", "started_at": utc_now(),
        "snapshot_id": anchor["snapshot_id"], "mutation": "NONE"}
    try:
        timed = time.perf_counter()
        sample["setup_seconds"] = timed - started
        sample["verification"] = refresh_group(client, base, anchor, payload, deadline=timed + THRESHOLD_SECONDS, index=index)
        sample["outcome"] = "PASS"
    except Exception as exc:
        sample.update(outcome="FAIL", error_type=type(exc).__name__)
        if isinstance(exc, Failure):
            sample["failure_reason"] = str(exc)
        sample["timeout_requests"] = sum("Timeout" in row.get("error_type", "") for row in records)
    finally:
        sample["elapsed_seconds"] = time.perf_counter() - locals().get("timed", started)
        client.close()
    return sample, records


def read_lanes(shared, args, runtime, account, client, base, anchor, payload, run, *, serial):
    cookies = (clone_cookies(client.base.client.cookies.jar), client.session_id)
    if serial:
        for index in range(args.rounds):
            sample, records = read_sample(shared, args, runtime, account, cookies, base, anchor, payload, "serial_read", index)
            run.state["samples"].append(sample)
            run.state["requests"].extend(records)
            run.save()
    batch_start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency, thread_name_prefix="r6-read") as executor:
        futures = [executor.submit(read_sample, shared, args, runtime, account, cookies, base, anchor, payload,
            "concurrent_read", index) for index in range(args.rounds)]
        for future in as_completed(futures):
            sample, records = future.result()
            run.state["samples"].append(sample)
            run.state["requests"].extend(records)
            run.save()
    run.state["concurrent_batch_seconds"] = time.perf_counter() - batch_start


def import_rounds(client, args, base, run, public):
    namespace = "r6-" + run.directory.name
    final_anchor = final_payload = first_anchor = first_payload = None
    client.phase = "serial_update_and_read"
    for index in range(args.rounds):
        current = client.call("GET", RESOURCE + "/context", params={"context": "ledger"})
        require(current == base["context"], "resource changed before serial import CAS")
        payload = state_payload(base, namespace, index)
        write_json(run.directory / ("import-payload-" + str(index) + ".json"), payload)
        intent = {"request_id": payload["request_id"], "outcome": "UNKNOWN_UNTIL_RECEIPT_READBACK",
            "payload_sha256": digest(payload), "index": index}
        write_json(run.directory / "pending-import.json", intent)
        started, wall = time.perf_counter(), time.time_ns()
        sample = {"lane": "serial_update_and_read", "index": index, "outcome": "UNKNOWN", "t0_wall_ns": wall,
            "mutation": "SERIAL_RESOURCE_BASE_REVISION_CAS", "request_id": payload["request_id"]}
        previous_records = final_payload["records"] if final_payload is not None else base["devices"]
        sample["changed_device_states"] = sum(any(row.get(field) != previous.get(field) for field in STATE_FIELDS)
            for row, previous in zip(payload["records"], previous_records))
        require(sample["changed_device_states"] > 0, "import must actually change constructed device state")
        run.state["samples"].append(sample)
        try:
            receipt = client.call("POST", STATUS + "/imports", payload, deadline=started + THRESHOLD_SECONDS)
            sample["import_ack_seconds"] = time.perf_counter() - started
            anchor = make_anchor(base, payload, receipt, public, run.directory, index, wall)
            write_json(run.directory / "anchor.json", anchor)
            write_json(run.directory / "pending-import.json", {**intent,
                "outcome": "COMMITTED_FULL_PROJECTION_READBACK_PENDING", "snapshot_id": anchor["snapshot_id"]})
            sample["snapshot_id"] = anchor["snapshot_id"]
            read_receipt = client.call("GET", STATUS + "/imports/" + identifier(payload["request_id"]),
                params={"context": "ledger"}, deadline=started + THRESHOLD_SECONDS)
            require(read_receipt == receipt, "import operation readback changed the receipt")
            directory = client.call("GET", STATUS + "/snapshots", params={"context": "ledger", "resource_revision": base["revision"],
                "page": 1, "page_size": 20}, deadline=started + THRESHOLD_SECONDS)
            require(any(row["snapshot_id"] == anchor["snapshot_id"] and row["snapshot_revision"] == anchor["snapshot_revision"] for row in directory["items"]), "new status snapshot absent from first directory page")
            sample["directory_visible_seconds"] = time.perf_counter() - started
            sample["verification"] = refresh_group(client, base, anchor, payload, deadline=started + THRESHOLD_SECONDS, index=index)
            sample["verified_at_perf_counter"] = time.perf_counter()
            anchor["validation"] = "COMMITTED_HTTP_VERIFIED"
            sample["outcome"] = "PASS"
            final_anchor, final_payload = anchor, payload
            if first_anchor is None:
                first_anchor, first_payload = anchor, payload
            write_json(run.directory / ("anchor-" + str(index) + ".json"), anchor)
            write_json(run.directory / "anchor.json", anchor)
            write_json(run.directory / "pending-import.json", {**intent, "outcome": "COMMITTED_HTTP_VERIFIED", "snapshot_id": anchor["snapshot_id"]})
        except Exception as exc:
            sample.update(outcome="FAIL", error_type=type(exc).__name__)
            if isinstance(exc, Failure):
                sample["failure_reason"] = str(exc)
            # Stop writes after any uncertain outcome. The original ID is retained.
            raise Failure("serial import/readback stopped; inspect pending-import.json and the original request ID") from None
        finally:
            sample["elapsed_seconds"] = sample.pop("verified_at_perf_counter", time.perf_counter()) - started
            sample["completed_wall_ns"] = time.time_ns()
            run.save()
            print(json.dumps({"lane": sample["lane"], "index": index,
                "outcome": sample["outcome"], "elapsed_seconds": sample["elapsed_seconds"]}), flush=True)
    if args.rounds > 1:
        refresh_group(client, base, first_anchor, first_payload, deadline=time.perf_counter() + THRESHOLD_SECONDS)
        run.check("first immutable snapshot still reads its original states after later serial imports")
    return final_anchor, final_payload


def load_anchor(args, public):
    anchor_path = in_evidence(args.anchor)
    anchor = load_json(anchor_path)
    require(anchor.get("schema") == "r6-situation-anchor-v1" and anchor.get("validation") in
        ("COMMITTED_HTTP_VERIFIED", "COMMITTED_NOT_YET_VERIFIED"), "anchor has no committed R6 import receipt")
    for field in ("runtime_root", "database_path", "frontend", "api"):
        require(anchor["environment"][field] == public[field], "anchor belongs to another server/database")
    payload_path = in_evidence(anchor["payload_file"])
    require(payload_path.parent == anchor_path.parent, "payload must belong to the same evidence GUID")
    payload = load_json(payload_path)
    require(digest(payload) == anchor["payload_sha256"] and payload["request_id"] == anchor["request_id"]
        and len(payload["records"]) == 414 and payload["base_revision"] == anchor["resource_revision"], "anchor payload mismatch")
    expected_hash = digest({key: value for key, value in payload.items() if key != "request_id"})
    require(anchor["content_hash"] == expected_hash and anchor["snapshot_revision"] == "device-status-" + expected_hash,
        "anchor content hash does not bind its original import")
    return anchor, payload


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("action", choices=("prepare", "smoke", "import", "snapshot"))
    value.add_argument("--runtime-root", required=True)
    value.add_argument("--database-url", required=True, help="must exactly match this workspace.json; no SQL is opened")
    value.add_argument("--target", required=True, choices=TARGETS)
    value.add_argument("--private-config", help="optional exact assertion of workspace.key_file; never an alternate credential source")
    value.add_argument("--account", choices=("editor", "reviewer"), default="editor")
    value.add_argument("--expected-revision")
    value.add_argument("--expected-content-hash")
    value.add_argument("--anchor", help="verified anchor.json from an earlier R6 import")
    value.add_argument("--rounds", type=int, default=20, help="samples per lane, total concurrent samples (not batches of four)")
    value.add_argument("--concurrency", type=int, choices=(1, 2, 3, 4), default=4)
    value.add_argument("--device-count", type=int, choices=(414,), default=414, help="fixture assertion, not a new formal requirement")
    value.add_argument("--timeout", type=float, default=30, help="per HTTP phase timeout, at most 60 seconds")
    value.add_argument("--audit-timeout", type=float, default=600, help="operational bound for one exhaustive audit, outside performance samples; not a project metric")
    value.add_argument("--audit-report", help="reuse an actual PASS coherence stage for exactly this immutable anchor; does not reuse performance samples")
    value.add_argument("--execute", action="store_true")
    return value


def main(argv=None):
    args = parser().parse_args(argv)
    run = client = None
    try:
        require(1 <= args.rounds <= 100 and 0 < args.timeout <= 60 and math.isfinite(args.timeout), "invalid bounded rounds/timeout")
        require(60 <= args.audit_timeout <= 1800 and math.isfinite(args.audit_timeout), "invalid bounded audit timeout")
        require(args.action == "prepare" or args.execute, "live actions require --execute")
        require(args.action != "prepare" or not args.execute, "prepare is always offline")
        require(args.action != "import" or (args.account == "editor" and args.expected_revision and args.expected_content_hash), "import requires editor and explicit current resource version/hash")
        require(args.action != "snapshot" or args.anchor, "snapshot requires a verified --anchor")
        runtime, private_path, public = environment(args)
        run = Evidence(args, public)
        if args.action == "prepare":
            run.state.update(outcome="PREPARED_OFFLINE_NOT_TESTED", completed=True,
                plan={"writes": "serial POST device-status/imports only, plus login",
                    "serial_import_rounds": args.rounds, "concurrent_read_groups_total": args.rounds,
                    "max_concurrency": args.concurrency, "fixture_devices": 414,
                    "minimum_distinct_corresponding_nodes": {"HF": 50, "VUHF": 100},
                    "credentials_loaded": False, "network_requests": 0})
            return 0
        # Only the program reads credentials; no environment, CLI or fallback source.
        private = load_json(private_path)
        account = private["accounts"][args.account]
        require(all(isinstance(account.get(key), str) and account[key] for key in ("username", "password")), "requested provisioned account is missing")
        shared = r4_module()
        client = Probe(shared, args, runtime, account, run.state["requests"])
        run.state["account_id"] = client.login(account, importing=args.action == "import")
        run.state["outcome"] = "RUNNING"
        anchor = payload = None
        if args.action == "snapshot":
            anchor, payload = load_anchor(args, public)
            require(not args.expected_revision or args.expected_revision == anchor["resource_revision"], "CLI and anchor resource versions disagree")
            require(not args.expected_content_hash or args.expected_content_hash == anchor["resource_content_hash"], "CLI and anchor resource hashes disagree")
            args.expected_revision, args.expected_content_hash = anchor["resource_revision"], anchor["resource_content_hash"]
        base = baseline(client, args)
        run.state["fixture"] = {"resource_revision": base["revision"], "resource_content_hash": base["content_hash"],
            "devices": len(base["devices"]), "nodes": len(base["nodes"]), "class_node_counts": base["class_node_counts"],
            "shared_hf_vuhf_nodes": base["shared_class_nodes"], "class_counts_are_not_disjoint_physical_sites": True,
            "baseline_map_sha256": digest(base["map"])}
        run.check("current resource, 414 devices, class/node minima, map baseline and associations verified")
        if args.action == "smoke":
            detail = client.call("GET", RESOURCE + "/devices/" + identifier(base["devices"][0]["device_id"]),
                params={"context": "ledger", "revision": base["revision"]})
            resource_identity(detail, base["revision"], base["content_hash"])
            require(detail["item"] == base["devices"][0], "baseline detail/list mismatch")
            run.state.update(outcome="PASS_SMOKE_ONLY_PERFORMANCE_NOT_RUN", completed=True)
            return 0
        if args.action == "import":
            anchor, payload = import_rounds(client, args, base, run, public)
        client.phase = "exhaustive_coherence_audit"
        audit_start = time.perf_counter()
        if args.account == "editor":
            original_receipt = client.call("GET", STATUS + "/imports/" + identifier(payload["request_id"]), params={"context": "ledger"})
            require(all(original_receipt.get(key) == anchor[key] for key in
                ("request_id", "snapshot_id", "snapshot_revision", "resource_revision", "content_hash")), "original import receipt is not readable by this operator")
            run.state["original_receipt_readback"] = "PASS_SAME_EDITOR"
        else:
            run.state["original_receipt_readback"] = "NOT_RUN_REVIEWER_IS_NOT_IMPORT_OWNER"
        if args.audit_report:
            audit_path = in_evidence(args.audit_report)
            prior = load_json(audit_path)
            prior_anchor = load_json(audit_path.parent / "anchor.json")
            require(prior.get("coherence_audit", {}).get("outcome") == "PASS", "referenced exhaustive audit has not passed")
            require(prior_anchor.get("validation") == "COMMITTED_HTTP_VERIFIED" and all(prior_anchor.get(key) == anchor[key]
                for key in ("snapshot_id", "snapshot_revision", "resource_revision", "resource_content_hash", "content_hash", "payload_sha256")), "referenced audit belongs to another snapshot")
            require(all(prior["environment"][key] == public[key] for key in ("runtime_root", "database_path", "frontend", "api")), "referenced audit belongs to another environment")
            require(prior["fixture"]["resource_revision"] == base["revision"] and prior["fixture"]["resource_content_hash"] == base["content_hash"], "referenced audit belongs to another resource")
            run.state["coherence_audit"] = {"outcome": "REUSED_PASS", "source_report": str(audit_path),
                "original_audit_elapsed_seconds": prior["coherence_audit"]["elapsed_seconds"],
                "scope": "exact immutable snapshot only; current performance samples are new HTTP requests"}
        else:
            audit_snapshot(client, base, anchor, payload, deadline=audit_start + args.audit_timeout)
            run.state["coherence_audit"] = {"outcome": "PASS", "elapsed_seconds": time.perf_counter() - audit_start,
                "scope": "exhaustive ledger/gis/status/filter checks; outside refresh performance samples"}
        if args.action == "snapshot":
            write_json(run.directory / "import-payload-0.json", payload)
            anchor = {**anchor, "payload_file": str(run.directory / "import-payload-0.json"),
                "prior_anchor": str(in_evidence(args.anchor)), "validation": "COMMITTED_HTTP_VERIFIED"}
            write_json(run.directory / "anchor.json", anchor)
        run.check("exhaustive snapshot coherence verified; owner-receipt result recorded separately")
        client.phase = "negative_cases"
        negative_cases(client, base, anchor, payload, run, allow_imports=args.action == "import")
        read_lanes(shared, args, runtime, account, client, base, anchor, payload, run, serial=args.action == "snapshot")
        client.phase = "final_baseline"
        after = baseline(client, args)
        require(after["devices"] == base["devices"] and after["nodes"] == base["nodes"] and after["context"] == base["context"]
            and after["map"] == base["map"], "state acceptance changed resource baseline")
        run.check("resource baseline unchanged after all status/read scenarios")
        failed = any(row["outcome"] != "PASS" or row["elapsed_seconds"] > THRESHOLD_SECONDS for row in run.state["samples"])
        require(len(run.state["samples"]) == 2 * args.rounds, "incomplete measured sample count")
        run.state.update(outcome="FAIL" if failed else "PASS_HTTP_ONLY_BROWSER_NOT_RUN", completed=True,
            anchor=str(run.directory / "anchor.json"))
        return 1 if failed else 0
    except BaseException as exc:
        if run is not None:
            run.state.update(outcome="FAIL_OR_UNKNOWN_INSPECT_EVIDENCE", error_type=type(exc).__name__, completed=False)
            if isinstance(exc, Failure):
                run.state["failure_reason"] = str(exc)
        else:
            print(json.dumps({"outcome": "PREFLIGHT_REJECTED", "error_type": type(exc).__name__}))
        return 1
    finally:
        if client is not None:
            client.close()
        if run is not None:
            samples = run.state["samples"]
            run.state["metrics"] = {lane: metrics([row for row in samples if row["lane"] == lane]) for lane in sorted({row["lane"] for row in samples})}
            requests = run.state["requests"]
            run.state["endpoint_metrics"] = {key: metrics([row for row in requests if endpoint_key(row) == key])
                for key in sorted({endpoint_key(row) for row in requests})}
            run.state["finished_at"] = utc_now()
            run.save()
            print(json.dumps({"evidence": str(run.directory / "report.json"), "outcome": run.state["outcome"],
                "samples_attempted": len(samples), "browser_rendering": "NOT_RUN_BY_SUBGROUP_B"}))


if __name__ == "__main__":
    raise SystemExit(main())
