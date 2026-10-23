"""按不可变资源快照导出，不生成版本、回执或本地业务文件。"""
import csv
from io import BytesIO, StringIO
import json
import math
import re

from openpyxl import Workbook
from openpyxl.styles import Font

from . import frontend_integration as frontend, resource_dataset_service as datasets
from .resource_dataset_service import ResourceDatasetError
from .resource_read_filter import filter_device_items

HEADERS = {
    "nodes": "node_id,node_name,echelon,node_subtype,parent_node_id,node_role,mobility,lon,lat,elevation_m,region,device_class,relay_capable,status,is_key,remark".split(","),
    "devices": "device_id,node_id,model_id,antenna_id,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,status,install_time,availability".split(","),
    "interference_sources": "interference_id,name,lon,lat,elevation_m,antenna_height_m,center_freq_khz,bandwidth_khz,tx_power_dbm,antenna_gain_dbi,interference_type,pattern_type,azimuth_deg,duty_cycle,active".split(","),
}
TABLES = {"nodes": "node.csv", "devices": "device.csv", "interference_sources": "interference_source.csv"}
NUMERIC = set("lon,lat,elevation_m,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,center_freq_khz,bandwidth_khz,antenna_gain_dbi,duty_cycle".split(","))
BOOLEANS = {"relay_capable", "is_key", "active"}
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_FILE_BYTES = 20 * 1024 * 1024


def select_tables(query):
    if not datasets.database_mode():
        raise ResourceDatasetError("资源导出仅支持已初始化的数据库模式", 5003)
    snapshot = datasets.current()
    if snapshot["revision"] != query.revision:
        raise ResourceDatasetError("资源版本已变化，请刷新后重新导出", 1205, 409)
    tables = snapshot["tables"]
    selected = {kind: {row[HEADERS[kind][0]] for row in tables[TABLES[kind]]} for kind in query.kinds}
    if query.range != "all":
        ids = set(query.selected_ids or [])
        devices = tables["device.csv"]
        if query.range == "selected":
            if ids - {row["device_id"] for row in devices}:
                raise ResourceDatasetError("选中设备不存在，未生成部分导出", 1002, 404)
        else:
            try:
                items = [frontend._device_item(row, tables["node.csv"], tables["device_model.csv"], tables["antenna_model.csv"]) for row in devices]
                ids = {row["device_id"] for row in filter_device_items(items, query.filter)}
            except (ValueError, TypeError, KeyError, StopIteration) as exc:
                raise ResourceDatasetError("资源关联或筛选参数来源损坏") from exc
        selected = {kind: ids if kind == "devices" else set() for kind in query.kinds}
    added = 0
    if query.format == "xlsx" and "nodes" in selected:
        nodes = {row["node_id"]: row for row in tables["node.csv"]}
        wanted = selected["nodes"]

        def add(node_id):
            nonlocal added
            if node_id not in wanted:
                wanted.add(node_id)
                added += 1

        for device in tables["device.csv"]:
            if device["device_id"] in selected.get("devices", set()):
                add(device["node_id"])
        visited = set()

        def parents(node_id, trail):
            if node_id in trail:
                raise ResourceDatasetError("节点父级存在循环，无法安全补齐导出")
            if node_id in visited:
                return
            for parent in filter(None, nodes[node_id].get("parent_node_id", "").split(";")):
                add(parent)
                parents(parent, trail | {node_id})
            visited.add(node_id)

        for node_id in sorted(wanted):
            parents(node_id, set())
    result = {kind: sorted((row for row in tables[TABLES[kind]] if row[HEADERS[kind][0]] in ids), key=lambda row: row[HEADERS[kind][0]])
              for kind, ids in selected.items()}
    return snapshot, result, added


def preview(query):
    snapshot, tables, added = select_tables(query)
    return {"revision": snapshot["revision"], "data_origin": snapshot["data_origin"], "source": snapshot["source"],
            "tables": [{"kind": kind, "count": len(rows)} for kind, rows in tables.items()], "added": added}


def _value(row, header):
    value = row.get(header, "ACTIVE" if header == "availability" else "")
    if value == "":
        return None
    if header in NUMERIC:
        try:
            number = float(value)
            if not math.isfinite(number):
                raise ValueError("nonfinite")
            return number
        except (ValueError, TypeError) as exc:
            raise ResourceDatasetError("资源数值损坏：" + header) from exc
    if header in BOOLEANS:
        if value not in ("true", "false"):
            raise ResourceDatasetError("资源布尔值损坏：" + header)
        return value == "true"
    return value


def _csv_value(value):
    if isinstance(value, str) and (re.match(r"^\s*[=+\-@]", value) or value.startswith("~rp~")):
        return "~rp~" + json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, bool):
        return str(value).lower()
    return value


def export_file(query):
    snapshot, tables, added = select_tables(query)
    if query.format == "csv":
        kind = query.kinds[0]
        output = StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(HEADERS[kind])
        for row in tables[kind]:
            writer.writerow([_csv_value(_value(row, key)) for key in HEADERS[kind]])
        data = output.getvalue().encode("utf-8")
        mime = "text/csv; charset=utf-8"
    else:
        book = Workbook()
        book.active.title = query.kinds[0]
        for i, (kind, rows) in enumerate(tables.items()):
            sheet = book.active if i == 0 else book.create_sheet(kind)
            sheet.append(HEADERS[kind])
            for row in rows:
                sheet.append([_value(row, key) for key in HEADERS[kind]])
                # 文本显式设置为字符串，避免以 = 开头的来源内容被当作公式执行。
                for cell in sheet[sheet.max_row]:
                    if isinstance(cell.value, str):
                        cell.data_type = "s"
            sheet.freeze_panes = "A2"
            for cell in sheet[1]:
                cell.font = Font(bold=True)
        notes = book.create_sheet("说明")
        for row in [("资源版本", snapshot["revision"]), ("数据来源", snapshot["data_origin"]),
                    ("来源说明", snapshot["source"]), ("内容哈希", snapshot["content_hash"]),
                    ("导出范围", query.range), ("补齐关联节点", added),
                    ("CSV 文本转义", "公式前缀文本采用 ~rp~ 加 JSON 字符串；原始数据未修改"),
                    ("数据性质", "构造联调资源，非生产、非实测；不包含未保存输入")]:
            notes.append(row)
            for cell in notes[notes.max_row]:
                if isinstance(cell.value, str):
                    cell.data_type = "s"
        output = BytesIO()
        book.save(output)
        book.close()
        data, mime = output.getvalue(), XLSX_MIME
    if not data or len(data) > MAX_FILE_BYTES:
        raise ResourceDatasetError("导出文件为空或超过 20 MiB，未生成截断文件", 1001, 413)
    return data, mime, "synthetic-resources-" + snapshot["revision"] + "." + query.format
