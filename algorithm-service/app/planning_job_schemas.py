"""SR4 规划作业提交接口的请求结构。"""
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, StrictStr, model_validator

from .task_input_schemas import FiniteNumber, Identifier, InputModel
from .interference_frontend_schemas import Hash, PathIdentifier, VersionId


class PlanningDeviceOverride(InputModel):
    device_id: Identifier
    tx_power_dbm: FiniteNumber | None = None
    antenna_height_m: Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)] | None = None

    @model_validator(mode="after")
    def check_values(self) -> PlanningDeviceOverride:
        fields = self.model_fields_set & {"tx_power_dbm", "antenna_height_m"}
        if not fields or any(getattr(self, field) is None for field in fields):
            raise ValueError("设备调整须提供非空功率或挂高")
        return self


class PlanningManualPath(InputModel):
    demand_id: Identifier
    node_path: Annotated[list[Identifier], Field(min_length=2)]

    @model_validator(mode="after")
    def check_nodes(self) -> PlanningManualPath:
        if len(set(self.node_path)) != len(self.node_path):
            raise ValueError("人工路径不能重复经过同一节点")
        return self


class PlanningInterferenceOrigin(InputModel):
    adoption_id: VersionId
    run_id: VersionId
    measure_id: VersionId
    source_hash: Hash
    change_hash: Hash
    actor_id: PathIdentifier


class PlanningInterferenceInput(InputModel):
    scene_id: PathIdentifier
    scene_version_id: VersionId
    scene_snapshot_hash: Hash
    resource_content_hash: Hash
    terrain_fingerprint: Hash
    data_origin: StrictStr
    change_set: dict[str, Any]
    sources: list[dict[str, StrictStr]]
    parameter_substitutions: list[list[Any]]


class PlanningAdjustmentInput(InputModel):
    schema_version: Literal[1]
    source_plan_id: Identifier
    source_snapshot_id: Identifier
    manual_override: list[PlanningDeviceOverride]
    manual_paths: list[PlanningManualPath]
    interference_origin: PlanningInterferenceOrigin | None = None
    interference: PlanningInterferenceInput | None = None

    @model_validator(mode="after")
    def check_unique(self) -> PlanningAdjustmentInput:
        if len({row.device_id for row in self.manual_override}) != len(self.manual_override):
            raise ValueError("设备调整编号不能重复")
        if len({row.demand_id for row in self.manual_paths}) != len(self.manual_paths):
            raise ValueError("人工路径的需求编号不能重复")
        if (self.interference_origin is None) != (self.interference is None):
            raise ValueError("干扰来源与冻结变化必须成对提供")
        return self


class PlanningJobSubmitRequest(InputModel):
    context: Literal["planning"]
    request_id: Identifier
    task_id: Identifier
    expected_revision: Identifier
    input_version: Identifier
    condition_version: Identifier
    resource_revision: Identifier
    parent_plan_id: Identifier | None
    adjustment: PlanningAdjustmentInput | None = None


class PlanningJobCancelRequest(InputModel):
    context: Literal["planning"]
    request_id: Identifier
    task_id: Identifier
    expected_revision: Identifier
