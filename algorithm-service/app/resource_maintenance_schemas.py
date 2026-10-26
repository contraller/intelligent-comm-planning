"""台账单设备参数维护契约，不接收身份、坐标或其他资源写入。"""
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .task_input_schemas import FiniteNumber, Identifier, InputModel


class ResourceMaintenanceQuery(InputModel):
    context: Literal["ledger"]
    revision: Identifier
    device_id: Identifier


class DeviceParameterPatch(InputModel):
    id: Identifier
    antenna_height_m: Annotated[FiniteNumber, Field(ge=0)] | None = None
    tx_power_dbm: FiniteNumber | None = None
    work_freq_khz: Annotated[FiniteNumber, Field(gt=0)] | None = None

    @model_validator(mode="after")
    def check_fields(self):
        if not self.model_fields_set - {"id"}:
            raise ValueError("至少填写一个可编辑参数")
        for field in ("antenna_height_m", "tx_power_dbm"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(field + " 不允许为空")
        return self


class ResourceDeviceChanges(InputModel):
    context: Literal["ledger"]
    base_revision: Identifier
    request_id: Identifier
    stations: Annotated[list, Field(max_length=0)] = []
    devices: Annotated[list[DeviceParameterPatch], Field(min_length=1, max_length=1)]


class AvailabilityIds(InputModel):
    context: Literal["ledger"]
    ids: Annotated[list[Identifier], Field(min_length=1, max_length=50)]

    @model_validator(mode="after")
    def unique_ids(self):
        if len(set(self.ids)) != len(self.ids):
            raise ValueError("设备编号不能重复")
        return self


class AvailabilityPreview(AvailabilityIds):
    revision: Identifier


class AvailabilityChange(AvailabilityIds):
    base_revision: Identifier
    request_id: Identifier
    availability: Literal["ACTIVE", "OFF_SHELF"]
