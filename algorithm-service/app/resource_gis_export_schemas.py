"""GIS 已保存资源导出参数；分页、草稿和观测不进入文件范围。"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, StrictStr, field_validator, model_validator

from .resource_export_schemas import ResourceDeviceFilter
from .task_input_schemas import Identifier, InputModel

Kind = Literal["nodes", "devices", "interference_sources", "topology_links"]
SelectedIds = Annotated[list[Identifier], Field(strict=True, max_length=50)]
DEVICE_FILTER_FIELDS = {
    "search", "device_class", "status", "availability", "alert", "mobility",
    "node_role", "relay_capable", "frequency",
}


class CandidateExportFilter(InputModel):
    search: Annotated[StrictStr, Field(max_length=120)] = ""
    device_class: Literal["HF", "VUHF"] | None = None
    alert: Literal["YES"] | None = None

    @field_validator("search")
    @classmethod
    def valid_search(cls, value):
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("搜索词不能包含控制字符")
        return value


class ResourceGisExportRequest(InputModel):
    context: Literal["gis"]
    revision: Identifier
    format: Literal["csv", "xlsx"]
    kinds: Annotated[list[Kind], Field(strict=True, min_length=1, max_length=3)]
    range: Literal["all", "filtered", "selected"]
    browse: Literal["devices", "stations"]
    filter: ResourceDeviceFilter | CandidateExportFilter | None = None
    selected_ids: Annotated[dict[Kind, SelectedIds], Field(strict=True)] | None = None

    @model_validator(mode="after")
    def valid_scope(self):
        candidate = "topology_links" in self.kinds
        if len(set(self.kinds)) != len(self.kinds):
            raise ValueError("资源类型不能重复")
        if self.format == "csv" and len(self.kinds) != 1:
            raise ValueError("CSV 只能导出一张表")
        if candidate and self.kinds != ["topology_links"]:
            raise ValueError("候选必须使用独立文件，不能混入三表")
        if self.range != "filtered" and "filter" in self.model_fields_set:
            raise ValueError("只有 filtered 可以携带 filter，空值也不例外")
        if self.range == "filtered":
            if self.filter is None:
                raise ValueError("filtered 必须明确提供 filter")
            values = self.filter.model_dump(exclude_unset=True)
            if not candidate and set(values) - DEVICE_FILTER_FIELDS:
                raise ValueError("GIS 导出只接受基线设备筛选")
            schema = CandidateExportFilter if candidate else ResourceDeviceFilter
            self.filter = schema.model_validate(values)
        if self.range != "selected" and "selected_ids" in self.model_fields_set:
            raise ValueError("只有 selected 可以携带 selected_ids")
        if self.range == "selected":
            if not self.selected_ids or not any(self.selected_ids.get(kind) for kind in self.kinds):
                raise ValueError("所选资源类型必须至少有一个明确的对象编号")
            allowed = {"topology_links"} if candidate else {"nodes", "devices", "interference_sources"}
            if set(self.selected_ids) - allowed:
                raise ValueError("候选与三表不能混用编号范围")
            if any(len(ids) != len(set(ids)) for ids in self.selected_ids.values()):
                raise ValueError("同类选择编号不能重复")
        return self
