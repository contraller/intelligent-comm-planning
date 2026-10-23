"""Strict query-string DTOs for the existing resource GET handlers."""
from __future__ import annotations

import math
import re
from typing import Annotated, Literal

from pydantic import BeforeValidator, Field, StrictStr, field_validator, model_validator

from .resource_export_schemas import DeviceFrequencySelection, ResourceDeviceQuery
from .task_input_schemas import Identifier, InputModel


def _integer(value):
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,9}", value):
        return int(value)
    if type(value) is int:
        return value
    raise ValueError("Expected a decimal integer")


def _number(value):
    if isinstance(value, str):
        if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value):
            raise ValueError("Expected a finite decimal number")
        value = float(value)
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("Expected a finite decimal number")
    return float(value)


def _boolean(value):
    if type(value) is bool:
        return value
    if value in ("true", "false"):
        return value == "true"
    raise ValueError("Expected true or false")


def _text(value):
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Control characters are not allowed")
    return value


Number = Annotated[float, BeforeValidator(_number)]
Boolean = Annotated[bool, BeforeValidator(_boolean)]
Search = Annotated[StrictStr, Field(max_length=120)]
PageSize = Literal[5, 10, 20, 50]


def _observation(query, supported=True):
    if query.status_mode == "observed":
        if not supported or query.context == "planning":
            raise ValueError("Observed status is unsupported for this query/context")
        if not query.observation_snapshot_id:
            raise ValueError("Observed status requires observation_snapshot_id")
    elif query.observation_snapshot_id is not None:
        raise ValueError("Baseline status cannot carry observation_snapshot_id")
    return query


class ResourceDeviceReadQuery(ResourceDeviceQuery):
    """Extends the export-compatible device filter without changing that DTO."""

    id: Identifier | None = None
    region: Search | None = None
    status_mode: Literal["baseline", "observed"] = "baseline"
    observation_snapshot_id: Identifier | None = None

    @field_validator("page", "page_size", mode="before")
    @classmethod
    def query_integer(cls, value):
        return _integer(value)

    @field_validator("min_khz", "max_khz", mode="before")
    @classmethod
    def query_number(cls, value):
        return None if value is None else _number(value)

    @field_validator("search", "region")
    @classmethod
    def text_without_controls(cls, value):
        return None if value is None else _text(value)

    @model_validator(mode="after")
    def observation_mode(self):
        return _observation(self)


class ResourceObjectQuery(InputModel):
    context: Literal["ledger", "gis", "planning"] = "planning"
    revision: Identifier
    status_mode: Literal["baseline", "observed"] = "baseline"
    observation_snapshot_id: Identifier | None = None

    @model_validator(mode="after")
    def observation_mode(self):
        return _observation(self)


class _PageQuery(ResourceObjectQuery):
    page: Annotated[int, BeforeValidator(_integer), Field(ge=1)] = 1
    page_size: Annotated[PageSize, BeforeValidator(_integer)] = 10
    search: Search = ""
    id: Identifier | None = None
    sort: Literal["id", "name"] = "id"
    order: Literal["asc", "desc"] = "asc"

    @field_validator("search")
    @classmethod
    def search_without_controls(cls, value):
        return _text(value)


class _NodeFilters(InputModel):
    search: Search = ""
    id: Identifier | None = None
    region: Search | None = None
    device_class: Literal["HF", "VUHF"] | None = None
    status: Literal["NORMAL", "FAULT", "OFFLINE", "UNKNOWN"] | None = None
    alert: Literal["YES", "NO", "UNKNOWN"] | None = None
    mobility: Identifier | None = None
    node_role: Identifier | None = None
    relay_capable: Boolean | None = None
    parent_id: StrictStr | None = None
    availability: Literal["ACTIVE", "OFF_SHELF", "UNKNOWN"] | None = None
    frequency_mode: Literal["ALL", "MODEL", "DEVICE"] = "ALL"
    frequency_presence: Literal["ALL", "PRESENT", "MISSING"] = "ALL"
    min_khz: Annotated[Number, Field(ge=0)] | None = None
    max_khz: Annotated[Number, Field(ge=0)] | None = None

    @field_validator("search", "region", "parent_id")
    @classmethod
    def text_without_controls(cls, value):
        if value is None:
            return value
        _text(value)
        if len(value) > 120:
            raise ValueError("Text is too long")
        return value

    @field_validator("parent_id")
    @classmethod
    def parent_identifier(cls, value):
        if value and re.search(r"\s", value):
            raise ValueError("Parent ID cannot contain whitespace")
        return value

    def frequency_filter(self):
        return DeviceFrequencySelection(mode=self.frequency_mode, presence=self.frequency_presence,
                                        min_khz=self.min_khz, max_khz=self.max_khz)

    @model_validator(mode="after")
    def valid_frequency(self):
        self.frequency_filter()
        return self


class ResourceNodeQuery(_NodeFilters, _PageQuery):
    sort: Literal["id", "name", "status"] = "id"
    cluster_id: Annotated[StrictStr, Field(min_length=1, max_length=512, pattern=r"^[A-Za-z0-9_-]+$")] | None = None

    @model_validator(mode="after")
    def baseline_only(self):
        return _observation(self, supported=False)


class ResourceInterferenceQuery(_PageQuery):
    @model_validator(mode="after")
    def baseline_only(self):
        return _observation(self, supported=False)


class ResourceMapQuery(_NodeFilters, ResourceObjectQuery):
    bbox: tuple[Number, Number, Number, Number]
    zoom: Annotated[Number, Field(ge=0, le=20)]
    show_nodes: Boolean = True
    show_interferences: Boolean = True

    @field_validator("bbox", mode="before")
    @classmethod
    def raw_bbox(cls, value):
        return value.split(",") if isinstance(value, str) else value

    @field_validator("bbox")
    @classmethod
    def ordered_wgs84(cls, value):
        a, b, c, d = value
        if not (-180 <= a < c <= 180 and -90 <= b < d <= 90):
            raise ValueError("bbox must be ordered WGS84 bounds")
        return value

    @model_validator(mode="after")
    def baseline_only(self):
        return _observation(self, supported=False)
