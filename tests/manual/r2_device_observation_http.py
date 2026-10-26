"""Opt-in R2 LOCAL HTTP acceptance, not a pytest test or a server launcher.

Preparation only: this file does not establish that any live case has passed.
Use the main Python with -B. No arguments prints help; --plan is also offline.
Repository root follows this file's location, including after cherry-pick into
the main tree; no P1 worktree path or current working directory is baked in.
Every network request requires --execute --allow-writes --ack-target TARGET,
including GETs: LOCAL challenges/session reads can themselves write auth rows.
Credentials come only from process environment, never arguments or evidence:
  R2_HTTP_USERNAME / R2_HTTP_PASSWORD          primary operator
  R2_HTTP_VIEWER_USERNAME / R2_HTTP_VIEWER_PASSWORD  optional read-only operator
  R2_HTTP_PEER_USERNAME / R2_HTTP_PEER_PASSWORD      optional different operator

Main must first migrate/initialize its isolated .19 database, explicitly create
accounts, finish required password changes, restart 8119 with the real factories,
and configure LOCAL_PASSWORD, DEMO off, and the selected allowed Origin. This
script neither bootstraps accounts nor changes passwords, resources or servers.
Run with other writers stopped: count assertions are intentionally strict.
--device-id must name an ACTIVE device; --expected-revision is main's inspected
current resource revision. Numeric configuration candidates use that device's
source values when valid, otherwise its actual model constraints. This is only
SYSTEM_ACCEPTANCE / NOT_DISPATCHED, never evidence of physical device execution.
Status and spectral observations below are explicitly synthetic UNKNOWN/null.
Source checks are OFFLINE_ONLY, with no outbound collection endpoint at all.

Exercise persists only new namespaced status/config/source/observation objects.
It never calls resource maintenance/reset, SQL, filesystem APIs on the server,
or algorithm execution. A new GUID evidence directory is preserved even on
failure. A transport failure means outcome UNKNOWN: inspect the saved original
request IDs; do not assume rollback, rerun with new IDs, or delete evidence.

After main manually restarts 8119 against the same DB, invoke --phase readback
with --checkpoint PATH and all three network gates again. It logs in afresh and
compares frozen GET responses. --replay-after-restart additionally resends the
saved successful commands with their ORIGINAL IDs and compares exact receipts.
It does not restart/kill/probe a process itself. Readback alone is not restart
proof: the main operator must separately retain the actual restart evidence.

Unsupported here: SQL-level zero-write/atomic rollback proof, deliberate damaged
DBs, concurrent races, password lockout, role administration and page/browser
acceptance. HTTP totals plus absent receipts are narrower evidence, not SQL
proof. Missing optional viewer/peer credentials are recorded as NOT_RUN.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
from http.cookiejar import CookieJar
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import (
    HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request, build_opener,
)
from uuid import uuid4


TARGETS = ("http://127.0.0.19:5319", "http://127.0.0.19:8119")
ORIGIN = "SYNTHETIC_INTEGRATION"
STATUS = "/api/v1/device-status"
CONFIG = "/api/v1/device-configurations"
TRACE = "/api/v1/device-traces"
SPECTRUM = "/api/v1/spectrum"
OBS = "/api/v1/observations/spectrum"
REQUIRED = frozenset(("resources.view", "resources.device.edit",
    "resources.device.status.import", "resources.spectrum.edit", "situation.view",
    "situation.observation.import"))
WRITE_PERMISSIONS = REQUIRED - {"resources.view", "situation.view"}
ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / "data" / "runtime" / "tmp"
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,120}\Z")

PLAN = """OFFLINE PLAN ONLY. No request has been sent.
Prerequisites: isolated .19 DB initialized/migrated; LOCAL_PASSWORD, DEMO=0;
main restarts 8119 with real P06/P07 factories; allowed Origin; ACTIVE device;
known current resource revision; primary has all six documented permissions.

0 GET /api/v1/auth/capabilities -> authMode=LOCAL_PASSWORD, initialized=true
  GET /api/v1/auth/csrf -> anonymous challenge cookie + data.csrf_token
  POST /api/v1/auth/login {username: ENV, password: ENV}
    Origin; X-CSRF-Token: challenge; no X-Session-Id; cookie jar retained
  GET /api/v1/auth/csrf -> authenticated data.session_id + data.csrf_token
    subsequent calls send X-Session-Id; POST also X-CSRF-Token and Origin
1 GET /api/v1/resource/context?context=ledger -> data.revision
  GET /api/v1/resource/devices/{device_id}?context=ledger&revision=R
  GET /api/v1/device-configurations/context?context=ledger&device_id=D&revision=R
2 POST /api/v1/device-status/imports
  {schema_version:'device-status-snapshot-a1', context:'ledger', request_id,
   base_revision:R, data_origin:'SYNTHETIC_INTEGRATION', source_label,
   provenance_note, records:[{device_id:D,node_id:N,model_id:M,
   observed_at:null,status:null,alert:null,unknown_reasons:[reason]}]}
  -> snapshot_id=S, snapshot_revision=SR; replay exact original receipt
  GET /api/v1/device-status/imports/{request_id}?context=ledger
  GET /api/v1/device-status/snapshots/{S}/devices?context=ledger&snapshot_revision=SR
  GET resource/devices/{D}?context=ledger&revision=R&status_mode=observed&observation_snapshot_id=S
3 POST /api/v1/device-configurations/validate
  {schema_version:'device-configuration-a1',context:'ledger',base_revision:R,
   device_id:D,model_id:M,values:{tx_power_dbm:number,work_freq_khz:number}}
  POST /api/v1/device-configurations (same body plus request_id)
  -> a2 LOCAL actor, ACCEPTED/SYSTEM_ACCEPTANCE/NOT_DISPATCHED/UNKNOWN
  GET /api/v1/device-configurations/{request_id}?context=ledger
