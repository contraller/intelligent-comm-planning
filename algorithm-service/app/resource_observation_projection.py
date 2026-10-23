"""资源读取与导出共用的只读观测投影；不以缺报回退台账状态。"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy.exc import ArgumentError, SQLAlchemyError

from .database import DatabaseConfigurationError, get_session_factory
from . import device_status_service as status
from .resource_dataset_service import ResourceDatasetError


def project_device_items(
    items: list[dict[str, Any]], resource_revision: str, snapshot_id: str, *, factory=None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """调用方先授权并取同版全量设备；投影后再统一筛选、分页或导出。"""
    try:
        with (factory if factory is not None else get_session_factory())() as session:
            snapshot, original = status._snapshot(session, snapshot_id)
            if snapshot.resource_revision != resource_revision:
                raise ResourceDatasetError("观测快照与资源版本不符", 1205, 409)
            # required IDs 只取批次全体，资源未覆盖设备不是损坏或缺失成员。
            header, records = status.resolve_snapshot(
                session, snapshot_id, snapshot.snapshot_revision, resource_revision,
                [record.device_id for record in original.records],
            )
            observed = {record["device_id"]: record for record in records}
            result = deepcopy(items)
            for item in result:
                record = observed.get(item["device_id"])
                for field in ("status", "alert", "observed_at"):
                    item[field] = record[field] if record is not None else None
            metadata = {field: header[field] for field in (
                "snapshot_id", "snapshot_revision", "resource_revision", "data_origin", "source_label",
            )}
            return result, metadata
    except status.DeviceStatusError as exc:
        raise ResourceDatasetError(str(exc), exc.code, exc.status) from exc
    except (DatabaseConfigurationError, ArgumentError) as exc:
        raise ResourceDatasetError("观测投影数据库配置缺失或无效", 5001, 503) from exc
    except SQLAlchemyError as exc:
        raise ResourceDatasetError("观测快照读取失败，未回退台账状态", 5002, 503) from exc
