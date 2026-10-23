"""显式恢复初始构造资源：只增加版本和回执，不改写或删除历史。"""
from copy import deepcopy

from sqlalchemy import select

from . import resource_dataset_service as datasets
from .resource_dataset_models import ResourceDatasetVersion


def _business(snapshot):
    return {key: value for key, value in snapshot.items() if key not in ("source_updated_at", "change")}


def restore(base_revision, request_id, actor_id):
    def apply(snapshot):
        with datasets.get_session_factory()() as session:
            first = session.scalars(select(ResourceDatasetVersion).order_by(
                ResourceDatasetVersion.created_at, ResourceDatasetVersion.revision).limit(1)).first()
            initial = datasets._decode(first)
        if "change" in initial:
            raise datasets.ResourceDatasetError("初始构造快照不可核验，未执行恢复", 5002, 503)
        baseline = {key: deepcopy(value) for key, value in initial.items()
            if key not in ("revision", "content_hash", "source", "data_origin")}
        changed = _business(snapshot) != _business(baseline)
        affected = set()
        for table, field in datasets.ID_FIELDS.items():
            old = {row[field]: row for row in snapshot["tables"][table]}
            new = {row[field]: row for row in baseline["tables"][table]}
            affected.update(identifier for identifier in old.keys() | new.keys() if old.get(identifier) != new.get(identifier))
        if snapshot.get("frontend_candidate_links", []) != baseline.get("frontend_candidate_links", []):
            affected.update(row["id"] for row in snapshot.get("frontend_candidate_links", []))
            affected.update(row["id"] for row in baseline.get("frontend_candidate_links", []))
        if changed:
            # 这里仅替换即将作为新行保存的内存副本，原不可变数据库行不变。
            snapshot.clear()
            snapshot.update(baseline)
        return changed, {"object_id": "resource-reset", "affected_ids": sorted(affected), "warnings": [],
            "restored_from_revision": initial["revision"]}

    receipt = datasets.commit_device_change(base_revision, request_id,
        datasets.content_hash({"operation": "resource-reset-v1", "base_revision": base_revision}), actor_id, apply)
    return {"objectId": receipt["object_id"], "changed": receipt["changed"], "revision": receipt["revision"],
        "readRevision": receipt["read_revision"], "affectedIds": receipt["affected_ids"], "warnings": receipt["warnings"],
        "restoredFromRevision": receipt["restored_from_revision"]}
