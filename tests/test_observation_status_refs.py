"""关联定向验证；没有真实P06时明确skip，不注入同名替身。"""
from copy import deepcopy
import json

import pytest
from pydantic import ValidationError
from sqlalchemy import event, inspect, text
from sqlalchemy.exc import IntegrityError

from test_observation_api import database, public_api, portable, imported, counts, post, get, switch_current_for_history
from app import observation_service as service, observation_status_ref_service as refs
from app.observation_models import ObservationDataset, ObservationImportOperation
from app.observation_schemas import ObservationImportCommand, ObservationDeviceStatusRefInput, parse_import_file


def ref_input(revision="resource-A"):
    return {"snapshotId": "DSS-" + "a" * 32, "snapshotRevision": "device-status-" + "b" * 64,
        "resourceRevision": revision, "deviceIds": ["device-B", "device-A"]}


def test_ref_canonical_domains_and_v1_request_stay_unchanged(public_api):
    file = parse_import_file(portable(public_api))
    request = file.to_request("golden")
    canonical = refs.canonical(ref_input())
    assert canonical["deviceIds"] == ["device-A", "device-B"]
    assert ref_input()["deviceIds"] == ["device-B", "device-A"]
    h = service.content_hash(request.model_dump(mode="json", exclude={"requestId"}))
    assert refs.preview_hash(h, canonical) != h
    assert refs.operation_digest(request, canonical) != service.content_hash(request.model_dump(mode="json"))
    assert refs.preview_hash(h, canonical) == refs.preview_hash(h, ref_input())
    wire = refs.wire(request.datasetId, "observation-" + h, canonical)
    assert wire["refRevision"] == "OSR-" + wire["contentHash"]
    assert request.deviceStatusSnapshotId is None and request.schemaVersion == 1


@pytest.mark.parametrize("patch", [{"deviceIds": []}, {"deviceIds": ["a", "a"]}, {"deviceIds": [1]},
    {"snapshotId": "guessed"}, {"snapshotRevision": "v1"}, {"status": "NORMAL"}])
def test_strict_ref_input(patch):
    with pytest.raises(ValidationError):
        ObservationDeviceStatusRefInput.model_validate({**ref_input(), **patch})


def test_v2_requires_separate_dataset_digest_and_exact_version(public_api):
    file = {**portable(public_api), "schemaVersion": 2, "deviceStatusRef": ref_input(public_api["revision"])}
    assert parse_import_file(file).schemaVersion == 2
    with pytest.raises(ValidationError):
        parse_import_file({**file, "schemaVersion": True})
    with pytest.raises(ValidationError):
        ObservationImportCommand.model_validate({"file": file, "requestId": "x", "previewHash": "a" * 64})
    with pytest.raises(ValidationError):
        ObservationImportCommand.model_validate({"file": portable(public_api), "requestId": "x", "previewHash": "a" * 64, "datasetContentHash": None})


def test_missing_0021_keeps_v1_and_never_creates_table(public_api):
    db = public_api
    before = inspect(db["engine"]).get_table_names()
    file = portable(db)
    preview = post(db, "/import-preview", {"file": file}).json()["data"]
    command = {"requestId": "v1-golden", "previewHash": preview["previewHash"], "file": file}
    response = post(db, "/imports", command)
    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    revision = receipt["receipt"]["datasetRevision"]
    assert set(preview) == {"schemaVersion", "dataOrigin", "previewHash", "datasetId", "resourceRevision", "source", "frameCount", "sourceBinding", "warnings"}
    with db["factory"]() as session:
        row = session.get(ObservationDataset, "obs-A")
        summary = service._summary(row)
        assert row.metadata_hash == service.content_hash({"summary": summary, "actorId": row.actor_id})
        operation = session.get(ObservationImportOperation, "v1-golden")
        assert operation.receipt == receipt["receipt"]
        assert operation.request_digest == service.content_hash(parse_import_file(file).to_request("v1-golden").model_dump(mode="json"))
    assert post(db, "/imports", command).json()["data"] == receipt
    assert get(db, "/datasets/obs-A/export", revision).json()["schemaVersion"] == 1
    assert get(db, "/datasets/obs-A/device-status-ref", revision).status_code == 503
    assert get(db, "/imports/v1-golden", include_device_status_ref="true").status_code == 503
    assert get(db, "/datasets/obs-A/export", revision, include_device_status_ref="true").status_code == 503
    v2 = {**file, "schemaVersion": 2, "deviceStatusRef": ref_input(db["revision"])}
    assert post(db, "/import-preview", {"file": v2}).status_code == 503
    assert counts(db) == (1, 3, 1)
    assert inspect(db["engine"]).get_table_names() == before


