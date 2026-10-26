"""SR6 变更工作流的请求契约。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class KgRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=120)
    actor: str = Field(min_length=1, max_length=100)
    base_revision: int | None = None


class KgDraftRequest(KgRequest):
    ops: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    note: str = Field(min_length=1, max_length=500)
    base_version: int | None = None
    revision: int | None = None


class KgTransitionRequest(KgRequest):
    revision: int
    opinion: str = Field(default="", max_length=500)
    approved: bool | None = None
    submission: int | None = None
