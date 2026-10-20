"""规划任务输入的传输结构及与前端一致的基本约束。"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator, model_validator


def _valid_id(value: str) -> str:
    if not value or len(value) > 120 or re.search(r"\s|[\x00-\x1f\x7f]", value):
        raise ValueError("编号不能为空、超长或包含空白及控制字符")
    return value


Identifier = Annotated[StrictStr, AfterValidator(_valid_id)]
FiniteNumber = Annotated[float, Field(strict=True, allow_inf_nan=False)]
PositiveNumber = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PlanningConstraints(InputModel):
    connectivityPercent: Literal[100]
    maxRelayHops: Literal[2]
    survivabilityPercent: Literal[90]


class PlanningDemand(InputModel):
    id: Identifier
    sourceId: Identifier
    targetId: Identifier
    endpointMode: Literal["station", "device"] = "station"
    sourceDeviceId: Identifier | None = None
    targetDeviceId: Identifier | None = None
    preferredClass: Literal["HF", "VUHF"] | None = None
    routeStrategy: Literal["SHORTEST_PATH", "MIN_DELAY", "MAX_RELIABILITY"] | None = None
    needBackup: StrictBool | None = None
    service: Literal["", "话音", "数据", "短消息"]
    priority: Literal["P1", "P2", "P3"]
    mandatory: StrictBool
    dataVolumeMb: Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)] | None
    requiredRateKbps: PositiveNumber
    maxDelayMs: PositiveNumber
    minReliability: Annotated[float, Field(strict=True, ge=0, le=1, allow_inf_nan=False)]

    @model_validator(mode="after")
    def check_endpoints(self) -> PlanningDemand:
        if self.endpointMode == "device":
            if not self.sourceDeviceId or not self.targetDeviceId or self.sourceDeviceId == self.targetDeviceId:
                raise ValueError("设备级需求须指定两个不同设备")
        elif self.sourceDeviceId or self.targetDeviceId:
            raise ValueError("站点级需求不能指定设备")
        return self


class FrequencyFilter(InputModel):
    deviceClass: Literal["HF", "VUHF"]
    rangeKhz: tuple[PositiveNumber, PositiveNumber] | None
    excludeFreqIds: list[Identifier]

    @model_validator(mode="after")
    def check_filter(self) -> FrequencyFilter:
        if self.rangeKhz is not None and self.rangeKhz[0] > self.rangeKhz[1]:
            raise ValueError("频率下界不得大于上界")
        if len(set(self.excludeFreqIds)) != len(self.excludeFreqIds):
            raise ValueError("排除频点编号不能重复")
        if self.rangeKhz is None and not self.excludeFreqIds:
            raise ValueError("频率范围和排除频点不能同时为空")
        return self


class FrequencyConstraints(InputModel):
    filters: Annotated[list[FrequencyFilter], Field(min_length=1, max_length=2)]

    @model_validator(mode="after")
    def check_classes(self) -> FrequencyConstraints:
        if len({row.deviceClass for row in self.filters}) != len(self.filters):
            raise ValueError("频率类别不能重复")
        return self


class DeploymentSolve(InputModel):
    mode: Literal["MIN_COUNT", "FIXED_COUNT"]
    fixedCount: StrictInt | None
    solutionCount: Annotated[StrictInt, Field(ge=1)]

    @model_validator(mode="after")
    def check_count(self) -> DeploymentSolve:
        if self.mode == "MIN_COUNT" and self.fixedCount is not None:
            raise ValueError("最少部署模式不指定数量")
        if self.mode == "FIXED_COUNT" and (self.fixedCount is None or self.fixedCount < 0):
            raise ValueError("指定部署数量须为非负整数")
        return self


class DeploymentPoint(InputModel):
    lon: Annotated[float, Field(strict=True, ge=-180, le=180, allow_inf_nan=False)]
    lat: Annotated[float, Field(strict=True, ge=-90, le=90, allow_inf_nan=False)]


class DeploymentPolygon(InputModel):
    type: Literal["Polygon"]
    coordinates: list[list[tuple[FiniteNumber, FiniteNumber]]]

    @model_validator(mode="after")
    def check_rings(self) -> DeploymentPolygon:
        if not self.coordinates:
            raise ValueError("禁区至少包含一个坐标环")
        for ring in self.coordinates:
            if len(ring) < 4 or ring[0] != ring[-1] or len(set(ring)) < 3:
                raise ValueError("禁区坐标环须闭合且至少有三个不同顶点")
            if any(abs(lon) > 180 or abs(lat) > 90 for lon, lat in ring):
                raise ValueError("禁区坐标超出经纬度范围")
        return self


class DeploymentConstraints(InputModel):
    maxSlopeDeg: Annotated[float, Field(strict=True, ge=0, le=90, allow_inf_nan=False)] | None
    elevationRangeM: tuple[FiniteNumber, FiniteNumber] | None
    allowedLandcover: list[StrictStr] | None
    roadMaxDistanceM: Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)] | None
    minSiteSpacingM: Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)] | None
    losRequiredNodeIds: list[Identifier]
    gridStepM: PositiveNumber | None
    forcedInclude: Annotated[list[DeploymentPoint], Field(max_length=100)]
    forcedExcludePolygons: Annotated[list[DeploymentPolygon], Field(max_length=20)]

    @model_validator(mode="after")
    def check_lists(self) -> DeploymentConstraints:
        if self.elevationRangeM is not None and self.elevationRangeM[0] > self.elevationRangeM[1]:
            raise ValueError("海拔下界不得大于上界")
        if self.allowedLandcover is not None and (
            not self.allowedLandcover or any(not name.strip() for name in self.allowedLandcover)
            or len(set(self.allowedLandcover)) != len(self.allowedLandcover)
        ):
            raise ValueError("允许地物须为非空、无重复的列表")
        if len(set(self.losRequiredNodeIds)) != len(self.losRequiredNodeIds):
            raise ValueError("通视节点编号不能重复")
        if sum(len(ring) for polygon in self.forcedExcludePolygons for ring in polygon.coordinates) > 2000:
            raise ValueError("禁区坐标总数不得超过 2000")
        return self


class PlanningInput(InputModel):
    name: Annotated[StrictStr, Field(min_length=1, max_length=60)]
    description: Annotated[StrictStr, Field(max_length=500)]
    bbox: tuple[FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber]
    stationIds: Annotated[list[Identifier], Field(min_length=2)]
    presetId: Identifier
    frequencyId: Identifier
    startTime: StrictStr | None = None
    durationH: PositiveNumber | None = None
    constraints: PlanningConstraints
    demands: Annotated[list[PlanningDemand], Field(min_length=1, max_length=5000)]
    frequencyConstraints: FrequencyConstraints | None = None
    deploymentSolve: DeploymentSolve | None = None
    deploymentConstraints: DeploymentConstraints | None = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("任务名称不能为空")
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
            raise ValueError("任务名称包含不支持的控制字符")
        return value

    @field_validator("description")
    @classmethod
    def description_text(cls, value: str) -> str:
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
            raise ValueError("任务说明包含不支持的控制字符")
        return value

    @field_validator("startTime")
    @classmethod
    def valid_time(cls, value: str | None) -> str | None:
        if value is None:
            return None
        pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$"
        if not re.fullmatch(pattern, value):
            raise ValueError("时间须为带时区的 ISO 8601 文本")
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("时间不是有效日历日期") from exc
        return value

    @model_validator(mode="after")
    def check_input(self) -> PlanningInput:
        west, south, east, north = self.bbox
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError("bbox 须为有效 WGS84 经纬度范围")
        if len(set(self.stationIds)) != len(self.stationIds):
            raise ValueError("参与节点不能重复")
        demand_ids = set()
        relations = set()
        for demand in self.demands:
            if demand.id in demand_ids:
                raise ValueError("通联需求编号不能重复")
            demand_ids.add(demand.id)
            if demand.sourceId == demand.targetId or demand.sourceId not in self.stationIds or demand.targetId not in self.stationIds:
                raise ValueError("通联需求两端须为不同的参与节点")
            relation = (demand.endpointMode, demand.sourceId, demand.targetId,
                        demand.sourceDeviceId, demand.targetDeviceId, demand.service)
            if relation in relations:
                raise ValueError("同方向、同业务类型的通联需求不能重复")
            relations.add(relation)
        return self


class TaskSaveRequest(InputModel):
    context: Literal["gis", "planning"]
    task_id: Identifier
    expected_revision: Identifier | None
    resource_revision: Identifier
    request_id: Identifier
    input: PlanningInput


class TaskListQuery(InputModel):
    context: Literal["gis", "planning"]
    page: Annotated[int, Field(ge=1)] = 1
    page_size: Annotated[int, Field(ge=1)] = 10
    search: Annotated[str, Field(max_length=120)] = ""

    @field_validator("page_size")
    @classmethod
    def valid_page_size(cls, value: int) -> int:
        if value not in {5, 10, 20, 50}:
            raise ValueError("page_size 只能是 5、10、20、50")
        return value


class TaskDetailQuery(InputModel):
    context: Literal["gis", "planning"]
    task_id: Identifier


class TaskValidationRequest(InputModel):
    context: Literal["gis", "planning"]
    task_id: Identifier
    expected_revision: Identifier | None
    resource_revision: Identifier
    input: dict[str, object]