@pytest.mark.parametrize("query", ["TRUE", "1", "", "null"])
def test_ref_projection_query_is_strict(public_api, query):
    assert get(public_api, "/imports/none", include_device_status_ref=query).status_code == 422


def test_v2_resources_permission_precedes_database_factory(public_api, monkeypatch):
    from app import frontend_integration, observation_routes
    original = frontend_integration.session_identity()
    monkeypatch.setattr(frontend_integration, "session_identity", lambda: {
        **original, "permissions": [p for p in original["permissions"] if p != "resources.view"]})
    def forbidden_factory():
        raise AssertionError("V2权限拒绝前不得读取业务数据库")
    monkeypatch.setattr(observation_routes, "get_session_factory", forbidden_factory)
    file = {**portable(public_api), "schemaVersion": 2, "deviceStatusRef": ref_input(public_api["revision"])}
    response = post(public_api, "/import-preview", {"file": file})
    assert response.status_code == 403 and response.json()["code"] == 1104


@pytest.fixture
def linked(public_api, monkeypatch):
    p06 = pytest.importorskip("app.device_status_service", reason="本树缺真实P06，须主集成验证；不以stub替代")
    from app.device_status_models import DeviceStatusSnapshot, DeviceStatusRecord, DeviceStatusImportOperation
    from app.device_status_schemas import DeviceStatusImport, SCHEMA
    from app.observation_status_ref_models import OBSERVATION_REF_METADATA
    db = public_api
    for model in (DeviceStatusSnapshot, DeviceStatusRecord, DeviceStatusImportOperation):
        model.__table__.create(db["engine"], checkfirst=True)
    OBSERVATION_REF_METADATA.create_all(db["engine"])
    monkeypatch.setattr(p06, "get_session_factory", lambda: db["factory"])
    from app import resource_dataset_service as resources
    devices = resources.current(factory=db["factory"])["tables"]["device.csv"][:2]
    request = DeviceStatusImport.model_validate({"schema_version": SCHEMA, "context": "ledger", "request_id": "p07-status",
        "base_revision": db["revision"], "data_origin": "SYNTHETIC_INTEGRATION", "source_label": "P07显式测试",
        "provenance_note": "构造非实测", "records": [{"device_id": d["device_id"], "node_id": d["node_id"], "model_id": d["model_id"],
            "status": None, "alert": None, "observed_at": None, "unknown_reasons": ["构造未提供"]} for d in devices]})
    receipt = p06.import_snapshot(request, "p07-test")
    ref = {"snapshotId": receipt["snapshot_id"], "snapshotRevision": receipt["snapshot_revision"],
        "resourceRevision": db["revision"], "deviceIds": [d["device_id"] for d in reversed(devices)]}
    return db, ref, p06


def command_for(db, ref, request_id="v2-import", dataset_id="obs-A"):
    file = {**portable(db), "schemaVersion": 2, "deviceStatusRef": deepcopy(ref)}
    file["dataset"]["datasetId"] = dataset_id
    preview = service.preview_import(file, factory=db["factory"])
    return {"file": file, "requestId": request_id, "previewHash": preview["previewHash"], "datasetContentHash": preview["datasetContentHash"]}


def test_real_p06_historical_noop_keeps_ref_and_resource_after_current_switch(linked):
    db, ref, _ = linked
    command = command_for(db, ref)
    first = service.import_file(command, actor_id="actor", factory=db["factory"])
    switch_current_for_history(db)
    assert service.preview_import(command["file"], factory=db["factory"])["previewHash"] == command["previewHash"]
    repeat = service.import_file({**command, "requestId": "historical-ref-noop"}, actor_id="actor", factory=db["factory"])
    assert repeat["receipt"]["changed"] is False and repeat["deviceStatusRef"] == first["deviceStatusRef"]
    assert repeat["receipt"]["resourceRevision"] == db["revision"]
    changed = deepcopy(command["file"])
    changed["deviceStatusRef"]["deviceIds"] = changed["deviceStatusRef"]["deviceIds"][:1]
    with pytest.raises(service.ObservationError) as error:
        service.preview_import(changed, factory=db["factory"])
    assert error.value.code == 1206
    assert counts(db) == (1, 3, 2)


