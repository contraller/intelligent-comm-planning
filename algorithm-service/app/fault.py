"""SR-5 service: scenarios, asynchronous diagnosis, impact and reports."""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .planning_w3 import _spawn, get_task_record, CODE_OK, CODE_TASK_NOT_FOUND

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from diagnosis.sr5 import FaultEngine, FaultInputError  # noqa: E402

_ENGINE: FaultEngine | None = None
_SCENARIOS: dict[str, dict[str, Any]] | None = None
_SLOCK = threading.RLock()
STORE_PATH = Path(os.environ.get("SR5_STORE_PATH", ROOT / "data" / "runtime" / "fault_scenarios.json"))
REPORT_DIR = Path(os.environ.get("SR5_REPORT_DIR", ROOT / "data" / "runtime" / "reports"))


def _engine() -> FaultEngine:
    global _ENGINE
    if _ENGINE is None:
        with _SLOCK:
            if _ENGINE is None:
                _ENGINE = FaultEngine()
    return _ENGINE


def _scenarios() -> dict[str, dict[str, Any]]:
    global _SCENARIOS
    if _SCENARIOS is None:
        with _SLOCK:
            if _SCENARIOS is None:
                if STORE_PATH.exists():
                    with STORE_PATH.open(encoding="utf-8") as handle:
                        seeds = {s["scenario_id"]: s for s in json.load(handle)}
                else:
                    seeds = {s["scenario_id"]: s for s in _engine().default_scenarios}
                _SCENARIOS = seeds
    return _SCENARIOS


def _save_scenarios() -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(list(_scenarios().values()), ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STORE_PATH)


def _ok(data):
    return {"code": CODE_OK, "message": "success", "data": data}


def _bad(exc: FaultInputError):
    return {"code": exc.code, "message": str(exc), "data": exc.detail}


def validate_scenario(payload):
    try:
        return _ok(_engine().validate(payload or {}))
    except FaultInputError as exc:
        return _bad(exc)


def list_scenarios():
    with _SLOCK:
        rows = sorted(_scenarios().values(), key=lambda s: s["scenario_id"])
        return _ok({"total": len(rows), "items": rows})


def get_scenario(sid):
    with _SLOCK:
        row = _scenarios().get(sid)
        return _ok(row) if row else {"code": 1002, "message": "故障场景不存在", "data": None}


def create_scenario(payload):
    try:
        _engine().validate(payload or {})
    except FaultInputError as exc:
        return _bad(exc)
    with _SLOCK:
        sid = "FS-" + uuid.uuid4().hex[:10].upper()
        row = dict(payload, scenario_id=sid, create_time=datetime.now(timezone.utc).isoformat())
        _scenarios()[sid] = row
        _save_scenarios()
        return _ok(row)


def update_scenario(sid, payload):
    with _SLOCK:
        if sid not in _scenarios():
            return {"code": 1002, "message": "故障场景不存在", "data": None}
        try:
            _engine().validate(payload or {})
        except FaultInputError as exc:
            return _bad(exc)
        row = dict(payload, scenario_id=sid, create_time=_scenarios()[sid].get("create_time"),
                   update_time=datetime.now(timezone.utc).isoformat())
        _scenarios()[sid] = row
        _save_scenarios()
        return _ok(row)


def delete_scenario(sid):
    with _SLOCK:
        if sid not in _scenarios():
            return {"code": 1002, "message": "故障场景不存在", "data": None}
        del _scenarios()[sid]
        _save_scenarios()
        return _ok({"scenario_id": sid, "deleted": True})


def import_scenarios(payload):
    """Accept a JSON array or CSV text; reject the entire batch on any bad row."""
    if isinstance(payload, dict) and payload.get("format") == "CSV":
        try:
            rows = list(csv.DictReader(io.StringIO(payload["content"])))
            scenarios = [dict(scenario_name=r["scenario_name"], faults=json.loads(r["faults"]))
                         for r in rows]
        except (KeyError, ValueError, TypeError) as exc:
            return _bad(FaultInputError("CSV 格式错误：%s" % exc))
    else:
        scenarios = payload.get("scenarios") if isinstance(payload, dict) else payload
    if not isinstance(scenarios, list) or not scenarios:
        return _bad(FaultInputError("scenarios 必须是非空列表"))
    try:
        for scenario in scenarios:
            _engine().validate(scenario)
    except FaultInputError as exc:
        return _bad(exc)
    with _SLOCK:
        added = []
        for scenario in scenarios:
            sid = "FS-" + uuid.uuid4().hex[:10].upper()
            row = dict(scenario, scenario_id=sid,
                       create_time=datetime.now(timezone.utc).isoformat())
            _scenarios()[sid] = row
            added.append(sid)
        _save_scenarios()
    return _ok({"imported": len(added), "scenario_ids": added})


