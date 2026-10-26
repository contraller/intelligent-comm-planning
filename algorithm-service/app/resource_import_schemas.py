"""资源导入携带原文件，客户端预检候选不能成为写入依据。"""
from typing import Annotated, Literal

from pydantic import Field, StrictStr, model_validator

from .task_input_schemas import Identifier, InputModel

ImportKind = Literal["nodes", "devices", "interference_sources", "topology_links"]


class ImportFile(InputModel):
    name: Annotated[StrictStr, Field(min_length=1, max_length=200)]
    base64: Annotated[StrictStr, Field(min_length=1, max_length=6990508)]


class ImportPreview(InputModel):
    context: Literal["ledger", "gis"]
    base_revision: Identifier
    kind: ImportKind
    file: ImportFile

    @model_validator(mode="after")
    def candidate_context(self):
        if self.kind == "topology_links" and self.context != "gis":
            raise ValueError("候选专用导入仅支持GIS上下文")
        return self


class ImportCommit(ImportPreview):
    request_id: Identifier
    signature: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]


class ImportTemplate(InputModel):
    context: Literal["ledger", "gis"]
    revision: Identifier
    format: Literal["csv", "xlsx"]
    kind: ImportKind = "nodes"

    @model_validator(mode="after")
    def candidate_context(self):
        if self.kind == "topology_links" and self.context != "gis":
            raise ValueError("候选模板仅支持GIS上下文")
        return self