def test_real_p06_atomic_binding_hashes_export_replay_and_no_rebind(linked):
    db, ref, _ = linked
    command = command_for(db, ref)
    before = counts(db)
    assert before == (0, 0, 0)  # 预检没有导入观测/关联。
    result = service.import_file(command, actor_id="actor", factory=db["factory"])
    assert result["schemaVersion"] == 2 and result["receipt"]["changed"]
    revision = result["receipt"]["datasetRevision"]
    assert revision == "observation-" + command["datasetContentHash"]
    assert revision != "observation-" + command["previewHash"]
    assert service.import_file(command, actor_id="actor", factory=db["factory"]) == result
    repeat = service.import_file({**command, "requestId": "second"}, actor_id="actor", factory=db["factory"])
    assert not repeat["receipt"]["changed"]
    with db["factory"]() as session:
        assert session.get(ObservationDataset, "obs-A").device_status_snapshot_id is None
        projected = service.device_status_ref(session, "obs-A", revision)
        assert projected["deviceStatusRef"] == result["deviceStatusRef"]
        assert service.import_receipt(session, "v2-import", "actor", True)["deviceStatusRef"] == projected["deviceStatusRef"]
        assert json.loads(service.export_dataset(session, "obs-A", revision))["schemaVersion"] == 1
        exported = json.loads(service.export_dataset(session, "obs-A", revision, True))
        assert exported["schemaVersion"] == 2 and refs.canonical(exported["deviceStatusRef"]) == refs.canonical(ref)
    with pytest.raises(service.ObservationError) as conflict:
        service.import_file({"file": {k: v for k, v in command["file"].items() if k != "deviceStatusRef"} | {"schemaVersion": 1},
            "requestId": "strip", "previewHash": command["datasetContentHash"]}, actor_id="actor", factory=db["factory"])
    assert conflict.value.code == 1206
    with pytest.raises(service.ObservationError):
        service.import_file(command, actor_id="other", factory=db["factory"])
    assert counts(db) == (1, 3, 2)


@pytest.mark.parametrize("failure", ["missing", "version", "resource", "member"])
def test_real_p06_failure_rolls_back_all_observation_objects(linked, failure):
    db, ref, _ = linked
    bad = deepcopy(ref)
    if failure == "missing": bad["snapshotId"] = "DSS-" + "0" * 32
    elif failure == "version": bad["snapshotRevision"] = "device-status-" + "0" * 64
    elif failure == "resource": bad["resourceRevision"] = "resource-other"
    else: bad["deviceIds"].append("not-a-member")
    request = parse_import_file(portable(db)).to_request("rejected")
    with pytest.raises(service.ObservationError) as rejected:
        service._import_dataset(request, actor_id="actor", factory=db["factory"], status_ref=bad)
    assert rejected.value.status == (404 if failure in ("missing", "member") else 409)
    assert counts(db) == (0, 0, 0)
    with db["factory"]() as session:
        assert session.scalar(text("SELECT count(*) FROM observation_device_status_refs")) == 0


def test_real_p06_resolves_inside_observation_transaction_and_sql_immutable(linked, monkeypatch):
    db, ref, p06 = linked
    command = command_for(db, ref)
    original = p06.resolve_snapshot
    sessions = []
    def resolve(session, *args):
        assert session.in_transaction()
        sessions.append(session.get(ObservationDataset, "obs-A") is not None)
        return original(session, *args)
    monkeypatch.setattr(p06, "resolve_snapshot", resolve)
    service.import_file(command, actor_id="actor", factory=db["factory"])
    assert any(sessions)  # 至少一次在新观测行已flush的同Session复核，不只做事务外预检。
    for sql in ("UPDATE observation_device_status_refs SET actor_id='changed'", "DELETE FROM observation_device_status_refs"):
        with pytest.raises(IntegrityError):
            with db["engine"].begin() as connection:
                connection.execute(text(sql))


def test_real_p06_operation_failure_rolls_back_dataset_frames_and_ref(linked):
    db, ref, _ = linked
    command = command_for(db, ref)
    def fail_operation(mapper, connection, target):
        raise ValueError("injected operation failure")
    event.listen(ObservationImportOperation, "before_insert", fail_operation)
    try:
        with pytest.raises(ValueError, match="injected operation failure"):
            service.import_file(command, actor_id="actor", factory=db["factory"])
    finally:
        event.remove(ObservationImportOperation, "before_insert", fail_operation)
    assert counts(db) == (0, 0, 0)
    with db["factory"]() as session:
        assert session.scalar(text("SELECT count(*) FROM observation_device_status_refs")) == 0


