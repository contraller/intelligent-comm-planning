"""干扰场景保存及只读版本契约，不包含分析或措施采纳。"""
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, StrictBool, StrictInt, StrictStr, field_validator, model_validator

from .task_input_schemas import Identifier, InputModel

VersionId = Annotated[Identifier, Field(max_length=40)]
PlanVersion = Annotated[StrictStr, Field(pattern=r"^V[1-9][0-9]*$")]
Hash = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
Name = Annotated[StrictStr, Field(min_length=1, max_length=60)]
Note = Annotated[StrictStr, Field(max_length=500)]


def _path_segment(value):
    if "/" in value or "\\" in value:
        raise ValueError("路径编号必须为单个路径段")
    return value


PathIdentifier = Annotated[Identifier, AfterValidator(_path_segment)]


class SceneSave(InputModel):
    request_id: PathIdentifier
    task_id: Identifier
    plan_id: Identifier
    plan_version: PlanVersion
    resource_revision: Identifier
    base_scene_version_id: VersionId | None
    name: Name
    note: Note
    interference_ids: list[Identifier]

    @field_validator("name")
    @classmethod
    def trimmed_name(cls, value):
        if value != value.strip():
            raise ValueError("名称不允许首尾空白")
        return value

    @field_validator("interference_ids")
    @classmethod
    def unique_sources(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("干扰源编号重复")
        return sorted(value)


class ScenePage(InputModel):
    task_id: Identifier
    page: Annotated[StrictInt, Field(ge=1)] = 1
    page_size: Annotated[StrictInt, Field(ge=1, le=100)] = 20
    search: Annotated[StrictStr, Field(max_length=120)] = ""


class SceneDetailQuery(InputModel):
    task_id: Identifier
    version_id: VersionId | None = None


class SceneReceiptQuery(InputModel):
    task_id: Identifier
    scene_id: PathIdentifier


class SceneSummary(InputModel):
    scene_id: Identifier
    task_id: Identifier
    version_id: VersionId
    version_no: Annotated[StrictInt, Field(ge=1)]
    name: Name
    plan_id: Identifier
    plan_version: PlanVersion
    resource_revision: Identifier
    source_count: Annotated[StrictInt, Field(ge=0)]
    snapshot_hash: Hash
    data_origin: Identifier
    saved_at: StrictStr


class FrozenSource(InputModel):
    interference_id: Identifier
    source_row: dict[StrictStr, StrictStr]


class FrozenPlan(InputModel):
    task_id: Identifier
    plan_id: Identifier
    plan_version: PlanVersion
    input_version: Identifier
    condition_version: Identifier
    resource_revision: Identifier
    source: Literal["SR4"]
    input_snapshot: dict[str, Any]
    raw_snapshot: dict[str, Any]


class SceneVersion(SceneSummary):
    schema_version: Literal[1]
    note: Note
    previous_version_id: VersionId | None
    saved_by: Identifier
    resource_content_hash: Hash
    source: StrictStr
    interference_ids: list[Identifier]
    interference_sources: list[FrozenSource]
    plan_snapshot: FrozenPlan

    @model_validator(mode="after")
    def consistent_selection(self):
        ids = self.interference_ids
        if (ids != sorted(set(ids)) or len(ids) != self.source_count
                or [s.interference_id for s in self.interference_sources] != ids
                or any(s.source_row.get("interference_id") != s.interference_id
                       for s in self.interference_sources)):
            raise ValueError("冻结干扰源与选择不一致")
        plan = self.plan_snapshot
        if any(getattr(plan, key) != getattr(self, key) for key in (
                "task_id", "plan_id", "plan_version", "resource_revision")):
            raise ValueError("冻结方案身份不一致")
        return self


class SceneReceipt(InputModel):
    request_id: Identifier
    operation: Literal["SAVE_INTERFERENCE_SCENE"]
    status: Literal["SUCCEEDED"]
    actor_id: Identifier
    task_id: Identifier
    scene_id: Identifier
    base_scene_version_id: VersionId | None
    version_id: VersionId
    version_no: Annotated[StrictInt, Field(ge=1)]
    plan_id: Identifier
    plan_version: PlanVersion
    resource_revision: Identifier
    snapshot_hash: Hash
    data_origin: Identifier
    changed: StrictBool
    created_at: StrictStr
