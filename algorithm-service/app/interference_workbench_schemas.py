"""R2 干扰工作流请求；场景仍复用已集成的不可变版本接口。"""
from typing import Annotated, Literal

from pydantic import Field, StrictInt, StrictStr

from .interference_frontend_schemas import Hash, PathIdentifier, PlanVersion, VersionId
from .task_input_schemas import Identifier, InputModel

PositiveInt = Annotated[StrictInt, Field(ge=1)]
RunState = Literal["PENDING", "RUNNING", "CANCEL_REQUESTED", "SUCCESS", "FAILED", "CANCELLED"]
Operation = Literal["SUBMIT_ANALYSIS", "CANCEL_ANALYSIS", "ADOPT_MEASURE", "CANCEL_ADOPTION"]


class ContextQuery(InputModel):
    task_id: Identifier | None = None


class SourceQuery(ContextQuery):
    page: PositiveInt = 1
    page_size: Annotated[StrictInt, Field(ge=1, le=100)] = 20
    search: Annotated[StrictStr, Field(max_length=120)] = ""


class TaskQuery(InputModel):
    task_id: Identifier


class RunQuery(SourceQuery):
    task_id: Identifier
    state: RunState | None = None


class PreviewQuery(TaskQuery):
    expected_run_version: PositiveInt


class RunSubmit(InputModel):
    request_id: PathIdentifier
    task_id: Identifier
    plan_id: Identifier
    plan_version: PlanVersion
    resource_revision: Identifier
    scene_id: PathIdentifier
    scene_version_id: VersionId
    snapshot_hash: Hash


class RunCancel(TaskQuery):
    request_id: PathIdentifier
    expected_run_version: PositiveInt


class AdoptionSubmit(InputModel):
    request_id: PathIdentifier
    task_id: Identifier
    run_id: VersionId
    measure_id: VersionId
    expected_run_version: PositiveInt
    plan_id: Identifier
    plan_version: PlanVersion
    resource_revision: Identifier
    scene_version_id: VersionId
    snapshot_hash: Hash


class AdoptionCancel(TaskQuery):
    request_id: PathIdentifier
    expected_adoption_version: PositiveInt


class OperationQuery(TaskQuery):
    operation: Operation
