"""新版故障页面请求；历史读取与写入修订分离。"""
from datetime import datetime
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class FaultInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    objectType: Literal["NODE", "DEVICE", "LINK"]
    objectId: str = Field(min_length=1, max_length=120)
    faultType: Literal["HW_FAILURE", "LINK_DOWN", "SW_CONFIG", "EMI"]
    symptomIds: list[str] = Field(max_length=30)
    occurTime: str | None = None
    interferenceId: str | None = None

    @field_validator("occurTime")
    @classmethod
    def validate_time(cls, value):
        if value is not None and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("发生时间须带时区")
        return value


class FaultDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(max_length=500)
    planId: str = Field(min_length=1, max_length=120)
    faults: list[FaultInput] = Field(min_length=1, max_length=20)


class FaultMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    baseRevision: str = Field(pattern=r"^SR5-[1-9][0-9]*$")
    requestId: str = Field(min_length=1, max_length=120)
    scenarioId: str | None = None
    scenarioVersionId: str | None = None
    draft: FaultDraft | None = None
    drafts: list[FaultDraft] | None = Field(default=None, min_length=1, max_length=20)
    archived: bool | None = None
    runId: str | None = None
    feedback: dict[str, Any] | None = None


class FaultPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pageNum: int = Field(default=1, ge=1)
    pageSize: Literal[5, 10, 20, 50] = 20
    search: str = Field(default="", max_length=120)
    archived: bool = False

    @field_validator("pageSize", mode="before")
    @classmethod
    def query_page_size(cls, value):
        return int(value) if isinstance(value, str) and value.isdigit() else value
