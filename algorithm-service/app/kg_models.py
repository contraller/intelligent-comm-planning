"""SR6 知识变更工作流和不可变发布快照。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import Float, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class KgWorkspace(Base):
    __tablename__ = "kg_workspaces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    current_version: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)


class KgVersion(Base):
    __tablename__ = "kg_versions"

    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    parent_version: Mapped[int | None] = mapped_column(Integer)
    restored_from: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    frontend_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class KgChange(Base):
    __tablename__ = "kg_changes"

    change_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    state: Mapped[str] = mapped_column(String(20), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    base_version: Mapped[int] = mapped_column(Integer, nullable=False)
    ops: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    submitter: Mapped[str] = mapped_column(String(100), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    updated_at: Mapped[float] = mapped_column(Float, nullable=False)
    frontend_content: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class KgSubmission(Base):
    __tablename__ = "kg_submissions"
    __table_args__ = (UniqueConstraint("change_id", "number", name="uq_kg_submission_number"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    change_id: Mapped[str] = mapped_column(String(40), ForeignKey("kg_changes.change_id"), nullable=False, index=True)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    ops: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    submitted_at: Mapped[float] = mapped_column(Float, nullable=False)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    reviewer: Mapped[str | None] = mapped_column(String(100))
    opinion: Mapped[str | None] = mapped_column(Text)
    frontend_content: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class KgReceipt(Base):
    __tablename__ = "kg_receipts"

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64), nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)


class KgAudit(Base):
    __tablename__ = "kg_audit"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    actor: Mapped[str] = mapped_column(String(100), nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    change_id: Mapped[str | None] = mapped_column(String(40))
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    identity_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
