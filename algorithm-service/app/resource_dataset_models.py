"""资源不可变版本及当前生效指针，不覆盖原始构造资料。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, JSON, String, event
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class ResourceDatasetVersion(Base):
    __tablename__ = "resource_dataset_versions"

    revision: Mapped[str] = mapped_column(String(120), primary_key=True)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    source: Mapped[str] = mapped_column(String(500), nullable=False)
    data_origin: Mapped[str] = mapped_column(String(40), nullable=False)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ResourceDatasetCurrent(Base):
    __tablename__ = "resource_dataset_current"

    scope: Mapped[str] = mapped_column(String(40), primary_key=True)
    revision: Mapped[str] = mapped_column(
        String(120), ForeignKey("resource_dataset_versions.revision"), nullable=False
    )


class ResourceDatasetOperation(Base):
    """资源保存的持久化幂等回执，同时记录实际操作者。"""
    __tablename__ = "resource_dataset_operations"

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    base_revision: Mapped[str] = mapped_column(
        String(120), ForeignKey("resource_dataset_versions.revision"), nullable=False)
    revision: Mapped[str] = mapped_column(
        String(120), ForeignKey("resource_dataset_versions.revision"), nullable=False)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


@event.listens_for(ResourceDatasetOperation, "before_update")
@event.listens_for(ResourceDatasetOperation, "before_delete")
@event.listens_for(ResourceDatasetVersion, "before_update")
@event.listens_for(ResourceDatasetVersion, "before_delete")
def _keep_version_immutable(mapper, connection, target):
    # 变更只能新增版本并切换指针，既有方案引用的历史不得覆写。
    raise ValueError("资源快照不可修改或删除")