def test_real_p06_existing_unbound_cannot_gain_ref_and_readonly_projection(linked):
    db, ref, _ = linked
    receipt = imported(db, actor="actor")
    command = command_for(db, ref)
    with pytest.raises(service.ObservationError) as conflict:
        service.import_file(command, actor_id="actor", factory=db["factory"])
    assert conflict.value.code == 1206
    assert counts(db) == (1, 3, 1)
    # 查询在独立mode=ro连接运行，不能借GET创建关联或修复历史。
    import sqlite3
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    engine = create_engine("sqlite://", creator=lambda: sqlite3.connect(db["path"].as_uri() + "?mode=ro", uri=True))
    try:
        with Session(engine) as session:
            assert service.device_status_ref(session, "obs-A", receipt.datasetRevision)["deviceStatusRef"] is None
            assert json.loads(service.export_dataset(session, "obs-A", receipt.datasetRevision, True))["schemaVersion"] == 1
    finally:
        engine.dispose()


def test_real_p06_ref_corruption_fails_instead_of_unbound(linked):
    db, ref, _ = linked
    from app.observation_status_ref_models import ObservationDeviceStatusRef
    receipt = imported(db)
    # 只向本轮全新测试库插入明确损坏的构造夹具，不更改已有行/触发器。
    with db["factory"].begin() as session:
        dataset = session.get(ObservationDataset, receipt.datasetId)
        session.add(ObservationDeviceStatusRef(dataset_id=dataset.dataset_id, dataset_revision=dataset.dataset_revision,
            snapshot_id=ref["snapshotId"], snapshot_revision=ref["snapshotRevision"], resource_revision=ref["resourceRevision"],
            device_ids=sorted(ref["deviceIds"]), schema_version=1, data_origin="SYNTHETIC_INTEGRATION",
            ref_hash="0" * 64, ref_revision="OSR-" + "0" * 64, metadata_hash="0" * 64,
            actor_id=dataset.actor_id, created_at=dataset.imported_at))
    with db["factory"]() as session:
        with pytest.raises(service.ObservationError) as corrupt:
            service.device_status_ref(session, receipt.datasetId, receipt.datasetRevision)
        assert (corrupt.value.status, corrupt.value.code) == (503, 5002)


def test_public_v2_http_roundtrip_keeps_v1_receipt_and_exports_explicit_ref(linked):
    db, ref, p06 = linked
    file = {**portable(db), "schemaVersion": 2, "deviceStatusRef": deepcopy(ref)}
    preview = post(db, "/import-preview", {"file": file})
    assert preview.status_code == 200, preview.text
    info = preview.json()["data"]
    assert info["schemaVersion"] == 2 and counts(db) == (0, 0, 0)
    command = {"file": file, "requestId": "public-v2", "previewHash": info["previewHash"], "datasetContentHash": info["datasetContentHash"]}
    response = post(db, "/imports", command)
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert result["schemaVersion"] == 2 and result["receipt"]["changed"]
    revision = result["receipt"]["datasetRevision"]
    legacy = get(db, "/imports/public-v2").json()["data"]
    assert legacy["schemaVersion"] == 1 and "deviceStatusRef" not in legacy
    assert legacy["receipt"] == result["receipt"]
    assert get(db, "/imports/public-v2", include_device_status_ref="true").json()["data"] == result
    projected = get(db, "/datasets/obs-A/device-status-ref", revision)
    assert projected.status_code == 200 and projected.json()["data"]["deviceStatusRef"] == result["deviceStatusRef"]
    exported = get(db, "/datasets/obs-A/export", revision, include_device_status_ref="true")
    assert exported.status_code == 200 and "attachment" in exported.headers["content-disposition"]
    assert exported.headers["cache-control"] == "no-store"
    roundtrip = exported.json()
    assert roundtrip["schemaVersion"] == 2 and refs.canonical(roundtrip["deviceStatusRef"]) == refs.canonical(ref)
    second = post(db, "/imports", {**command, "file": roundtrip, "requestId": "roundtrip-v2"})
    assert second.status_code == 200, second.text
    assert not second.json()["data"]["receipt"]["changed"] and counts(db) == (1, 3, 2)
    assert get(db, "/datasets/obs-A/export", revision).json()["schemaVersion"] == 1
    with db["factory"]() as session:
        _, records = p06.resolve_snapshot(session, ref["snapshotId"], ref["snapshotRevision"], ref["resourceRevision"], ref["deviceIds"])
        assert all(item["status"] is None and item["alert"] is None and item["observed_at"] is None and item["unknown_reasons"] for item in records)
