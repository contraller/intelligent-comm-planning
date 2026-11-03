"""只读便携实例的资源和当前方案，生成可由用户显式导入的构造例程。"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import sys

# 便携Python使用隔离路径配置，需要显式加入本工具所在目录。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_example_import_data import fault_files, network_data, resource_data, status_files, write_json


def read_materials(portable: Path, plan_id: str | None = None):
    database = portable / "app/data/runtime/r2.sqlite"
    if not database.is_file():
        raise ValueError("未找到已初始化的便携数据库，请先启动系统，再选择包含启动系统.cmd的目录。")
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        row = connection.execute(
            "SELECT v.revision,v.snapshot FROM resource_dataset_versions v "
            "JOIN resource_dataset_current c ON c.revision=v.revision WHERE c.scope='current'"
        ).fetchone()
        if row is None:
            # 兼容既有固定scope名称，不允许多指针时猜测。
            rows = connection.execute(
                "SELECT v.revision,v.snapshot FROM resource_dataset_versions v "
                "JOIN resource_dataset_current c ON c.revision=v.revision"
            ).fetchall()
            if len(rows) != 1:
                raise ValueError("当前资源指针缺失或不唯一，未生成例程。")
            row = rows[0]
        resource = {"revision": row["revision"], "snapshot": json.loads(row["snapshot"])}
        revision, tables = resource_data(resource)
        note = "当前没有同版已转正方案，只生成设备状态；先完成规划、保存和转正后可再次生成故障例程。"
        known_tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"planning_plans", "planning_current_plans"} <= known_tables:
            return revision, tables, None, note
        if plan_id:
            plan = connection.execute("SELECT * FROM planning_plans WHERE plan_id=?", (plan_id,)).fetchone()
            if plan is None or plan["resource_revision"] != revision or plan["state"] != "CONFIRMED":
                raise ValueError("指定方案不存在、未转正或与当前资源不同版，未生成错配故障数据。")
        else:
            plan = connection.execute(
                "SELECT p.* FROM planning_plans p JOIN planning_current_plans c ON c.plan_id=p.plan_id "
                "WHERE p.state='CONFIRMED' AND p.resource_revision=? "
                "ORDER BY c.updated_at DESC,p.confirmed_at DESC,p.plan_id DESC LIMIT 1", (revision,)
            ).fetchone()
        if plan is None:
            return revision, tables, None, note
        result = json.loads(plan["result_snapshot"])
        identity = {
            "plan_id": plan["plan_id"], "task_id": plan["task_id"],
            "snapshot_id": result["snapshot_id"], "input_version": plan["revision_id"],
            "condition_version": plan["condition_version"], "resource_revision": revision,
            "state": plan["state"], "source_changed": False,
            "data_origin": "SYNTHETIC_INTEGRATION", "source": plan["source"],
        }
        network = {
            "identity": identity, "nodes": [{"id": n["id"]} for n in result["nodes"]],
            "devices": [{"id": d["id"], "station_id": d["stationId"], "model_id": d["modelId"],
                         "device_class": d["deviceClass"]} for d in result["devices"]],
            "links": [{"id": e["id"], "device_a": e["deviceA"], "device_b": e["deviceB"],
                       "device_class": e["deviceClass"]} for e in result["links"]],
        }
        return revision, tables, network_data(network), "绑定当前同版已转正方案：" + plan["name"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--portable-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="生成文件的父目录，建议选择F盘")
    parser.add_argument("--plan-id", help="可选：指定同版已转正方案，否则选最近转正的当前方案")
    args = parser.parse_args()
    revision, tables, network, note = read_materials(args.portable_root.resolve(), args.plan_id)
    stamp = datetime.now(timezone.utc).replace(microsecond=0)
    output = args.output.resolve()
    protected = args.portable_root.resolve() / "app/data/runtime"
    if output == protected or output.is_relative_to(protected):
        raise ValueError("生成目录不能位于软件现用数据目录内，请选择独立F盘目录。")
    target = output / ("例程_" + stamp.strftime("%Y%m%d_%H%M%S") + "_" + revision[-8:])
    target.mkdir(parents=True, exist_ok=False)
    status = status_files(target / "02_设备状态", revision, tables["device.csv"], stamp - timedelta(minutes=5), network, "按本机当前资源重新生成")
    faults = fault_files(target, network, "EXAMPLE-" + stamp.strftime("%Y%m%d%H%M%S"),
                         {d["device_id"] for d in tables["device.csv"]})
    write_json(target / "适用说明.json", {"资源版本": revision, "状态设备数": status["每批全量设备数"],
               "方案说明": note, "故障例程数": faults["场景条数"], "来源": "人工构造演示，不是真实采集；未写入软件数据库。"})
    (target / "先读我.txt").write_text(
        "本目录为人工构造例程，非真实设备上报。生成过程只读数据库，没有自动导入。\n"
        f"适用资源版本：{revision}\n{note}\n"
        "进入资源管理或GIS工作台的设备状态面板，展开“显式导入构造状态”，选择第1批JSON并校验导入，再选择该批次。\n"
        "第2批用于演示状态变化，导入后可手动选择，或启用“跟随最新”。\n"
        "故障CSV必须绑定适用方案.json所列的方案；没有故障CSV时先完成同版规划、保存和转正，再重新生成。\n"
        "资源或方案变化后请再次生成，不要只改JSON的资源版本。\n", encoding="utf-8")
    print("生成完成：" + str(target))
    print(f"资源版本：{revision}；每批设备：{len(tables['device.csv'])}；故障场景：{faults['场景条数']}")
    print("数据库只读；文件尚未导入。")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        raise SystemExit("未生成成功：" + str(error))
