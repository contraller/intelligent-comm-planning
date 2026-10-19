"""SR4 规划作业提交接口的请求结构。"""
from __future__ import annotations

from typing import Any, Literal

from .task_input_schemas import Identifier, InputModel


class PlanningJobSubmitRequest(InputModel):
    context: Literal["planning"]
    request_id: Identifier
    task_id: Identifier
    expected_revision: Identifier
    input_version: Identifier
    condition_version: Identifier
    resource_revision: Identifier
    parent_plan_id: Identifier | None
    adjustment: dict[str, Any] | None = None