def import_scenarios_file(filename, contents):
    """CSV/XLSX rows contain scenario_name and JSON-encoded faults columns."""
    suffix = Path(filename or "").suffix.lower()
    try:
        if suffix == ".csv":
            rows = list(csv.DictReader(io.StringIO(contents.decode("utf-8-sig"))))
        elif suffix == ".xlsx":
            from openpyxl import load_workbook
            book = load_workbook(io.BytesIO(contents), read_only=True, data_only=True)
            values = book.active.iter_rows(values_only=True)
            header = next(values)
            rows = [dict(zip(header, row)) for row in values]
            book.close()
        else:
            return _bad(FaultInputError("仅支持 CSV/XLSX 场景文件"))
        scenarios = [{"scenario_name": row["scenario_name"],
                      "faults": json.loads(row["faults"])} for row in rows]
    except (KeyError, ValueError, TypeError, UnicodeError, StopIteration) as exc:
        return _bad(FaultInputError("导入文件格式错误：%s" % exc))
    return import_scenarios({"scenarios": scenarios})


def _diagnosis(tid):
    task = get_task_record(tid)
    if task.get("kind") != "FAULT_DIAGNOSE" or task.get("status") != "SUCCESS":
        return None
    return task["result"]


def _impact(tid):
    task = get_task_record(tid)
    if task.get("kind") != "FAULT_IMPACT" or task.get("status") != "SUCCESS":
        return None
    return task["result"]


def submit_diagnosis(payload):
    payload = payload or {}
    sid = payload.get("scenario_id")
    with _SLOCK:
        scenario = _scenarios().get(sid)
    if scenario is None:
        return {"code": 1002, "message": "故障场景不存在", "data": None}
    try:
        _diagnose_live(scenario, payload)
    except FaultInputError as exc:
        return _bad(exc)
    if payload.get("network_solution_id") and _solution(payload["network_solution_id"]) is None:
        return {"code": 1002, "message": "规划方案不存在", "data": None}

    def work(_payload, tick):
        tick(0.4, "规则与图谱推理")
        out = _diagnose_live(scenario, payload)
        out["network_solution_id"] = payload.get("network_solution_id") or "SYNTHETIC_BASELINE"
        return out
    return _spawn("FAULT_DIAGNOSE", payload, work)


def _diagnose_live(scenario, payload, require_fault_type=True):
    from . import kg
    with kg._LOCK:
        graph, _ = kg._load()
        return _engine().diagnose(scenario, payload.get("fusion_weights"),
                                  payload.get("confidence_threshold", 0.6), graph=graph,
                                  require_fault_type=require_fault_type)


def submit_observation_diagnosis(payload):
    payload = payload or {}
    scenario = {"scenario_name": payload.get("scenario_name") or "观测诊断",
                "faults": payload.get("faults"), "scenario_id": None}
    try:
        _diagnose_live(scenario, payload, require_fault_type=False)
    except FaultInputError as exc:
        return _bad(exc)

    def work(_payload, tick):
        tick(0.4, "根据观测现象推理")
        return _diagnose_live(scenario, payload, require_fault_type=False)

    return _spawn("FAULT_DIAGNOSE_OBSERVATION", payload, work)


def _solution(sid):
    from .planning_w4 import get_plan
    result = get_plan(sid)
    return result["data"] if result["code"] == CODE_OK else None