4 GET /api/v1/device-traces/{D}/history?context=ledger&resource_revision=R
  GET /api/v1/device-traces/{D}/operations/{request_id}?context=ledger&resource_revision=R
    only when genuine retained resource history contains an operation
  POST /api/v1/device-traces/{D}/restore-preview
  {schema_version:'device-trace-a1',context:'ledger',base_revision:R,
   source_revision:R,source_request_id:null} -> empty candidate, NOT a save
5 POST /api/v1/spectrum/sources
  {schemaVersion:1,requestId,sourceId,baseConfigRevision:null,draft:{name,
   protocolHint:null,endpoint:null,intervalSeconds:null,minKhz:lo,maxKhz:hi,
   enabled:false,provenanceNote}} -> configRevision=V1
  same ID replay; new ID/base=V1/same draft -> changed=false;
  new ID/base=V1/intervalSeconds=60 -> V2; stale V1 update -> 409/1204
  POST /api/v1/spectrum/sources/{sourceId}/checks
  {schemaVersion:1,requestId,configRevision:V1} -> INCOMPLETE/OFFLINE_ONLY/NOT_ATTEMPTED
  GET /api/v1/spectrum/source-operations/{requestId}?operation_type=SOURCE_SAVE|SOURCE_CHECK
6 POST /api/v1/observations/spectrum/import-preview {file:V2_FILE}
  V2_FILE={schemaVersion:2,fileKind:'SPECTRUM_OBSERVATION_DATASET',
   dataOrigin:'SYNTHETIC_INTEGRATION',dataset:{datasetId,provenanceNote,
   resourceRevision:R,deviceStatusSnapshotId:null,source:{sourceId,name,
   configRevision:V1,minKhz:lo,maxKhz:hi,intervalSeconds:null},frames:[
   {frameId,index:0,observedAt:null,label,bins:[{binId,minKhz:lo,maxKhz:hi,
   occupancyPercent:null,powerDbm:null,abnormal:null,reason:null,
   unknownReasons:[reason]}],occupancyPercent:null,abnormalBandCount:null,
   unknownReasons:[reason]}]},deviceStatusRef:{snapshotId:S,
   snapshotRevision:SR,resourceRevision:R,deviceIds:[D]}}
  -> sourceBinding=REGISTERED_VERSION, previewHash, datasetContentHash, deviceStatusRef
  POST /api/v1/observations/spectrum/imports
  {requestId,previewHash,datasetContentHash,file:UNCHANGED_V2_FILE}
  -> {status:'COMMITTED',receipt:{datasetId,datasetRevision,changed:true},deviceStatusRef}
  same ID exact replay; new ID/same file -> changed=false
  GET /imports/{requestId}?include_device_status_ref=true (relative to observation prefix)
  GET /datasets/{datasetId}/frames/0?dataset_revision=DR
  GET /datasets/{datasetId}/device-status-ref?dataset_revision=DR
  GET /datasets/{datasetId}/export?dataset_revision=DR&include_device_status_ref=true
    -> unchanged V2 file; preview + new-ID import -> changed=false

Failures: anonymous 401/1101; missing CSRF 403/1105; wrong session 409/1106;
unknown/read-only fields 422/1001; unknown device 404/1002;
stale resource 409/1205; wrong device/model/status ref 409/1203;
wrong observation/source revision 409/1204; reused ID/content/actor or
preview mismatch/binding stripping 409/1206. Check absent operation receipts,
HTTP counts and unchanged baseline resource before/after; no SQL proof claimed.
Optional VIEWER: no write permissions -> 403/1104 for all four write families.
Optional PEER: different account, same rights -> ID conflicts; owner receipt denial.

