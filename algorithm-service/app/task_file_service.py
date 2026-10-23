"""任务原文件只读预检；确认应用仍是草稿，持久化沿用任务保存接口。"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
from typing import Annotated, Literal

from pydantic import Field, StrictStr

from . import frontend_integration, task_input_service
from .task_input_schemas import InputModel, PlanningInput, TaskValidationRequest


MAX_FILE_BYTES = 5 * 1024 * 1024


class TaskFile(InputModel):
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    bytes_base64: Annotated[StrictStr, Field(min_length=1, max_length=4 * ((MAX_FILE_BYTES + 2) // 3))]


class TaskFilePreviewRequest(TaskValidationRequest):
    files: Annotated[list[TaskFile], Field(min_length=1, max_length=2)]


class TaskFileTemplateRequest(InputModel):
    context: Literal["gis", "planning"]
    format: Literal["csv", "xlsx"]
    kind: Literal["task_scenarios", "task_links"] = "task_scenarios"
    input: dict[str, object]


def _files(request: TaskFilePreviewRequest) -> list[tuple[str, bytes]]:
    result = []
    for file in request.files:
        if any(char in file.name for char in ("/", "\\", "\x00")) or any(ord(char) < 32 for char in file.name):
            raise task_input_service.TaskInputError(1001, "任务文件名无效", 422)
        try:
            data = base64.b64decode(file.bytes_base64, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise task_input_service.TaskInputError(1001, "任务文件编码无效", 422) from exc
        if not data or len(data) > MAX_FILE_BYTES:
            raise task_input_service.TaskInputError(1001, "任务单文件应为1字节至5 MiB", 422)
        result.append((file.name, data))
    return result


def _row_issue(issue: dict, source_rows: dict, task_row: int) -> dict:
    # 任务ID可与需求ID相同；任务字段不能因此误定位到通联行。
    field = str(issue.get("field", "")).split(".", 1)[0]
    demand_row = None if not field or field in set(PlanningInput.model_fields) - {"demands"} else source_rows.get(issue.get("objectId"))
    return {**issue, "sheet": "task_links" if demand_row else "task_scenarios", "row": demand_row or task_row}


def _differences(before: dict, after: dict) -> list[dict]:
    # 缺省字段以null展示清空，不将其写回候选输入。
    return [{"field": key, "before": before.get(key), "after": after.get(key)}
            for key in sorted(set(before) | set(after)) if before.get(key) != after.get(key)]


def _clear_notes(before: dict, after: dict) -> list[str]:
    notes = []
    for key, label in (("deploymentConstraints", "部署条件"), ("frequencyConstraints", "频率过滤"), ("deploymentSolve", "部署求解")):
        if before.get(key) is not None and after.get(key) is None:
            notes.append(f"文件未设置{label}，确认应用后将清空原设置；尚未保存。")
    old = {row.get("id"): row for row in before.get("demands", [])}
    for row in after.get("demands", []):
        previous = old.get(row.get("id"), {})
        if any(previous.get(key) is not None and row.get(key) is None for key in ("routeStrategy", "needBackup")):
            notes.append(f"需求 {row['id']} 的路由条件有未设置项，确认应用后将清空对应原设置；尚未保存。")
    return notes


def preview_task_files(request: TaskFilePreviewRequest, *, factory=None) -> dict:
    from .task_file_parser import parse_task_files

    try:
        canonical = json.dumps(request.model_dump(mode="json"), ensure_ascii=False,
            sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError, RecursionError) as exc:
        raise task_input_service.TaskInputError(1001, "任务预检输入应为有限JSON值", 422) from exc
    current = frontend_integration.resource_revision()
    if current != request.resource_revision:
        raise task_input_service.TaskInputError(1205, "资源版本已变化，请刷新后重新预检", 409)
    files = _files(request)
    parsed = parse_task_files(files, request.input)
    candidate = parsed["input"]
    issues, notes = list(parsed["issues"]), list(parsed["notes"])
    saved = None
    if candidate is not None:
        checked = task_input_service.validate_task_input(TaskValidationRequest.model_validate({
            "context": request.context, "task_id": parsed["taskId"],
            "expected_revision": request.expected_revision if parsed["taskId"] == request.task_id else None,
            "resource_revision": request.resource_revision, "input": candidate,
        }), factory=factory)
        saved = checked["task"]
        issues.extend(_row_issue(issue, parsed["sourceRows"], parsed["taskRow"]) for issue in checked["issues"])
        before = saved["input"] if saved else request.input
        differences = _differences(before, candidate)
        notes.extend(_clear_notes(before, candidate))
        if saved:
            notes.append("同编号任务已存在；应用后须按该任务当前版本保存。")
    else:
        differences = parsed["differences"]
    if frontend_integration.resource_revision() != current:
        raise task_input_service.TaskInputError(1205, "资源在文件预检期间发生变化，请重试", 409)
    # 指纹绑定原文件及发起上下文；仅供草稿预检识别，不声称它是保存回执。
    signature = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return {"taskId": parsed["taskId"], "input": candidate if not issues else None,
            "issues": issues, "notes": list(dict.fromkeys(notes)), "differences": differences,
            "signature": signature, "existing": saved is not None,
            "taskRevision": saved["revision"] if saved else None, "resourceRevision": current,
            "requestContext": {"context": request.context, "taskId": request.task_id,
                "taskRevision": request.expected_revision, "resourceRevision": request.resource_revision}}


def task_file_template(request: TaskFileTemplateRequest) -> dict:
    from .task_file_parser import build_task_template

    # 模板来自当前输入而非Mock案例；结构不合法时明确拒绝，不补造资源引用。
    PlanningInput.model_validate(request.input)
    return build_task_template(request.format, request.kind, request.input)