def submit_impact(payload):
    payload = payload or {}
    diagnosis = _diagnosis(payload.get("diagnose_task_id"))
    if diagnosis is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "诊断任务不存在或尚未完成", "data": None}
    sid = payload.get("network_solution_id") or diagnosis.get("network_solution_id")
    solution = None if sid == "SYNTHETIC_BASELINE" else _solution(sid)
    if sid != "SYNTHETIC_BASELINE" and solution is None:
        return {"code": 1002, "message": "规划方案不存在", "data": None}
    if solution and solution.get("kind") != "SR4_FLOW":
        return _bad(FaultInputError("影响分析需要 SR4_FLOW 方案"))
    scenario = _scenarios().get(diagnosis["scenario_id"])
    if scenario is None:
        return {"code": 1002, "message": "诊断场景已删除", "data": None}
    if solution:
        plan_links = {r["link_id"] for r in solution["detail"]["links"]}
        unknown = [f["object_id"] for f in scenario["faults"]
                   if f["object_type"] == "LINK" and f["object_id"] not in plan_links]
        if unknown:
            return {"code": 1002, "message": "故障链路不在所选规划方案中：%s" % unknown, "data": None}

    def work(_payload, tick):
        tick(0.4, "沿主备路由计算影响")
        return _engine().impact(scenario, diagnosis, solution,
                                payload.get("consider_backup_route", True))
    return _spawn("FAULT_IMPACT", payload, work)


def get_impact_nodes(task_id, node_role=None, region=None):
    impact = _impact(task_id)
    if impact is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "影响任务不存在或尚未完成", "data": None}
    rows = [row for row in impact["affected_nodes"]
            if (node_role is None or row.get("node_role") == node_role)
            and (region is None or row.get("region") == region)]
    return _ok({"total": len(rows), "items": rows,
                "filters": {"node_role": node_role, "region": region}})


def get_suggestions(diagnose_task_id, impact_task_id=None):
    diagnosis = _diagnosis(diagnose_task_id)
    if diagnosis is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "诊断任务不存在或尚未完成", "data": None}
    impact = _impact(impact_task_id) if impact_task_id else None
    if impact_task_id and impact is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "影响分析任务不存在或尚未完成", "data": None}
    if impact and impact["scenario_id"] != diagnosis["scenario_id"]:
        return _bad(FaultInputError("诊断结果与影响分析结果不属于同一场景"))
    return _ok(_engine().suggestions(diagnosis, impact))


def _report_content(diagnosis, impact, suggestions):
    return {"scenario_id": diagnosis["scenario_id"], "data_source": "CONSTRUCTED",
            "scenario": _scenarios().get(diagnosis["scenario_id"]),
            "diagnosis": diagnosis, "impact": impact, "suggestions": suggestions,
            "generated_at": datetime.now(timezone.utc).isoformat()}


def _report_docx(content, path):
    from docx import Document
    doc = Document()
    doc.add_heading("故障诊断报告", 0)
    doc.add_paragraph("数据性质：CONSTRUCTED 合成测试数据；结果不能作为真实设备诊断准确率证明。")
    doc.add_paragraph("场景：" + content["scenario_id"])
    if content["scenario"]:
        doc.add_paragraph("场景名称：" + content["scenario"]["scenario_name"])
        for fault in content["scenario"]["faults"]:
            doc.add_paragraph("故障输入：%s %s；现象：%s；发生时间：%s" %
                              (fault["object_type"], fault["object_id"],
                               ", ".join(fault.get("symptom_ids") or []), fault.get("occur_time", "未知")))
    for item in content["diagnosis"]["results"]:
        doc.add_heading(item["fault_object"]["object_id"], level=1)
        fused = item["fused"]
        doc.add_paragraph("类型：%s；根因：%s；融合得分：%.3f；人工研判：%s" %
                          (fused["fault_type"], fused["root_cause"], fused["confidence"],
                           "是" if fused["need_manual_review"] else "否"))
        for branch in item["branches"]:
            doc.add_paragraph("%s：%s；依据：%s" %
                              (branch["source"], branch["confidence"], branch["evidence"]))
    if content["impact"]:
        doc.add_heading("影响范围", level=1)
        doc.add_paragraph(json.dumps(content["impact"]["summary"], ensure_ascii=False))
    doc.add_heading("处置建议", level=1)
    for row in content["suggestions"]["suggestions"]:
        doc.add_paragraph("%s. %s（来源：%s）" % (row["priority"], row["action"], row["source"]))
    doc.save(path)


