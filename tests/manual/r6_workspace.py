"""R6独立库准备与真实流程复验；不连接既有运行环境。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).parent))
import r4_internal_http as shared

shared.ORIGIN = "http://127.0.0.24:5324"
shared.API = "http://127.0.0.24:8124"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "smoke", "plan", "knowledge"))
    parser.add_argument("--runtime-root")
    args = parser.parse_args()
    if args.action == "prepare":
        shared.prepare()
        return
    if not args.runtime_root:
        parser.error("必须显式指定R6隔离目录")
    from serve_internal_workspace import read_workspace
    runtime = Path(args.runtime_root)
    manifest = json.loads((runtime / "workspace.json").read_text(encoding="utf-8"))
    read_workspace(str(runtime), manifest["database_url"], manifest["key_file"])
    if (manifest["frontend"], manifest["api"]) != (shared.ORIGIN, shared.API):
        parser.error("不是R6固定验收端口，未发送请求")
    private = json.loads(Path(manifest["key_file"]).read_text(encoding="utf-8"))
    records, result, completed, error = [], None, False, None
    try:
        result = {"smoke": shared.smoke, "plan": shared.run_plan,
                  "knowledge": shared.knowledge}[args.action](runtime, private, records)
        completed = True
    except BaseException as exc:
        error = {"type": type(exc).__name__, "detail": str(exc)}
        raise
    finally:
        output = runtime / ("r6-" + args.action + "-http-" + uuid.uuid4().hex[:8] + ".json")
        shared.write_new(output, {"method": "REAL_HTTP_LOCAL_PASSWORD", "requests": records,
            "result": result, "error": error, "completed": completed,
            "all_requests_passed": completed and bool(records) and all(row["passed"] for row in records)})
        print(json.dumps({"evidence": str(output), "requests": len(records), "success": completed},
                         ensure_ascii=False))


if __name__ == "__main__":
    main()
