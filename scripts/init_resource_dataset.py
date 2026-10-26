"""显式将现有构造资源初始化到已迁移的数据库，重复执行不覆盖。"""
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))


def main():
    if not os.environ.get("DATABASE_URL", "").strip():
        raise RuntimeError("请先配置已有数据库的 DATABASE_URL 并迁移到 0014")
    # 检查 SQLite 文件，防止地址拼错时创建空库。
    from sqlalchemy.engine import make_url
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() == "sqlite" and (
        not url.database or not Path(url.database).is_absolute() or not Path(url.database).is_file()
    ):
        raise RuntimeError("SQLite 初始化要求已存在数据库的绝对路径")
    from app.resource_dataset_service import initialize
    result = initialize()
    print(json.dumps({key: result[key] for key in (
        "changed", "revision", "content_hash", "data_origin", "source")}, ensure_ascii=False))
    print(json.dumps({name: len(rows) for name, rows in result["tables"].items()}))


if __name__ == "__main__":
    main()
