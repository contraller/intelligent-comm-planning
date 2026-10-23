"""设备配置请求只记录系统受理，不描述真实设备执行。"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, StrictStr, field_validator, model_validator

from .task_input_schemas import FiniteNumber, Identifier, InputModel

SCHEMA_VERSION = "device-configuration-a1"
ACCEPTANCE_MESSAGE = "配置请求已持久化，系统受理；未下发，设备执行与生效状态待确认"
RequestId = Annotated[StrictStr, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")]
Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]


def check_request_id(value: str) -> str:
    if value in {"context", "validate", "history"}:
        raise ValueError("请求编号不能占用接口保留路径")
    return value


class ConfigurationValues(InputModel):
    tx_power_dbm: FiniteNumber
    work_freq_khz: Annotated[FiniteNumber, Field(gt=0)]


class ConfigurationValidation(InputModel):
    schema_version: Literal["device-configuration-a1"]
    context: Literal["ledger"]
    base_revision: Identifier
    device_id: Identifier
    model_id: Identifier
    values: ConfigurationValues


class ConfigurationSubmission(ConfigurationValidation):
    request_id: RequestId

    _reserved = field_validator("request_id")(check_request_id)


class SourceValues(InputModel):
    tx_power_dbm: FiniteNumber | None
    work_freq_khz: FiniteNumber | None


class DeviceSnapshot(InputModel):
    device_id: Identifier
    node_id: Identifier
    model_id: Identifier
    availability: Literal["ACTIVE"]
    source_values: SourceValues


class ModelConstraints(InputModel):
    model_id: Identifier
    freq_min_khz: Annotated[FiniteNumber, Field(gt=0)]
    freq_max_khz: Annotated[FiniteNumber, Field(gt=0)]
    tx_power_max_dbm: FiniteNumber

    @model_validator(mode="after")
    def ordered_range(self):
        if self.freq_max_khz < self.freq_min_khz:
            raise ValueError("型号频率上下限倒置")
        return self


class SourceFile(InputModel):
    path: Annotated[StrictStr, Field(pattern=r"^data/")]
    sha256: Digest


class Provenance(InputModel):
    data_origin: Literal["SYNTHETIC_INTEGRATION"]
    resource_source: Annotated[StrictStr, Field(min_length=1)]
    source_files: Annotated[dict[str, SourceFile], Field(min_length=1)]


class ProtocolPending(InputModel):
    port_options: Literal[None] = None
    mode_options: Literal[None] = None
    confirmation: Literal["待确认"] = "待确认"


class ConfigurationContext(InputModel):
    schema_version: Literal["device-configuration-a1"] = SCHEMA_VERSION
    context: Literal["ledger"] = "ledger"
    resource_revision: Identifier
    resource_content_hash: Digest
    device: DeviceSnapshot
    model: ModelConstraints
    provenance: Provenance
    protocol: ProtocolPending = ProtocolPending()

    @model_validator(mode="after")
    def linked_model(self):
        if self.device.model_id != self.model.model_id:
            raise ValueError("设备与型号关联不一致")
        return self


class AcceptanceActor(InputModel):
    account_id: Identifier
    display_name: StrictStr
    role_id: Identifier
    identity_revision: Identifier
    integration_mode: Literal[True]


class ConfigurationAcceptance(InputModel):
    schema_version: Literal["device-configuration-a1"] = SCHEMA_VERSION
    configuration_id: Annotated[StrictStr, Field(pattern=r"^DC-[0-9a-f]{32}$")]
    request_id: RequestId
    request_digest: Digest
    context: Literal["ledger"] = "ledger"
    device_id: Identifier
    model_id: Identifier
    base_revision: Identifier
    resource_content_hash: Digest
    requested_values: ConfigurationValues
    device_snapshot: DeviceSnapshot
    model_constraints: ModelConstraints
    provenance: Provenance
    actor: AcceptanceActor
    accepted_at: Annotated[StrictStr, Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")]
    status: Literal["ACCEPTED"] = "ACCEPTED"
    receipt_scope: Literal["SYSTEM_ACCEPTANCE"] = "SYSTEM_ACCEPTANCE"
    dispatch_status: Literal["NOT_DISPATCHED"] = "NOT_DISPATCHED"
    device_execution_status: Literal["UNKNOWN"] = "UNKNOWN"
    applied_values: Literal[None] = None
    online: Literal[None] = None
    effective: Literal[None] = None
    device_reported_at: Literal[None] = None
    message: Literal[ACCEPTANCE_MESSAGE] = ACCEPTANCE_MESSAGE

    @field_validator("accepted_at")
    @classmethod
    def utc_timestamp(cls, value):
        if not value.endswith("Z"):
            raise ValueError("受理时间必须为 UTC")
        datetime.fromisoformat(value[:-1] + "+00:00")
        return value

    @model_validator(mode="after")
    def linked_request(self):
        if (self.device_id != self.device_snapshot.device_id
                or self.model_id != self.device_snapshot.model_id
                or self.model_id != self.model_constraints.model_id):
            raise ValueError("冻结设备、型号与请求不一致")
        limits = self.model_constraints
        if (self.requested_values.tx_power_dbm > limits.tx_power_max_dbm
                or not limits.freq_min_khz <= self.requested_values.work_freq_khz <= limits.freq_max_khz):
            raise ValueError("受理值不满足冻结型号约束")
        return self
