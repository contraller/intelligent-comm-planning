"""SQLAlchemy 数据库连接、会话和健康检查。"""
from __future__ import annotations

import os
import threading
from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class DatabaseConfigurationError(RuntimeError):
    """数据库环境变量缺失或格式无效。"""


class Base(DeclarativeBase):
    """后续业务模型共用的声明式基类。"""


_ENGINE: Engine | None = None
_SESSION_FACTORY: sessionmaker[Session] | None = None
_LOCK = threading.RLock()


def get_database_url() -> str:
    """读取数据库地址；仓库不提供包含凭据的默认值。"""
    value = os.environ.get("DATABASE_URL", "").strip()
    if not value:
        raise DatabaseConfigurationError("DATABASE_URL 未配置")
    return value


def create_database_engine(url: str) -> Engine:
    """创建可在服务和测试中复用的同步 Engine。"""
    if not isinstance(url, str) or not url.strip():
        raise DatabaseConfigurationError("数据库连接地址不能为空")
    return create_engine(url, pool_pre_ping=True)


def get_engine() -> Engine:
    """惰性创建全局 Engine，避免数据库未配置时阻止服务启动。"""
    global _ENGINE
    if _ENGINE is None:
        with _LOCK:
            if _ENGINE is None:
                _ENGINE = create_database_engine(get_database_url())
    return _ENGINE


def get_session_factory() -> sessionmaker[Session]:
    """惰性创建绑定当前 Engine 的 Session 工厂。"""
    global _SESSION_FACTORY
    if _SESSION_FACTORY is None:
        with _LOCK:
            if _SESSION_FACTORY is None:
                _SESSION_FACTORY = sessionmaker(
                    bind=get_engine(), autoflush=False, expire_on_commit=False
                )
    return _SESSION_FACTORY


def get_db() -> Generator[Session, None, None]:
    """为 FastAPI 请求提供独立 Session，并保证请求结束时关闭。"""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


def check_database_connection(engine: Engine | None = None) -> dict[str, str]:
    """执行最小查询验证连接，不读取或修改任何业务数据。"""
    target = engine or get_engine()
    with target.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"status": "ok", "dialect": target.dialect.name}


def reset_database_state_for_tests() -> None:
    """释放测试创建的全局连接状态，生产业务不得调用。"""
    global _ENGINE, _SESSION_FACTORY
    with _LOCK:
        if _ENGINE is not None:
            _ENGINE.dispose()
        _ENGINE = None
        _SESSION_FACTORY = None
