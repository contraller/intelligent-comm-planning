"""规划构造频点维护契约；禁止客户端身份、占用事实和来源覆盖。"""
from typing import Annotated, Literal

import re

from pydantic import Field, StrictBool, StrictInt, StrictStr, field_validator, model_validator

from .task_input_schemas import FiniteNumber, Identifier, InputModel, PositiveNumber


ResourceRevision = Annotated[StrictStr, Field(pattern=r"^resource-[0-9a-f]{16}$")]


class FrequencyResourceQuery(InputModel):
    context: Literal["ledger"]
    revision: ResourceRevision


class FrequencySelection(InputModel):
    context: Literal["ledger"]
    ids: Annotated[list[Identifier], Field(min_length=1, max_length=50)]

    @model_validator(mode="after")
    def unique_ids(self):
        if len(self.ids) != len(set(self.ids)):
            raise ValueError("频点编号不能重复")
        return self


class FrequencyDisableValidation(FrequencySelection):
    revision: ResourceRevision


class FrequencyDisableChange(FrequencySelection):
    base_revision: ResourceRevision
    request_id: Identifier


class FrequencyHistoryQuery(InputModel):
    context: Literal["ledger"]
    page: Annotated[int, Field(ge=1)] = 1
    page_size: Literal[5, 10, 20, 50] = 10
    search: Annotated[StrictStr, Field(max_length=120)] = ""

    @field_validator("page", "page_size", mode="before")
    @classmethod
    def integer_query(cls, value):
        if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
            return int(value)
        if type(value) is int:
            return value
        raise ValueError("分页参数必须为整数")

    @field_validator("search")
    @classmethod
    def search_text(cls, value):
        if re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError("搜索不能包含控制字符")
        return value


class FrequencyPageQuery(FrequencyHistoryQuery):
    revision: ResourceRevision
    device_class: Literal["HF", "VUHF"] | None = None
    availability: Literal["AVAILABLE", "DISABLED"] | None = None
    min_khz: Annotated[float, Field(gt=0, allow_inf_nan=False)] | None = None
    max_khz: Annotated[float, Field(gt=0, allow_inf_nan=False)] | None = None

    @model_validator(mode="after")
    def frequency_range(self):
        if self.min_khz is not None and self.max_khz is not None and self.min_khz > self.max_khz:
            raise ValueError("频率下限不得超过上限")
        return self


class FrequencyOperationQuery(InputModel):
    context: Literal["ledger"]
    request_id: Identifier


class FrequencyStoredItem(InputModel):
    freq_id: Identifier
    device_class: Literal["HF", "VUHF"]
    center_freq_khz: PositiveNumber
    bandwidth_khz: PositiveNumber | None
    channel_no: Annotated[StrictInt, Field(ge=0)] | None
    is_available: StrictBool
    occupied_by: StrictStr | None
    reuse_min_distance_m: Annotated[FiniteNumber, Field(ge=0)] | None
    adjacent_guard_khz: Annotated[FiniteNumber, Field(ge=0)] | None
    note: StrictStr | None


class FrequencyStoredReceipt(InputModel):
    object_id: Literal["resource-frequency-disable", "resource-frequency-changes"]
    request_id: Identifier
    base_revision: ResourceRevision
    selected_ids: Annotated[list[Identifier], Field(min_length=1, max_length=50)]
    affected_ids: list[Identifier]
    updated: list[Identifier]
    unchanged: list[Identifier]
    items: list[FrequencyStoredItem]
    data_origin: Literal["SYNTHETIC_INTEGRATION"]
    source: Annotated[StrictStr, Field(min_length=1)]
    warnings: Annotated[list, Field(max_length=0)]
    changed: StrictBool
    revision: ResourceRevision
    read_revision: ResourceRevision

    @model_validator(mode="after")
    def receipt_consistency(self):
        for values in (self.selected_ids, self.affected_ids, self.updated, self.unchanged):
            if values != sorted(set(values)):
                raise ValueError("回执编号顺序或唯一性无效")
        if (self.read_revision != self.revision or self.changed != bool(self.updated)
            or self.changed == (self.revision == self.base_revision)
            or self.affected_ids != self.updated or set(self.updated) & set(self.unchanged)
            or sorted(self.updated + self.unchanged) != self.selected_ids
            or [item.freq_id for item in self.items] != self.selected_ids
            or self.object_id == "resource-frequency-disable" and any(item.is_available for item in self.items)):
            raise ValueError("回执分区、保存值或版本不一致")
        return self


class FrequencyPatchFields(InputModel):
    center_freq_khz: PositiveNumber | None = None
    bandwidth_khz: PositiveNumber | None = None
    channel_no: Annotated[StrictInt, Field(ge=0)] | None = None
    reuse_min_distance_m: Annotated[FiniteNumber, Field(ge=0)] | None = None
    adjacent_guard_khz: Annotated[FiniteNumber, Field(ge=0)] | None = None
    note: Annotated[StrictStr, Field(min_length=1, max_length=2000)] | None = None

    @model_validator(mode="after")
    def nonempty_patch(self):
        if not self.model_fields_set or "center_freq_khz" in self.model_fields_set and self.center_freq_khz is None:
            raise ValueError("修改字段不能为空，中心频率不能清空")
        return self


class FrequencyAddItem(InputModel):
    device_class: Literal["HF", "VUHF"]
    center_freq_khz: PositiveNumber
    bandwidth_khz: PositiveNumber | None
    channel_no: Annotated[StrictInt, Field(ge=0)] | None
    reuse_min_distance_m: Annotated[FiniteNumber, Field(ge=0)] | None
    adjacent_guard_khz: Annotated[FiniteNumber, Field(ge=0)] | None
    note: Annotated[StrictStr, Field(min_length=1, max_length=2000)] | None


class FrequencyAdd(InputModel):
    kind: Literal["ADD"]
    freq_id: Identifier
    item: FrequencyAddItem


class FrequencyPatch(InputModel):
    kind: Literal["PATCH"]
    freq_id: Identifier
    fields: FrequencyPatchFields


class FrequencyEnable(InputModel):
    kind: Literal["ENABLE"]
    freq_id: Identifier


FrequencyAction = Annotated[FrequencyAdd | FrequencyPatch | FrequencyEnable, Field(discriminator="kind")]


class FrequencyChangesSelection(InputModel):
    context: Literal["ledger"]
    changes: Annotated[list[FrequencyAction], Field(min_length=1, max_length=50)]

    @model_validator(mode="after")
    def unique_actions(self):
        if len({action.freq_id for action in self.changes}) != len(self.changes):
            raise ValueError("同一频点不能重复或组合动作")
        return self


class FrequencyChangesValidation(FrequencyChangesSelection):
    revision: ResourceRevision


class FrequencyChangesChange(FrequencyChangesSelection):
    base_revision: ResourceRevision
    request_id: Identifier
