"""最新版源码内部联调入口；只读取显式新库，不自动迁移、开户或复制资产。"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "front_design/radio-planning-20261022"
HOST = "127.0.0.22"
API_PORT = 8122
FRONTEND_PORT = 5322
PROFILE = "r4"


def select_profile(profile):
    """固定隔离端口组，不接受任意外网地址或复用原5183。"""
    global HOST, API_PORT, FRONTEND_PORT, PROFILE
    if profile not in ("r4", "coverage", "acceptance"):
        raise ValueError("未知内部运行配置")
    PROFILE = profile
    HOST, API_PORT, FRONTEND_PORT = {
        "r4": ("127.0.0.22", 8122, 5322),
        "coverage": ("127.0.0.23", 8123, 5323),
        "acceptance": ("127.0.0.24", 8124, 5324),
    }[profile]


@dataclass(frozen=True)
class Workspace:
    runtime: Path
    database_url: str
    identity_key: str = field(repr=False)


def read_workspace(runtime_root: str, database_url: str, key_file: str) -> Workspace:
    """验证隔离边界后再设置环境；不得误连原库或自动创建空库。"""
    from sqlalchemy.engine import make_url

    try:
        runtime, secret = Path(runtime_root), Path(key_file)
        base = ROOT / "data/runtime/r2"
        if (not runtime.is_absolute() or runtime.resolve() != runtime
                or runtime.parent != base or not runtime.name.startswith("r4-")
                or not runtime.is_dir()):
            raise ValueError()
        url = make_url(database_url)
        database = Path(url.database or "")
        expected = ROOT / "data/runtime/tmp" / runtime.name
        if (url.drivername != "sqlite" or url.query or not database.is_absolute()
                or database.resolve() != database or database.parent != expected
                or not database.is_file()):
            raise ValueError()
        if (not secret.is_absolute() or secret.resolve() != secret
                or secret.parent != runtime or not secret.is_file()
                or secret.stat().st_size > 16384):
            raise ValueError()
        value = json.loads(secret.read_text(encoding="utf-8"))
        key = value["identity_request_key"]
        decoded = base64.b64decode(key, validate=True)
        if len(decoded) < 32 or base64.b64encode(decoded).decode("ascii") != key:
            raise ValueError()
    except (OSError, ValueError, TypeError, KeyError):
        raise ValueError("内部入口配置无效：仅接受本轮r4隔离目录、配套已存在库和显式密钥") from None
    return Workspace(runtime, database_url, key)


def workspace_environment(config: Workspace) -> dict[str, str]:
    """配置固定回环同源、本地身份及独立算法/覆盖目录。"""
    runtime = config.runtime
    return {
        "DATABASE_URL": config.database_url,
        "RESOURCE_DATASET_MODE": "database",
        "AUTH_MODE": "LOCAL_PASSWORD",
        "FRONTEND_INTEGRATION_DEMO": "0",
        "SR4_INTEGRATION_DEMO": "0",
        "LOCAL_IDENTITY_REQUEST_KEY": config.identity_key,
        "LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK": "1",
        "LOCAL_IDENTITY_ALLOWED_ORIGINS": json.dumps([
            f"http://{HOST}:{FRONTEND_PORT}", f"http://{HOST}:{API_PORT}"]),
        "INTERFERENCE_WORKBENCH_ENABLED": "1",
        "INTERFERENCE_RUNTIME_DIR": str(runtime),
        "FROZEN_COVERAGE_ENABLED": "1",
        "FROZEN_COVERAGE_RUNTIME_DIR": str(runtime / "coverage"),
        "COVERAGE_CACHE_DIR": str(runtime / "legacy-coverage-cache"),
        "COVERAGE_TASK_DIR": str(runtime / "legacy-coverage-tasks"),
        "ALGORITHM_TASK_DIR": str(runtime / "tasks"),
        "SR4_PLAN_DIR": str(runtime / "plans"),
        "SR4_SNAPSHOT_DIR": str(runtime / "snapshots"),
        "SR5_STORE_PATH": str(runtime / "fault_scenarios.json"),
        "SR5_REPORT_DIR": str(runtime / "reports"),
        "SR6_STORE_PATH": str(runtime / "knowledge.json"),
        "VITE_DATA_MODE": "http", "VITE_SAMPLE_DATA": "true",
        "VITE_BACKEND_PROXY_TARGET": f"http://{HOST}:{API_PORT}",
        "R4_RUNTIME_ROOT": str(runtime),
        "INTERNAL_WORKSPACE_PROFILE": PROFILE,
        "PYTHONDONTWRITEBYTECODE": "1",
        "TEMP": str(runtime / "tmp"), "TMP": str(runtime / "tmp"),
    }


def create_workspace_app(config: Workspace | None = None):
    """API生命周期保持原装配，仅额外挂载新版只读地图和字体。"""
    # 拒绝绕过CLI校验直接作为uvicorn工厂加载，避免沿用终端中的原库配置。
    if not isinstance(config, Workspace) or any(
            os.environ.get(key) != value for key, value in workspace_environment(config).items()):
        raise RuntimeError("内部API必须通过显式隔离配置启动，未连接数据库")
    from fastapi.staticfiles import StaticFiles

    sys.path.insert(0, str(ROOT / "algorithm-service"))
    from app.main import app
    from app import resource_dataset_service

    resource_dataset_service.current()
    for name in ("maps", "fonts"):
        directory = FRONTEND / "public" / name
        if not directory.is_dir() or directory.resolve() != directory:
            raise RuntimeError("新版静态资源目录无效")
        app.mount("/" + name, StaticFiles(directory=str(directory), follow_symlink=False),
                  name="internal-" + name)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("api", "frontend"))
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--profile", choices=("r4", "coverage", "acceptance"), default="r4")
    args = parser.parse_args()
    select_profile(args.profile)
    try:
        config = read_workspace(args.runtime_root, args.database_url, args.key_file)
    except ValueError as error:
        parser.error(str(error))
    os.environ.update(workspace_environment(config))
    (config.runtime / "tmp").mkdir(exist_ok=True)
    if args.mode == "frontend":
        node = shutil.which("node")
        if node is None:
            parser.error("未找到现有Node运行时；入口不会自动安装依赖")
        return subprocess.call([node, str(ROOT / "scripts/internal_workspace_frontend.mjs")],
                               cwd=str(FRONTEND), env=os.environ.copy())
    import uvicorn

    uvicorn.run(create_workspace_app(config), host=HOST, port=API_PORT, access_log=False,
                proxy_headers=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
