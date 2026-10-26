"""资源编辑只接收增量，不接收整库、身份或观测结论。"""
from typing import Literal

from pydantic import Field, model_validator

from .task_input_schemas import Identifier, InputModel


class WorkspaceQuery(InputModel):
    context: Literal["ledger", "gis"]
    revision: Identifier | None = None


class WorkspaceChanges(InputModel):
    context: Literal["ledger", "gis"]
    base_revision: Identifier
    request_id: Identifier
    changes: dict = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def candidate_context(self):
        # 候选拓扑只在GIS中维护，台账空增量仍可按既有语义核实no-op。
        if self.context != "gis" and any(self.changes.get(key) for key in
                ("newCandidateLinks", "candidateLinks", "importedCandidateLinks")):
            raise ValueError("候选链路变更只支持GIS上下文")
        return self