def _report_pdf(content, path):
    from html import escape
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    style = ParagraphStyle("Chinese", fontName="STSong-Light", fontSize=10, leading=17)
    heading = ParagraphStyle("Heading", parent=style, fontSize=16, leading=24)
    story = [Paragraph("故障诊断报告", heading), Spacer(1, 12),
             Paragraph("数据性质：CONSTRUCTED 合成测试数据，结果须人工研判。", style),
             Paragraph("场景：%s" % escape(content["scenario_id"]), style)]
    if content["scenario"]:
        story.append(Paragraph("场景名称：%s" % escape(content["scenario"]["scenario_name"]), style))
        for fault in content["scenario"]["faults"]:
            story.append(Paragraph("故障输入：%s %s；现象：%s；发生时间：%s" %
                                   (escape(fault["object_type"]), escape(fault["object_id"]),
                                    escape(", ".join(fault.get("symptom_ids") or [])),
                                    escape(str(fault.get("occur_time", "未知")))), style))
    for item in content["diagnosis"]["results"]:
        fused = item["fused"]
        story.append(Spacer(1, 8))
        story.append(Paragraph("对象：%s" % escape(item["fault_object"]["object_id"]), style))
        story.append(Paragraph("类型：%s；根因：%s；融合得分：%.3f" %
                               (escape(str(fused["fault_type"])),
                                escape(str(fused["root_cause"])), fused["confidence"]), style))
        for branch in item["branches"]:
            story.append(Paragraph("%s：%s；依据：%s" %
                                   (branch["source"], branch["confidence"],
                                    escape(str(branch["evidence"]))), style))
    if content["impact"]:
        story.append(Paragraph("影响统计：%s" % escape(str(content["impact"]["summary"])), style))
    for row in content["suggestions"]["suggestions"]:
        story.append(Paragraph("建议 %s：%s" %
                               (row["priority"], escape(str(row["action"]))), style))
    SimpleDocTemplate(str(path), pagesize=A4).build(story)


def create_report(payload):
    payload = payload or {}
    diagnosis = _diagnosis(payload.get("diagnose_task_id"))
    if diagnosis is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "诊断任务不存在或尚未完成", "data": None}
    impact = _impact(payload.get("impact_task_id")) if payload.get("impact_task_id") else None
    if payload.get("impact_task_id") and impact is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "影响分析任务不存在或尚未完成", "data": None}
    if impact and impact["scenario_id"] != diagnosis["scenario_id"]:
        return _bad(FaultInputError("诊断结果与影响分析结果不属于同一场景"))
    fmt = (payload.get("format") or "json").lower()
    if fmt not in {"json", "docx", "pdf"}:
        return _bad(FaultInputError("报告格式仅支持 json / docx / pdf"))
    content = _report_content(diagnosis, impact, _engine().suggestions(diagnosis, impact))
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    filename = "report_%s_%s.%s" % (diagnosis["scenario_id"], uuid.uuid4().hex[:8], fmt)
    path = REPORT_DIR / filename
    if fmt == "json":
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    elif fmt == "docx":
        _report_docx(content, path)
    else:
        _report_pdf(content, path)
    return _ok({"report_url": "/api/v1/files/%s" % filename, "format": fmt,
                "data_source": "CONSTRUCTED"})


def report_path(filename):
    if Path(filename).name != filename or not filename.startswith("report_"):
        return None
    path = REPORT_DIR / filename
    return path if path.is_file() else None


def export_impact(tid, fmt):
    impact = _impact(tid)
    if impact is None:
        return None
    if fmt == "xlsx":
        from openpyxl import Workbook
        buf = io.BytesIO()
        book = Workbook()
        sheet = book.active
        sheet.title = "受影响节点"
        sheet.append(["节点", "影响类型", "程度", "状态", "原因"])
        for row in impact["affected_nodes"]:
            sheet.append([row["node_id"], row["affect_type"], row["level"], row["state"], row["reason"]])
        sheet = book.create_sheet("受影响链路")
        sheet.append(["链路", "状态", "程度", "原因"])
        for row in impact["affected_links"]:
            sheet.append([row["link_id"], row["state"], row["level"], row["reason"]])
        book.save(buf)
        return buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if fmt == "png":
        from PIL import Image, ImageDraw
        image = Image.new("RGB", (900, 640), "white")
        draw = ImageDraw.Draw(image)
        features = impact["impact_scope"]["features"]
        coords = [f["geometry"]["coordinates"] for f in features]
        if coords:
            xs, ys = [p[0] for p in coords], [p[1] for p in coords]
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            for feature in features:
                x, y = feature["geometry"]["coordinates"]
                px = 50 + (x - x0) / max(x1 - x0, 0.01) * 800
                py = 590 - (y - y0) / max(y1 - y0, 0.01) * 540
                color = "#c83832" if feature["properties"]["state"] == "INTERRUPTED" else "#e6aa39"
                draw.ellipse((px - 5, py - 5, px + 5, py + 5), fill=color)
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue(), "image/png"
    return None
