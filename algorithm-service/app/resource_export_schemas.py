"""台账导出及设备全库筛选契约，只接受明确快照引用，不接收观测结果。"""
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictStr, field_validator, model_validator

from .task_input_schemas import FiniteNumber, Identifier, InputModel

Kind = Literal["nodes", "devices", "interference_sources"]


class DeviceFrequencySelection(InputModel):
    mode: Literal["ALL", "MODEL", "DEVICE"] = "ALL"
    presence: Literal["ALL", "PRESENT", "MISSING"] = "ALL"
    min_khz: Annotated[FiniteNumber, Field(ge=0)] | None = None
    max_khz: Annotated[FiniteNumber, Field(ge=0)] | None = None

    @model_validator(mode="after")
    def check_combination(self):
        if self.min_khz is not None and self.max_khz is not None and self.min_khz > self.max_khz:
            raise ValueError("频率下限不能大于上限")
        if self.mode != "DEVICE" and self.presence != "ALL":
            raise ValueError("只有设备频点支持有值/为空筛选")
        if (self.mode == "ALL" or self.presence == "MISSING") and (
            self.min_khz is not None or self.max_khz is not None
        ):
            raise ValueError("当前频率模式不能携带隐藏范围")
        return self


class ResourceDeviceFilter(InputModel):
    search: Annotated[StrictStr, Field(max_length=120)] = ""
    device_class: Literal["HF", "VUHF"] | None = None
    status: Literal["NORMAL", "FAULT", "OFFLINE", "UNKNOWN"] | None = None
    availability: Literal["ACTIVE", "OFF_SHELF", "UNKNOWN"] | None = None
    alert: Literal["YES", "NO", "UNKNOWN"] | None = None
    mobility: Identifier | None = None
    node_role: Identifier | None = None
    relay_capable: StrictBool | None = None
    frequency: DeviceFrequencySelection | None = None

    @field_validator("search")
    @classmethod
    def search_without_controls(cls, value):
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("搜索词不能包含控制字符")
        return value


class ResourceExportRequest(InputModel):
    context: Literal["ledger"]
    revision: Identifier
    format: Literal["csv", "xlsx"]
    kinds: Annotated[list[Kind], Field(min_length=1, max_length=3)]
    range: Literal["all", "filtered", "selected"]
    filter: ResourceDeviceFilter | None = None
    selected_ids: Annotated[list[Identifier], Field(min_length=1, max_length=50)] | None = None
    status_mode: Literal["baseline", "observed"] = "baseline"
    observation_snapshot_id: Identifier | None = None

    @model_validator(mode="after")
    def check_scope(self):
        if len(set(self.kinds)) != len(self.kinds) or self.format == "csv" and len(self.kinds) != 1:
            raise ValueError("CSV 只能选择一张表，资源类型不能重复")
        if self.status_mode == "observed":
            if not self.observation_snapshot_id or "devices" not in self.kinds:
                raise ValueError("观测导出必须明确状态快照并包含设备表；节点不推断观测状态")
        elif self.observation_snapshot_id is not None:
            raise ValueError("基线导出不能携带观测快照")
        if self.range != "filtered" and "filter" in self.model_fields_set:
            raise ValueError("只有筛选范围可以携带 filter")
        if self.range == "filtered" and self.filter is None:
            raise ValueError("筛选范围必须明确提供 filter")
        if self.range == "selected":
            if not self.selected_ids or len(set(self.selected_ids)) != len(self.selected_ids):
                raise ValueError("必须选择不重复的设备编号")
        elif "selected_ids" in self.model_fields_set:
            raise ValueError("只有勾选范围可以携带设备编号")
        return self


class ResourceDeviceQuery(InputModel):
    context: Literal["ledger", "gis", "planning"] = "planning"
    revision: Identifier
    page: Annotated[int, Field(ge=1)] = 1
    page_size: Literal[5, 10, 20, 50] = 10
    search: Annotated[StrictStr, Field(max_length=120)] = ""
    node_id: Identifier | None = None
    device_class: Literal["HF", "VUHF"] | None = None
    status: Literal["NORMAL", "FAULT", "OFFLINE", "UNKNOWN"] | None = None
    availability: Literal["ACTIVE", "OFF_SHELF", "UNKNOWN"] | None = None
    alert: Literal["YES", "NO", "UNKNOWN"] | None = None
    mobility: Identifier | None = None
    node_role: Identifier | None = None
    relay_capable: Literal["true", "false"] | None = None
    frequency_mode: Literal["ALL", "MODEL", "DEVICE"] = "ALL"
    frequency_presence: Literal["ALL", "PRESENT", "MISSING"] = "ALL"
    min_khz: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None
    max_khz: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None
    sort: Literal["id", "name", "status", "workFreqKhz"] = "id"
    order: Literal["asc", "desc"] = "asc"

    @field_validator("page", "page_size", mode="before")
    @classmethod
    def query_integer(cls, value):
        if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 9:
            return int(value)
        raise ValueError("分页参数必须是十进制正整数")

    @model_validator(mode="after")
    def check_filter(self):
        self.device_filter()
        return self

    def device_filter(self):
        values = {key: getattr(self, key) for key in ResourceDeviceFilter.model_fields
                  if key not in ("frequency", "relay_capable")}
        values["relay_capable"] = None if self.relay_capable is None else self.relay_capable == "true"
        values["frequency"] = DeviceFrequencySelection(mode=self.frequency_mode,
            presence=self.frequency_presence, min_khz=self.min_khz, max_khz=self.max_khz)
        return ResourceDeviceFilter.model_validate(values)
