"""规划频点停用契约；禁止启用、数值编辑及客户端身份字段。"""
from typing import Annotated, Literal

from pydantic import Field, StrictStr, model_validator

from .task_input_schemas import Identifier, InputModel


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
