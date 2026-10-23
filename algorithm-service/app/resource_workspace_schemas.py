"""资源编辑只接收增量，不接收整库、身份或观测结论。"""
from typing import Literal

from pydantic import Field

from .task_input_schemas import Identifier, InputModel


class WorkspaceQuery(InputModel):
    context: Literal["ledger", "gis"]
    revision: Identifier | None = None


class WorkspaceChanges(InputModel):
    context: Literal["ledger", "gis"]
    base_revision: Identifier
    request_id: Identifier
    changes: dict = Field(min_length=1, max_length=10)
