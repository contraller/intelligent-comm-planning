"""本地正式会话、匿名挑战和有界节流；不创建账户。"""
from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class LocalIdentitySession(Base):
    __tablename__ = "local_identity_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    generation: Mapped[str] = mapped_column(String(64), nullable=False)
    account_id: Mapped[str] = mapped_column(ForeignKey("local_accounts.id"), nullable=False, index=True)
    identity_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    csrf: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    last_seen: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False)


class LocalIdentityChallenge(Base):
    __tablename__ = "local_identity_challenges"
    client_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    csrf: Mapped[str] = mapped_column(String(128), nullable=False)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, nullable=False)


class LocalIdentityThrottle(Base):
    __tablename__ = "local_identity_throttle"
    key: Mapped[str] = mapped_column(String(130), primary_key=True)
    failures: Mapped[int] = mapped_column(Integer, nullable=False)
    window_start: Mapped[int] = mapped_column(Integer, nullable=False)
    blocked_until: Mapped[int] = mapped_column(Integer, nullable=False)


IDENTITY_TABLES = tuple(model.__table__ for model in (LocalIdentitySession, LocalIdentityChallenge, LocalIdentityThrottle))
