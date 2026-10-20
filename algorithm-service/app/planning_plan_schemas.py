"""版本化规划方案保存接口的请求结构。"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, StrictStr, field_validator, model_validator

from .task_input_schemas import Identifier, InputModel


class PlanningPlanSaveRequest(InputModel):
    context: Literal["planning"]
    request_id: Identifier
    task_id: Identifier
    expected_revision: Identifier
    job_id: Identifier
    name: Annotated[StrictStr, Field(min_length=1, max_length=60)]
    note: Annotated[StrictStr, Field(max_length=500)]
    solution_id: Identifier | None = None
    snapshot_id: Identifier | None = None

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("方案名称不能为空")
        return value

    @model_validator(mode="after")
    def check_solution_pair(self) -> PlanningPlanSaveRequest:
        if (self.solution_id is None) != (self.snapshot_id is None):
            raise ValueError("solution_id 与 snapshot_id 必须同时提供")
        return self


class PlanningPlanConfirmRequest(InputModel):
    context: Literal["planning"]
    request_id: Identifier
    task_id: Identifier
    expected_revision: Identifier
