"""显式构造状态导入；采集时间与导入时间分开，未知值不可推断。"""
from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictStr, field_validator, model_validator

from .task_input_schemas import Identifier, InputModel
from .device_configuration_schemas import RequestId, check_request_id

SCHEMA = "device-status-snapshot-a1"
ORIGIN = "SYNTHETIC_INTEGRATION"
Status = Literal["NORMAL", "FAULT", "OFFLINE"]
Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]


def utc_time(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value
    ):
        raise ValueError("时间必须为带时区的 RFC3339")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(
        timespec="microseconds").replace("+00:00", "Z")


class ImportedDeviceStatus(InputModel):
    device_id: Identifier
    node_id: Identifier
    model_id: Identifier
    observed_at: StrictStr | None
    status: Status | None
    alert: StrictBool | None
    unknown_reasons: Annotated[list[Annotated[StrictStr, Field(min_length=1, max_length=500)]], Field(max_length=16)]

    @field_validator("observed_at")
    @classmethod
    def valid_time(cls, value):
        if value is not None:
            utc_time(value)
        # 原始偏移与精度仍留在导入原文中，查询列另行规范到 UTC。
        return value

    @model_validator(mode="after")
    def unknowns(self):
        if any(not text.strip() for text in self.unknown_reasons) or len(set(self.unknown_reasons)) != len(self.unknown_reasons):
            raise ValueError("未知原因不能为空或重复")
        if any(value is None for value in (self.observed_at, self.status, self.alert)) and not self.unknown_reasons:
            raise ValueError("未知状态、告警或采集时间必须保留原因")
        return self


class DeviceStatusImport(InputModel):
    schema_version: Literal["device-status-snapshot-a1"]
    context: Literal["ledger"]
    request_id: RequestId
    base_revision: Identifier
    data_origin: Literal["SYNTHETIC_INTEGRATION"]
    source_label: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    provenance_note: Annotated[StrictStr, Field(min_length=1, max_length=1000)]
    records: Annotated[list[ImportedDeviceStatus], Field(min_length=1, max_length=1000)]

    _reserved = field_validator("request_id")(check_request_id)

    @model_validator(mode="after")
    def unique_devices(self):
        if not self.source_label.strip() or not self.provenance_note.strip():
            raise ValueError("构造来源与说明不能为空")
        if len({record.device_id for record in self.records}) != len(self.records):
            raise ValueError("同批设备不能重复")
        return self
