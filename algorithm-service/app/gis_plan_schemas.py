"""GIS 冻结方案只读投影，未知配置与观测不补造默认值。"""
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictStr, field_validator

from .task_input_schemas import FiniteNumber, Identifier, InputModel


NonNegative = Annotated[FiniteNumber, Field(ge=0)]
Frequency = Annotated[FiniteNumber, Field(gt=0)]
Reliability = Annotated[FiniteNumber, Field(ge=0, le=1)]
Band = Literal["HF", "VUHF"]


class GisPlanQuery(InputModel):
    context: Literal["gis"]
    task_id: Identifier
    snapshot_id: Identifier | None = None


class GisPathQuery(GisPlanQuery):
    demand_id: Identifier | None = None


class PlanIdentity(InputModel):
    plan_id: Identifier
    task_id: Identifier
    snapshot_id: Identifier
    input_version: Identifier
    condition_version: Identifier
    resource_revision: Identifier
    state: Literal["SAVED", "REFERENCE", "CONFIRMED"]
    source_changed: StrictBool
    data_origin: Literal["SYNTHETIC_INTEGRATION"]
    source: Literal["SR4"]


class FrozenNode(InputModel):
    id: Identifier
    name: Annotated[StrictStr, Field(min_length=1, max_length=512)]
    coordinate: Annotated[list[FiniteNumber], Field(min_length=2, max_length=2)]
    status: Literal["NORMAL", "FAULT", "OFFLINE"] | None
    alert: StrictBool | None

    @field_validator("coordinate")
    @classmethod
    def valid_coordinate(cls, value):
        if abs(value[0]) > 180 or abs(value[1]) > 90:
            raise ValueError("冻结坐标超出经纬度范围")
        return value


class FrozenDevice(InputModel):
    id: Identifier
    station_id: Identifier
    model_id: Identifier
    device_class: Band
    frequency_khz: Frequency | None
    tx_power_dbm: FiniteNumber | None
    antenna_height_m: NonNegative | None


class FrozenLink(InputModel):
    id: Identifier
    a: Identifier
    b: Identifier
    device_a: Identifier
    device_b: Identifier
    device_class: Band
    frequency_khz: Frequency | None
    backup: StrictBool
    planned_state: Literal["EXCELLENT", "GOOD", "WARNING", "FAULT"] | None


class FrozenDemand(InputModel):
    id: Identifier
    source_id: Identifier
    target_id: Identifier
    source_device_id: Identifier | None
    target_device_id: Identifier | None
    service: Literal["", "话音", "数据", "短消息"] | None
    mandatory: StrictBool | None
    required_rate_kbps: Frequency | None
    min_reliability: Reliability | None


class FrozenRoute(InputModel):
    id: Identifier
    demand_id: Identifier
    node_ids: Annotated[list[Identifier], Field(min_length=1)]
    link_ids: list[Identifier]
    backup: StrictBool


class NetworkProjection(InputModel):
    identity: PlanIdentity
    nodes: Annotated[list[FrozenNode], Field(min_length=1)]
    devices: list[FrozenDevice]
    links: list[FrozenLink]
    demands: list[FrozenDemand]
    routes: list[FrozenRoute]
    paths_state: Literal["ready", "missing"]
    paths_message: StrictStr
