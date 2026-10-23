"""频谱来源版本、CAS指针和操作回执；不占正式迁移编号。"""
from typing import Any

from sqlalchemy import CheckConstraint, DDL, ForeignKey, Index, JSON, String, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class SpectrumSourceBase(DeclarativeBase):
    pass


class SpectrumSourceVersion(SpectrumSourceBase):
    __tablename__ = "spectrum_source_versions"
    config_revision: Mapped[str] = mapped_column(String(120), primary_key=True)
    source_id: Mapped[str] = mapped_column(String(120), index=True)
    schema_version: Mapped[int]
    data_origin: Mapped[str] = mapped_column(String(40))
    content_hash: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON)
    actor_id: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[str] = mapped_column(String(40))
    __table_args__ = (
        CheckConstraint("schema_version=1", name="ck_spectrum_source_schema"),
        CheckConstraint("data_origin='SYNTHETIC_INTEGRATION'", name="ck_spectrum_source_origin"),
    )


class SpectrumSourceCurrent(SpectrumSourceBase):
    __tablename__ = "spectrum_source_current"
    source_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    config_revision: Mapped[str] = mapped_column(ForeignKey("spectrum_source_versions.config_revision", ondelete="RESTRICT"))


class SpectrumSourceOperation(SpectrumSourceBase):
    __tablename__ = "spectrum_source_operations"
    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    operation_type: Mapped[str] = mapped_column(String(30))
    request_digest: Mapped[str] = mapped_column(String(64))
    actor_id: Mapped[str] = mapped_column(String(120))
    source_id: Mapped[str] = mapped_column(String(120))
    config_revision: Mapped[str] = mapped_column(ForeignKey("spectrum_source_versions.config_revision", ondelete="RESTRICT"))
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40))
    __table_args__ = (
        CheckConstraint("operation_type IN ('SOURCE_SAVE','SOURCE_CHECK')", name="ck_spectrum_source_operation"),
        Index("ix_spectrum_source_operation_history", "source_id", "operation_type", "created_at", "request_id"),
    )


SPECTRUM_SOURCE_METADATA = SpectrumSourceBase.metadata


def sqlite_immutability_ddl() -> tuple[str, ...]:
    return tuple(
        f"CREATE TRIGGER {table}_immutable_{action.lower()} BEFORE {action} ON {table} "
        "BEGIN SELECT RAISE(ABORT, 'spectrum source history is immutable'); END"
        for table in ("spectrum_source_versions", "spectrum_source_operations")
        for action in ("UPDATE", "DELETE")
    )


def _immutable(mapper, connection, target):
    raise ValueError("频谱来源版本与回执不可修改或删除")


for _model in (SpectrumSourceVersion, SpectrumSourceOperation):
    event.listen(_model, "before_update", _immutable)
    event.listen(_model, "before_delete", _immutable)
    for _ddl in sqlite_immutability_ddl():
        if f" ON {_model.__tablename__} " in _ddl:
            event.listen(_model.__table__, "after_create", DDL(_ddl).execute_if(dialect="sqlite"))