Restart: MAIN restarts manually; readback uses fresh login and frozen GET hashes.
--replay-after-restart also repeats original accepted POSTs, never new IDs.
No password/role/reset/algorithm/device-control endpoints are called.
"""


class CheckFailed(RuntimeError):
    pass


def require(condition, label):
    if not condition:
        raise CheckFailed(label)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def target(value):
    if value not in TARGETS:
        raise argparse.ArgumentTypeError("exact .19:5319 or .19:8119 origin required (no slash/path)")
    return value


def identifier(value):
    if value in (".", "..") or not IDENTIFIER.fullmatch(value):
        raise argparse.ArgumentTypeError("invalid identifier")
    return value


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CheckFailed("redirect refused; no redirected request sent")


class Run:
    def __init__(self, args):
        self.args = args
        self.directory = TMP / ("r2-device-observation-http-" + uuid4().hex)
        self.directory.mkdir(parents=True, exist_ok=False)
        self.path = self.directory / "checkpoint.json"
        self.state = {"script_version": 1, "target": args.target, "origin": args.origin,
            "phase": args.phase, "complete": False, "requests": [], "read_checks": [],
            "replays": [], "not_run": [], "started_at": time.time()}
        self.save()
        print("Evidence:", self.path)

    def save(self):
        self.path.write_text(json.dumps(self.state, ensure_ascii=False, indent=2,
            allow_nan=False) + "\n", encoding="utf-8")

    def skip(self, label):
        self.state["not_run"].append(label)
        self.save()
        print("NOT_RUN", label)

    def frozen(self, client, label, path, query=None, *, raw=False):
        result = client.call("GET", path, query=query, raw=raw, label=label)
        self.state["read_checks"].append({"label": label, "path": path,
            "query": query, "raw": raw, "sha256": digest(result)})
        self.save()
        return result

    def command(self, client, label, path, body):
        # Save intended original IDs before sending: a timeout can follow commit.
        entry = {"label": label, "path": path, "body": deepcopy(body), "result": None}
        self.state["replays"].append(entry)
        self.save()
        result = client.call("POST", path, body=body, label=label)
        entry["result"] = result
        self.save()
        again = client.call("POST", path, body=body, label=label + " exact replay")
        require(again == result, label + " replay must preserve original receipt")
        return result


class Client:
    def __init__(self, run):
        self.run = run
        self.identity = None
        self.sid = None
        self.csrf = None
        self.opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPCookieProcessor(CookieJar()))

    def call(self, method, path, *, body=None, query=None, expected=(200, 0),
             headers=None, raw=False, label="HTTP"):
        a = self.run.args
        require(a.execute and a.allow_writes and a.ack_target == a.target and a.target in TARGETS,
            "network gates not satisfied")
        require(method in ("GET", "POST") and path.startswith("/api/v1/")
            and not any(c in path for c in ("?", "#", "\\", "\r", "\n"))
            and not any(part in (".", "..") for part in path.split("/")), "unsafe request path")
        if method == "POST":
            allowed = {"/api/v1/auth/login", STATUS + "/imports", CONFIG, CONFIG + "/validate",
                SPECTRUM + "/sources", OBS + "/import-preview", OBS + "/imports"}
            dedicated = re.fullmatch(r"/api/v1/(?:device-traces/[A-Za-z0-9_.:-]{1,120}/restore-preview"
                r"|spectrum/sources/[A-Za-z0-9_.:-]{1,120}/checks)", path)
            require(path in allowed or dedicated is not None, "out-of-scope POST refused")
        url = a.target + path + ("?" + urlencode(query) if query else "")
        values = {"Accept": "application/json", "Origin": a.origin, "Sec-Fetch-Site": "same-origin"}
        if self.sid:
            values["X-Session-Id"] = self.sid
        if method == "POST":
            values["Content-Type"] = "application/json"
            if self.csrf:
                values["X-CSRF-Token"] = self.csrf
        for key, value in (headers or {}).items():
            if value is None:
                values.pop(key, None)
            else:
                values[key] = value
        encoded = None if body is None else json.dumps(body, ensure_ascii=False,
            allow_nan=False).encode("utf-8")
        record = {"label": label, "method": method, "path": path, "query": query,
            "expected_status": expected[0], "expected_code": expected[1], "outcome": "UNKNOWN"}
        self.run.state["requests"].append(record)
        self.run.save()
        start = time.monotonic()
        try:
            try:
                response = self.opener.open(Request(url, data=encoded, headers=values, method=method), timeout=30)
            except HTTPError as error:
                response = error
            with response:
                status = response.status
                payload = response.read(4 * 1024 * 1024 + 1)
            require(len(payload) <= 4 * 1024 * 1024, "response exceeds evidence bound")
            value = json.loads(payload.decode("utf-8-sig"))
            code = None if raw else value.get("code") if isinstance(value, dict) else None
            record.update(status=status, code=code, elapsed_seconds=round(time.monotonic() - start, 3))
            require(status == expected[0] and (raw or code == expected[1]),
                f"{label}: expected HTTP/code {expected}, received {(status, code)}")
            record["outcome"] = "PASS"
            print("PASS", label, status, "raw-json" if raw else code)
            return value if raw else value["data"]
        except (URLError, TimeoutError, OSError):
            raise CheckFailed(label + ": transport failure; outcome UNKNOWN, inspect original IDs") from None
        except (ValueError, KeyError, TypeError):
            raise CheckFailed(label + ": noncanonical JSON/envelope; no response body logged") from None
        finally:
            self.run.save()

    def login(self, prefix, required=REQUIRED):
        username, password = credentials(prefix)
        capabilities = self.call("GET", "/api/v1/auth/capabilities", label=prefix + " LOCAL capabilities")
        require(capabilities.get("authMode") == "LOCAL_PASSWORD" and capabilities.get("initialized") is True,
            "target must be initialized LOCAL_PASSWORD, never integration/off")
        challenge = self.call("GET", "/api/v1/auth/csrf", label=prefix + " anonymous challenge")
        self.csrf = challenge["csrf_token"]
        self.identity = self.call("POST", "/api/v1/auth/login",
            body={"username": username, "password": password}, label=prefix + " login")
        require(self.identity.get("integration_mode") is False
            and self.identity.get("data_origin") == "FORMAL_VERIFIED", "not a formal LOCAL identity")
        require(required <= set(self.identity.get("permissions", [])), prefix + " lacks required permissions")
        self.sid = self.identity["session_id"]
        challenge = self.call("GET", "/api/v1/auth/csrf", label=prefix + " session challenge")
        require(challenge["session_id"] == self.sid, "challenge/session mismatch")
        self.csrf = challenge["csrf_token"]
        session = self.call("GET", "/api/v1/auth/session", label=prefix + " authenticated session")
        require(session["account_id"] == self.identity["account_id"], "login/session actor mismatch")
        caps = self.call("GET", "/api/v1/auth/capabilities", label=prefix + " password prerequisite")
        require(caps.get("passwordChangeRequired") is False, "main must finish password change first")


def credentials(prefix):
    username = os.environ.get(prefix + "_USERNAME", "")
    password = os.environ.get(prefix + "_PASSWORD", "")
    require(bool(username and password), prefix + " credentials must come from process environment")
    return username, password


def optional_credentials(prefix):
    values = (os.environ.get(prefix + "_USERNAME", ""), os.environ.get(prefix + "_PASSWORD", ""))
    require(all(bool(v) for v in values) or not any(values), prefix + " requires BOTH environment variables")
    return all(bool(v) for v in values)


def post(client, label, path, body, expected=(200, 0), headers=None):
    return client.call("POST", path, body=body, expected=expected, headers=headers, label=label)


def absent(client, family, request_id):
    key = quote(request_id, safe="")
    if family in ("status", "config"):
        path = STATUS + "/imports/" + key if family == "status" else CONFIG + "/" + key
        client.call("GET", path, query={"context": "ledger"}, expected=(404, 1002), label="rejected ID has no receipt")
    else:
        path = SPECTRUM + "/source-operations/" + key if family == "source" else OBS + "/imports/" + key
        query = {"operation_type": "SOURCE_SAVE"} if family == "source" else None
        result = client.call("GET", path, query=query, label="rejected ID NOT_FOUND")
        require(result["status"] == "NOT_FOUND" and result["receipt"] is None, "rejected ID was persisted")


def reject_new(client, family, label, path, body, expected, headers=None):
    post(client, label, path, body, expected, headers)
    absent(client, family, body["request_id" if family in ("status", "config") else "requestId"])


def exercise(run, client):
    a, state = run.args, run.state
    prefix = "r2-http-" + uuid4().hex
    rid = lambda label: prefix + "-" + label
    device = quote(a.device_id, safe=":")
    ledger = {"context": "ledger"}
    resource_query = {**ledger, "revision": a.expected_revision}
    current = client.call("GET", "/api/v1/resource/context", query=ledger, label="current resource prerequisite")
    require(current["revision"] == a.expected_revision, "expected current revision changed; no business writes started")
    baseline = run.frozen(client, "baseline resource/device", "/api/v1/resource/devices/" + device, resource_query)
    context = run.frozen(client, "configuration context", CONFIG + "/context",
        {**resource_query, "device_id": a.device_id})
    require(context["device"]["availability"] == "ACTIVE" and context["provenance"]["data_origin"] == ORIGIN,
        "requires ACTIVE device in explicitly synthetic project resources")
    require(context["resource_content_hash"] == baseline["content_hash"], "configuration/resource hash mismatch")
    model, frozen = context["model"], context["device"]
    require(all(frozen[key] == baseline["item"][key] for key in ("device_id", "node_id", "model_id")),
        "configuration/resource device association mismatch")
    lo, hi, power_max = model["freq_min_khz"], model["freq_max_khz"], model["tx_power_max_dbm"]
    require(all(type(v) in (int, float) and math.isfinite(v) for v in (lo, hi, power_max))
        and 0 < lo < hi, "model needs finite, distinct positive frequency bounds")
    source_values = frozen["source_values"]
    freq, power = source_values["work_freq_khz"], source_values["tx_power_dbm"]
    freq = freq if freq is not None and lo <= freq <= hi else lo
    power = power if power is not None and power <= power_max else power_max
    state.update(namespace=prefix, account_id=client.identity["account_id"], resource_revision=a.expected_revision,
        device_id=a.device_id, baseline_content_hash=baseline["content_hash"])
    run.save()

    snapshots_before = client.call("GET", STATUS + "/snapshots", query={**ledger,
        "resource_revision": a.expected_revision}, label="initial status total")["total"]
    configs_before = client.call("GET", CONFIG + "/history", query={**ledger,
        "device_id": a.device_id}, label="initial configuration total")["total"]
    datasets_before = client.call("GET", OBS + "/datasets", label="initial dataset total")["total"]
    trace = run.frozen(client, "frozen resource trace", TRACE + "/" + device + "/history",
        {**ledger, "resource_revision": a.expected_revision})
    history_item = next((v for v in trace["items"] if v["request_id"] is not None), None)
    if history_item:
        run.frozen(client, "retained resource operation", TRACE + "/" + device + "/operations/"
            + quote(history_item["request_id"], safe=""), {**ledger, "resource_revision": a.expected_revision})
    else:
        run.skip("trace operation detail: first retained page has no genuine resource operation; no operation invented")
    restore_body = {"schema_version": "device-trace-a1", "context": "ledger", "base_revision": a.expected_revision,
        "source_revision": a.expected_revision, "source_request_id": None}
    restore_path = TRACE + "/" + device + "/restore-preview"
    restore = post(client, "same-version restore is preview only", restore_path, restore_body)
    require(restore["patch"] == {} and restore["compatible"] is False, "same-version restore must not invent differences")
    post(client, "stale restore preview", restore_path,
        {**restore_body, "base_revision": rid("stale-resource")}, (409, 1205))
    client.call("GET", TRACE + "/" + device + "/operations/" + rid("missing-operation"),
        query={**ledger, "resource_revision": a.expected_revision}, expected=(404, 1002), label="trace does not invent an operation")

    reason = "Explicit synthetic acceptance input; actual telemetry is unavailable."
    status_body = {"schema_version": "device-status-snapshot-a1", "context": "ledger", "request_id": rid("status"),
        "base_revision": a.expected_revision, "data_origin": ORIGIN, "source_label": prefix,
        "provenance_note": reason, "records": [{"device_id": a.device_id, "node_id": frozen["node_id"],
        "model_id": frozen["model_id"], "observed_at": None, "status": None, "alert": None,
        "unknown_reasons": [reason]}]}
    anonymous = Client(run)
    anonymous.call("GET", STATUS + "/snapshots", query=ledger, expected=(401, 1101), label="anonymous status denied")
    for label, change, expected, headers in (
        ("missing CSRF", {}, (403, 1105), {"X-CSRF-Token": None}),
        ("wrong session", {}, (409, 1106), {"X-Session-Id": rid("wrong-session")}),
        ("stale resource", {"base_revision": rid("stale-resource")}, (409, 1205), None),
        ("read-only status field", {"snapshot_id": "DSS-" + "0" * 32}, (422, 1001), None),
    ):
        body = {**deepcopy(status_body), **change, "request_id": rid("reject-" + label.replace(" ", "-"))}
        reject_new(client, "status", label, STATUS + "/imports", body, expected, headers)
    for label, field, value, expected in (
        ("missing status reason", "unknown_reasons", [], (422, 1001)),
        ("unknown status device", "device_id", rid("missing-device"), (404, 1002)),
        ("wrong status owner", "node_id", rid("missing-node"), (409, 1203)),
    ):
        body = deepcopy(status_body)
        body["request_id"] = rid(label.replace(" ", "-"))
        body["records"][0][field] = value
        reject_new(client, "status", label, STATUS + "/imports", body, expected)
    status = run.command(client, "status import", STATUS + "/imports", status_body)
    post(client, "status same ID different content", STATUS + "/imports",
        {**status_body, "provenance_note": reason + " changed"}, (409, 1206))
    sq = {**ledger, "snapshot_revision": status["snapshot_revision"]}
    sp = STATUS + "/snapshots/" + quote(status["snapshot_id"], safe="")
    status_receipt = run.frozen(client, "status receipt", STATUS + "/imports/" + status_body["request_id"], ledger)
    require(status_receipt == status, "status GET receipt changed")
    header = run.frozen(client, "status header", sp, sq)
    require(header["counts"]["UNKNOWN"] == 1 and header["counts"]["total"] == 1, "unknown status count lost")
    records = run.frozen(client, "status unknown records", sp + "/devices", {**sq, "status_filter": "UNKNOWN"})
    require(records["total"] == 1 and all(records["items"][0][k] is None
        for k in ("status", "alert", "observed_at")) and records["items"][0]["unknown_reasons"] == [reason],
        "status unknown values/reasons were invented or lost")
    observed = run.frozen(client, "observed resource projection", "/api/v1/resource/devices/" + device,
        {**resource_query, "status_mode": "observed", "observation_snapshot_id": status["snapshot_id"]})
    require(all(observed["item"][k] is None for k in ("status", "alert", "observed_at")), "observed nulls fell back to baseline")
    client.call("GET", sp, query={**sq, "snapshot_revision": "device-status-" + "0" * 64},
        expected=(409, 1203), label="wrong status revision")

    config_body = {"schema_version": "device-configuration-a1", "context": "ledger", "base_revision": a.expected_revision,
        "device_id": a.device_id, "model_id": frozen["model_id"], "values": {"tx_power_dbm": power, "work_freq_khz": freq}}
    validated = post(client, "validate configuration", CONFIG + "/validate", config_body)
    require(validated["valid"] is True, "configuration validation not valid")
    config_body["request_id"] = rid("config")
    for label, change, expected in (
        ("configuration fake online", {"online": True}, (422, 1001)),
        ("configuration stale", {"base_revision": rid("stale-resource")}, (409, 1205)),
        ("configuration wrong model", {"model_id": rid("wrong-model")}, (409, 1203)),
        ("configuration invalid frequency", {"values": {"tx_power_dbm": power, "work_freq_khz": 0}}, (422, 1001)),
        ("configuration out of model", {"values": {"tx_power_dbm": power, "work_freq_khz": lo / 2}}, (422, 1001)),
    ):
        reject_new(client, "config", label, CONFIG,
            {**config_body, **change, "request_id": rid(label.replace(" ", "-"))}, expected)
    configuration = run.command(client, "configuration acceptance", CONFIG, config_body)
    require(configuration["schema_version"] == "device-configuration-a2"
        and configuration["actor"]["authentication_mode"] == "LOCAL_PASSWORD"
        and all(configuration[k] == v for k, v in {"status": "ACCEPTED", "receipt_scope": "SYSTEM_ACCEPTANCE",
        "dispatch_status": "NOT_DISPATCHED", "device_execution_status": "UNKNOWN"}.items())
        and all(configuration[k] is None for k in ("applied_values", "online", "effective", "device_reported_at")),
        "configuration falsely reports dispatch/effect or integration actor")
    post(client, "configuration same ID different content", CONFIG,
        {**config_body, "values": {"tx_power_dbm": power - 1, "work_freq_khz": freq}}, (409, 1206))
    require(run.frozen(client, "configuration receipt", CONFIG + "/" + config_body["request_id"], ledger)
        == configuration, "configuration GET receipt changed")

    source_id = rid("source")
    source_path = SPECTRUM + "/sources/" + source_id
    draft = {"name": "R2 synthetic " + prefix[-12:], "protocolHint": None, "endpoint": None,
        "intervalSeconds": None, "minKhz": lo, "maxKhz": hi, "enabled": False, "provenanceNote": reason}
    source_body = {"schemaVersion": 1, "requestId": rid("source-save"), "sourceId": source_id,
        "baseConfigRevision": None, "draft": draft}
    reject_new(client, "source", "source fake connection", SPECTRUM + "/sources",
        {**source_body, "requestId": rid("source-invalid"), "connection": "CONNECTED"}, (422, 1001))
    source = run.command(client, "source create", SPECTRUM + "/sources", source_body)
    require(source["changed"] is True and source["source"]["draft"] == draft, "source create changed declaration")
    v1 = source["configRevision"]
    post(client, "source same ID different content", SPECTRUM + "/sources",
        {**source_body, "draft": {**draft, "name": draft["name"] + " changed"}}, (409, 1206))
    source_noop = {**source_body, "requestId": rid("source-noop"), "baseConfigRevision": v1}
    require(run.command(client, "source new ID same configuration", SPECTRUM + "/sources", source_noop)["changed"] is False,
        "source same configuration created a new version")
    source_update = {**source_noop, "requestId": rid("source-update"), "draft": {**draft, "intervalSeconds": 60}}
    updated = run.command(client, "source isolated new version", SPECTRUM + "/sources", source_update)
    v2 = updated["configRevision"]
    require(updated["changed"] is True and v2 != v1, "source version did not advance")
    reject_new(client, "source", "stale source base", SPECTRUM + "/sources",
        {**source_noop, "requestId": rid("source-stale")}, (409, 1204))
    check_body = {"schemaVersion": 1, "requestId": rid("source-check"), "configRevision": v1}
    checked = run.command(client, "source historical offline check", source_path + "/checks", check_body)
    require(checked["changed"] is False and checked["check"]["validation"] == "INCOMPLETE"
        and checked["check"]["connection"] == "NOT_ATTEMPTED"
        and checked["check"]["validationMode"] == "OFFLINE_ONLY", "source check implied live connectivity")
    post(client, "check same ID different version", source_path + "/checks",
        {**check_body, "configRevision": v2}, (409, 1206))
    for label, receipt, operation in (("source save receipt", source, "SOURCE_SAVE"),
                                    ("source check receipt", checked, "SOURCE_CHECK")):
        result = run.frozen(client, label, SPECTRUM + "/source-operations/" + receipt["requestId"],
            {"operation_type": operation})
        require(result["status"] == "COMMITTED" and result["receipt"] == receipt, label + " changed")
    client.call("GET", SPECTRUM + "/source-operations/" + source["requestId"], query={"operation_type": "SOURCE_CHECK"},
        expected=(409, 1204), label="source wrong operation type")
    require(run.frozen(client, "historical source V1", source_path, {"config_revision": v1}) == source["source"],
        "historical source replaced by current")
    run.frozen(client, "current source V2", source_path)
    source_export = run.frozen(client, "source configuration export", source_path + "/export", {"config_revision": v1}, raw=True)
    require(source_export["draft"] == draft and source_export["configRevision"] == v1, "source export lost frozen declaration")
    require(client.call("GET", source_path + "/versions", label="source versions count")["total"] == 2,
        "source replay/noop created extra versions")
    require(client.call("GET", source_path + "/checks", label="source checks count")["total"] == 1,
        "source replay created extra checks")

    ref = {"snapshotId": status["snapshot_id"], "snapshotRevision": status["snapshot_revision"],
        "resourceRevision": a.expected_revision, "deviceIds": [a.device_id]}
    frame = {"frameId": rid("frame"), "index": 0, "observedAt": None, "label": "Explicit synthetic UNKNOWN frame",
        "bins": [{"binId": rid("bin"), "minKhz": lo, "maxKhz": hi, "occupancyPercent": None,
        "powerDbm": None, "abnormal": None, "reason": None, "unknownReasons": [reason]}],
        "occupancyPercent": None, "abnormalBandCount": None, "unknownReasons": [reason]}
    file = {"schemaVersion": 2, "fileKind": "SPECTRUM_OBSERVATION_DATASET", "dataOrigin": ORIGIN,
        "dataset": {"datasetId": rid("dataset"), "provenanceNote": reason, "resourceRevision": a.expected_revision,
        "deviceStatusSnapshotId": None, "source": {"sourceId": source_id, "name": draft["name"], "configRevision": v1,
        "minKhz": lo, "maxKhz": hi, "intervalSeconds": None}, "frames": [frame]}, "deviceStatusRef": ref}
    preview = post(client, "V2 preview with real P06 reference", OBS + "/import-preview", {"file": file})
    require(preview["schemaVersion"] == 2 and preview["sourceBinding"] == "REGISTERED_VERSION"
        and preview["previewHash"] != preview["datasetContentHash"], "preview binding/hash domains are wrong")
    for label, mutate, expected in (
        ("observation stale R", lambda f: f["dataset"].update(resourceRevision=rid("stale-resource")), (409, 1205)),
        ("observation wrong ref R", lambda f: f["deviceStatusRef"].update(resourceRevision=rid("wrong-resource")), (409, 1203)),
        ("observation wrong ref revision", lambda f: f["deviceStatusRef"].update(snapshotRevision="device-status-" + "0" * 64), (409, 1203)),
        ("observation missing ref member", lambda f: f["deviceStatusRef"].update(deviceIds=[rid("missing-device")]), (404, 1002)),
        ("observation wrong source declaration", lambda f: f["dataset"]["source"].update(name="wrong registered name"), (409, 1204)),
        ("observation unknown without reason", lambda f: f["dataset"]["frames"][0].update(unknownReasons=[]), (422, 1001)),
        ("observation fake field", lambda f: f.update(algorithmEvaluated=True), (422, 1001)),
    ):
        bad = deepcopy(file)
        mutate(bad)
        post(client, label, OBS + "/import-preview", {"file": bad}, expected)
    command = {"requestId": rid("observation"), "previewHash": preview["previewHash"],
        "datasetContentHash": preview["datasetContentHash"], "file": file}
    reject_new(client, "observation", "preview hash mismatch", OBS + "/imports",
        {**command, "requestId": rid("bad-preview"), "previewHash": "0" * 64}, (409, 1206))
    imported = run.command(client, "V2 observation import", OBS + "/imports", command)
    require(imported["schemaVersion"] == 2 and imported["status"] == "COMMITTED"
        and imported["receipt"]["changed"] is True and imported["deviceStatusRef"] == preview["deviceStatusRef"],
        "V2 import/ref not committed as previewed")
    noop_command = {**command, "requestId": rid("observation-noop")}
    require(run.command(client, "same dataset new ID noop", OBS + "/imports", noop_command)["receipt"]["changed"] is False,
        "same observation dataset was imported twice")
    changed_file = deepcopy(file)
    changed_file["dataset"]["provenanceNote"] += " changed"
    # Existing dataset content/binding conflicts are rejected before new hashes are issued.
    post(client, "preview changed content", OBS + "/import-preview", {"file": changed_file}, (409, 1206))
    changed_command = {**command, "file": changed_file}
    post(client, "changed content with original preview hashes", OBS + "/imports", changed_command, (409, 1206))
    reject_new(client, "observation", "new ID changed content with original preview hashes", OBS + "/imports",
        {**changed_command, "requestId": rid("dataset-conflict")}, (409, 1206))
    v1_file = {key: deepcopy(value) for key, value in file.items() if key != "deviceStatusRef"}
    v1_file["schemaVersion"] = 1
    post(client, "V1 preview cannot strip binding", OBS + "/import-preview", {"file": v1_file}, (409, 1206))
    reject_new(client, "observation", "cannot strip frozen binding", OBS + "/imports",
        {"requestId": rid("strip-binding"), "previewHash": command["datasetContentHash"], "file": v1_file}, (409, 1206))
    receipt = run.frozen(client, "observation V2 receipt", OBS + "/imports/" + command["requestId"],
        {"include_device_status_ref": "true"})
    require(receipt == imported, "observation receipt/ref changed")
    legacy_receipt = run.frozen(client, "default V1 receipt projection", OBS + "/imports/" + command["requestId"])
    require(legacy_receipt["schemaVersion"] == 1 and "deviceStatusRef" not in legacy_receipt, "legacy receipt contract changed")
    dataset_path = OBS + "/datasets/" + imported["receipt"]["datasetId"]
    dq = {"dataset_revision": imported["receipt"]["datasetRevision"]}
    run.frozen(client, "frozen frame list", dataset_path + "/frames", dq)
    read_frame = run.frozen(client, "frozen frame zero", dataset_path + "/frames/0", dq)
    require(read_frame["frame"]["observedAt"] is None and read_frame["frame"]["bins"][0]["powerDbm"] is None
        and read_frame["frame"]["unknownReasons"] == [reason], "frame unknown values/reasons changed")
    linked = run.frozen(client, "frozen P06 reference", dataset_path + "/device-status-ref", dq)
    require(linked["deviceStatusRef"] == imported["deviceStatusRef"], "reference not frozen")
    client.call("GET", dataset_path + "/frames/1", query=dq, expected=(404, 1002), label="finite replay ends at last frame")
    client.call("GET", dataset_path + "/frames/0", query={"dataset_revision": "observation-" + "0" * 64},
        expected=(409, 1204), label="wrong observation revision")
    exported = run.frozen(client, "V2 observation export", dataset_path + "/export",
        {**dq, "include_device_status_ref": "true"}, raw=True)
    require(exported == file, "V2 export round trip lost body or original binding")
    legacy_export = run.frozen(client, "default V1 export", dataset_path + "/export", dq, raw=True)
    require(legacy_export == v1_file, "default V1 export protocol changed")
    export_preview = post(client, "preview exported V2 file", OBS + "/import-preview", {"file": exported})
    exported_command = {"requestId": rid("export-noop"), "previewHash": export_preview["previewHash"],
        "datasetContentHash": export_preview["datasetContentHash"], "file": exported}
    require(run.command(client, "exported V2 reimport noop", OBS + "/imports", exported_command)["receipt"]["changed"] is False,
        "exported dataset did not retain original identity")

    optional_cases(run, client, status_body, config_body, source_body, command)
    require(run.frozen(client, "final source version total", source_path + "/versions")["total"] == 2,
        "rejected source operations created extra versions")
    require(run.frozen(client, "final source check total", source_path + "/checks")["total"] == 1,
        "rejected source operations created extra checks")
    require(run.frozen(client, "final status total", STATUS + "/snapshots", {**ledger, "resource_revision": a.expected_revision}
        )["total"] == snapshots_before + 1, "status failures/replays created extra snapshots")
    require(run.frozen(client, "final configuration total", CONFIG + "/history", {**ledger, "device_id": a.device_id}
        )["total"] == configs_before + 1, "configuration failures/replays wrote requests")
    require(run.frozen(client, "final dataset total", OBS + "/datasets")["total"] == datasets_before + 1,
        "observation failures/replays created extra datasets")
    require(client.call("GET", "/api/v1/resource/context", query=ledger, label="resource context unchanged") == current,
        "resource context changed; investigate concurrent writers or production behavior")
    require(client.call("GET", "/api/v1/resource/devices/" + device, query=resource_query,
        label="baseline device unchanged") == baseline, "baseline resource/device changed")
    require(client.call("GET", CONFIG + "/context", query={**resource_query, "device_id": a.device_id},
        label="resource provenance unchanged") == context, "source_files/model/resource hash changed")
    run.state["limitations"] = ["HTTP counts/receipts only, no direct SQL atomicity/zero-write proof",
        "resource unchanged assertion covers revision/hash/provenance and selected device, not SQL table reads",
        "real restart and page acceptance not performed by this script"]


def optional_cases(run, primary, status, configuration, source, observation):
    families = (("status", STATUS + "/imports", status), ("config", CONFIG, configuration),
        ("source", SPECTRUM + "/sources", source), ("observation", OBS + "/imports", observation))
    for env, label in (("R2_HTTP_VIEWER", "viewer permission denial"), ("R2_HTTP_PEER", "cross-actor idempotency")):
        if not optional_credentials(env):
            run.skip(label + ": optional credentials absent")
            continue
        other = Client(run)
        other.login(env, frozenset(("resources.view", "situation.view")) if env.endswith("VIEWER") else REQUIRED)
        require(other.identity["account_id"] != primary.identity["account_id"], "optional account must differ from primary")
        viewer = env.endswith("VIEWER")
        if viewer:
            require(not WRITE_PERMISSIONS.intersection(other.identity["permissions"]), "VIEWER unexpectedly has write rights")
        for family, path, original in families:
            body = deepcopy(original)
            if viewer:
                key = "request_id" if family in ("status", "config") else "requestId"
                body[key] += "-viewer"
                post(other, label + " " + family, path, body, (403, 1104))
                # Observation receipt GET itself requires import rights; use the primary.
                absent(primary, family, body[key])
            else:
                post(other, label + " " + family, path, body, (409, 1206))
        if not viewer:
            for path, query, expected in (
                (STATUS + "/imports/" + status["request_id"], {"context": "ledger"}, (404, 1002)),
                (CONFIG + "/" + configuration["request_id"], {"context": "ledger"}, (404, 1002)),
                (SPECTRUM + "/source-operations/" + source["requestId"], {"operation_type": "SOURCE_SAVE"}, (403, 1104)),
                (OBS + "/imports/" + observation["requestId"], {"include_device_status_ref": "true"}, (403, 1104)),
            ):
                other.call("GET", path, query=query, expected=expected, label="other actor cannot read owner receipt")


def load_checkpoint(args):
    path = args.checkpoint.resolve()
    require(path.is_relative_to(TMP.resolve()) and path.name == "checkpoint.json", "checkpoint must be retained runtime/tmp evidence")
    require(path.stat().st_size <= 8 * 1024 * 1024, "checkpoint too large")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(value.get("script_version") == 1 and value.get("phase") == "exercise" and value.get("complete") is True,
        "restart readback requires a COMPLETE exercise checkpoint")
    require(value.get("target") == args.target and value.get("origin") == args.origin, "checkpoint target/Origin mismatch")
    allowed = {STATUS + "/imports", CONFIG, SPECTRUM + "/sources", OBS + "/imports"}
    for command in value["replays"]:
        path = command["path"]
        check_path = re.fullmatch(re.escape(SPECTRUM) + r"/sources/[A-Za-z0-9_.:-]{1,120}/checks", path)
        require(path in allowed or check_path is not None, "checkpoint contains an out-of-scope POST")
    return value


def readback(run, client, old):
    require(client.identity["account_id"] == old["account_id"], "readback must use original actor")
    run.state.update(original_checkpoint=str(run.args.checkpoint.resolve()), account_id=old["account_id"])
    for check in old["read_checks"]:
        result = run.frozen(client, "after manual restart: " + check["label"], check["path"], check["query"], raw=check["raw"])
        require(digest(result) == check["sha256"], "frozen readback differs: " + check["label"])
    if run.args.replay_after_restart:
        for command in old["replays"]:
            require(command["result"] is not None, "cannot replay an unknown original outcome")
            result = post(client, "after restart original-ID replay: " + command["label"], command["path"], command["body"])
            require(result == command["result"], "original-ID replay changed receipt: " + command["label"])
        for check in old["read_checks"]:
            result = run.frozen(client, "after original-ID replay: " + check["label"], check["path"], check["query"], raw=check["raw"])
            require(digest(result) == check["sha256"], "replay changed frozen data/counts: " + check["label"])
    else:
        run.skip("post-restart original-ID POST replay: --replay-after-restart not provided")
    run.state["limitations"] = ["main must separately retain actual restart evidence",
        "login/challenge/session activity can write auth/audit rows; frozen business reads are GET only"]


def parser():
    result = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    result.add_argument("--plan", action="store_true", help="print exact contracts/order offline, no env credentials or HTTP")
    result.add_argument("--execute", action="store_true", help="main explicitly opts in to real HTTP")
    result.add_argument("--allow-writes", action="store_true", help="acknowledge auth writes and exercise business writes")
    result.add_argument("--target", type=target, help="exact allowlisted HTTP origin; no default")
    result.add_argument("--ack-target", type=target, help="must exactly repeat --target")
    result.add_argument("--origin", type=target, default=TARGETS[0], help="server-allowed browser Origin (default .19:5319)")
    result.add_argument("--phase", choices=("exercise", "readback"), default="exercise")
    result.add_argument("--device-id", type=identifier, help="main-inspected ACTIVE device, exercise only")
    result.add_argument("--expected-revision", type=identifier, help="main-inspected current resource revision, exercise only")
    result.add_argument("--checkpoint", type=Path, help="completed exercise checkpoint, readback only")
    result.add_argument("--replay-after-restart", action="store_true", help="readback additionally repeats original POSTs with original IDs")
    return result


def main(argv=None):
    cli = parser()
    args = cli.parse_args(argv)
    if args.plan:
        if args.execute or args.allow_writes:
            cli.error("--plan is offline and cannot be combined with execution gates")
        print(PLAN)
        return 0
    if not args.execute:
        cli.print_help()
        return 0
    if not (args.allow_writes and args.target and args.ack_target == args.target):
        cli.error("network requires --execute --allow-writes --target TARGET --ack-target TARGET")
    if args.phase == "exercise" and (not args.device_id or not args.expected_revision or args.checkpoint or args.replay_after_restart):
        cli.error("exercise requires device-id/expected-revision and forbids checkpoint/replay-after-restart")
    if args.phase == "readback" and (not args.checkpoint or args.device_id or args.expected_revision):
        cli.error("readback requires checkpoint and forbids device-id/expected-revision")
    run = None
    try:
        credentials("R2_HTTP")
        optional_credentials("R2_HTTP_VIEWER")
        optional_credentials("R2_HTTP_PEER")
        old = load_checkpoint(args) if args.phase == "readback" else None
        run = Run(args)
        client = Client(run)
        client.login("R2_HTTP")
        if old is None:
            exercise(run, client)
        else:
            readback(run, client, old)
        run.state.update(complete=True, finished_at=time.time())
        run.save()
        print("COMPLETE", args.phase, "HTTP checks only; see limitations/NOT_RUN in", run.path)
        return 0
    except (CheckFailed, OSError, ValueError, KeyError, TypeError) as error:
        # Never stringify arbitrary exceptions: a urllib/JSON error may contain secrets.
        message = str(error) if isinstance(error, CheckFailed) else "local evidence/contract failure; details withheld"
        if run is not None:
            run.state.update(complete=False, failure=message, finished_at=time.time())
            run.save()
        print("STOP:", message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
