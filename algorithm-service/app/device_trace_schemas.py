"""资源历史只读投影；恢复仅为三参数候选，不保存资源。"""
from typing import Literal
from pydantic import field_validator
from .task_input_schemas import InputModel, Identifier
from .device_configuration_schemas import RequestId, check_request_id

SCHEMA = "device-trace-a1"


class RestorePreviewInput(InputModel):
    schema_version: Literal["device-trace-a1"]
    context: Literal["ledger"]
    base_revision: Identifier
    source_revision: Identifier
    source_request_id: RequestId | None

    @field_validator("source_request_id")
    @classmethod
    def valid_request(cls, value):
        return check_request_id(value) if value is not None else None
