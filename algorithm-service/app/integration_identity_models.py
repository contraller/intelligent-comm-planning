"""仅显式联调模式使用的浏览器会话，不是正式账号库。"""
from __future__ import annotations

from sqlalchemy import Boolean, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class IntegrationSession(Base):
    __tablename__ = "integration_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    account_id: Mapped[str] = mapped_column(String(80), nullable=False)
    csrf: Mapped[str] = mapped_column(String(100), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    expires_at: Mapped[float] = mapped_column(Float, nullable=False)
