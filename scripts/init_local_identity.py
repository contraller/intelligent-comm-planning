"""显式初始化本树本地账号；不创建表、不打印口令、不接受默认管理员。"""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from app.system_management_schemas import SystemManagementError
from app.system_management_service import SystemManagementService


def main():
    parser = argparse.ArgumentParser(description="显式初始化已迁移的本地身份库")
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--registry-json", required=True)
    parser.add_argument("--request-key-env", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--department", required=True)
    args = parser.parse_args()
    url = make_url(args.database_url)
    if url.drivername != "sqlite" or not url.database or Path(url.database).resolve() != (ROOT / "data/runtime/r2.sqlite").resolve():
        parser.error("仅允许显式指定本工作树 data/runtime/r2.sqlite")
    if not sys.stdin.isatty():
        parser.error("必须在可掩码输入的交互终端初始化")
    engine = None
    try:
        key = os.environ.get(args.request_key_env, "").encode("utf-8")
        registry = json.loads(Path(args.registry_json).read_text(encoding="utf-8"))
        password = getpass.getpass("设置本地账号密码：")
        confirmation = getpass.getpass("再次输入密码：")
        if password != confirmation:
            parser.error("两次输入不一致，未创建账号")
        engine = create_engine(args.database_url)
        service = SystemManagementService(session_factory=sessionmaker(bind=engine, expire_on_commit=False), permission_registry=registry, request_key=key)
        account_id = service.initialize(username=args.username, password=password, name=args.name, department=args.department)
        print("本地账号已显式初始化，账号编号：" + account_id)
    except (SystemManagementError, SQLAlchemyError, ValueError, OSError):
        print("初始化未完成，请核对安全配置、权限目录和已迁移的隔离数据库；口令不会输出。", file=sys.stderr)
        return 1
    finally:
        password = confirmation = ""
        if engine is not None:
            engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
