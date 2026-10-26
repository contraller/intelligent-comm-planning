"""P05 系统实体、回执及只追加审计；正式迁移由总集成分配。"""
from __future__ import annotations

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, JSON, String, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class LocalRole(Base):
    __tablename__ = "local_roles"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String(200), nullable=False)
    permissions: Mapped[list[str]] = mapped_column(JSON, nullable=False)


class LocalAccount(Base):
    __tablename__ = "local_accounts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(40), nullable=False)
    department: Mapped[str] = mapped_column(String(60), nullable=False)
    role_id: Mapped[str] = mapped_column(ForeignKey("local_roles.id"), nullable=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    identity_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    last_login: Mapped[int | None] = mapped_column(Integer)


class LocalCredential(Base):
    __tablename__ = "local_credentials"
    account_id: Mapped[str] = mapped_column(ForeignKey("local_accounts.id"), primary_key=True)
    password_hash: Mapped[str] = mapped_column(String(200), nullable=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    changed_at: Mapped[int] = mapped_column(Integer, nullable=False)


class SystemState(Base):
    __tablename__ = "system_state"
    __table_args__ = (CheckConstraint("id = 1", name="ck_system_state_singleton"), CheckConstraint("revision >= 1", name="ck_system_state_revision"))
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    initialized: Mapped[bool] = mapped_column(Boolean, nullable=False)
    epoch: Mapped[str] = mapped_column(String(64), nullable=False)


class SystemParameter(Base):
    __tablename__ = "system_parameters"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[object] = mapped_column(JSON, nullable=False)


class SystemOperation(Base):
    __tablename__ = "system_operations"
    __table_args__ = (UniqueConstraint("actor_id", "request_id", name="uq_system_operation_actor_request"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    request_id: Mapped[str] = mapped_column(String(120), nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    permission: Mapped[str] = mapped_column(String(120), nullable=False)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)


class SystemAuditEvent(Base):
    __tablename__ = "system_audit_events"
    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    time: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    actor: Mapped[dict | None] = mapped_column(JSON)
    module: Mapped[str] = mapped_column(String(40), nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    object_id: Mapped[str] = mapped_column(String(120), nullable=False)
    request_id: Mapped[str | None] = mapped_column(String(120))
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    error_code: Mapped[str] = mapped_column(String(40), nullable=False)
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    changes: Mapped[dict] = mapped_column(JSON, nullable=False)


class SystemAuditArchive(Base):
    __tablename__ = "system_audit_archives"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    through_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(String(200), nullable=False)
    time: Mapped[int] = mapped_column(Integer, nullable=False)


SYSTEM_TABLES = tuple(model.__table__ for model in (
    LocalRole, LocalAccount, LocalCredential, SystemState, SystemParameter,
    SystemOperation, SystemAuditEvent, SystemAuditArchive,
))


@event.listens_for(SystemOperation, "before_update")
@event.listens_for(SystemOperation, "before_delete")
@event.listens_for(SystemAuditEvent, "before_update")
@event.listens_for(SystemAuditEvent, "before_delete")
@event.listens_for(SystemAuditArchive, "before_update")
@event.listens_for(SystemAuditArchive, "before_delete")
def _immutable(mapper, connection, target):
    raise ValueError("系统回执、审计和归档记录只允许追加")
