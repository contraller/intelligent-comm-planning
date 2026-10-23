"""只提供最新版前端及同源 API；显式使用已有数据库，不自动迁移或重建。"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = ROOT / "front_design" / "radio-planning-20261022" / "dist"


def create_delivery_app():
    if not (FRONTEND_DIST / "index.html").is_file():
        raise RuntimeError("请先在最新版前端目录执行 npm run build -- --mode integration")
    if not os.environ.get("DATABASE_URL", "").strip():
        raise RuntimeError("请显式配置 DATABASE_URL；启动入口不会创建或替换任务数据库")
    # SQLite 指向不存在的文件时提前失败，避免误以为空库任务丢失。
    from sqlalchemy.engine import make_url
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() == "sqlite":
        database = url.database
        if not database or database == ":memory:" or not Path(database).is_absolute() or not Path(database).is_file():
            raise RuntimeError("交付入口要求 SQLite 使用已存在数据库的绝对路径，请先单独执行迁移")
    sys.path.insert(0, str(ROOT / "algorithm-service"))
    from fastapi.staticfiles import StaticFiles
    from app.main import app
    from app import resource_dataset_service
    # 交付入口只使用已初始化的数据库资源，旧文件模式不作为页面降级路径。
    os.environ["RESOURCE_DATASET_MODE"] = "database"
    resource_dataset_service.current()
    # API 路由在前、静态页面在后；不挂载旧前端或仓库根目录。
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="delivery")
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=5183, type=int)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(create_delivery_app(), host=args.host, port=args.port, access_log=False)


if __name__ == "__main__":
    main()
