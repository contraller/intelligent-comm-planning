"""候选配置及外部参考的严格结构，不表示正式网络或算法评估。"""
from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictInt, StrictStr, model_validator

from .task_input_schemas import FiniteNumber, Identifier, InputModel, PositiveNumber

CONFIG_FIELDS = (
    "nodeAId", "nodeBId", "deviceAId", "deviceBId", "deviceClass",
    "freqKhz", "bandwidthKhz", "isBackup",
)
ASSESSMENT_FIELDS = (
    "distanceM", "pathLossDb", "rxPowerDbm", "linkMarginDb", "isAvailable", "linkState",
)
DATA_FIELDS = ("id", *CONFIG_FIELDS, *ASSESSMENT_FIELDS)
EVALUATION_INPUTS = tuple(field for field in CONFIG_FIELDS if field != "isBackup")


class CandidateConfig(InputModel):
    id: Identifier
    nodeAId: Identifier
    nodeBId: Identifier
    deviceAId: Identifier
    deviceBId: Identifier
    deviceClass: Literal["HF", "VUHF"]
    freqKhz: PositiveNumber | None
    bandwidthKhz: PositiveNumber | None
    isBackup: StrictBool | None

    @model_validator(mode="after")
    def distinct_endpoints(self) -> CandidateConfig:
        if self.nodeAId == self.nodeBId:
            raise ValueError("两端节点不能相同")
        if self.deviceAId == self.deviceBId:
            raise ValueError("两端设备不能相同")
        return self


class CandidateData(CandidateConfig):
    distanceM: FiniteNumber | None
    pathLossDb: FiniteNumber | None
    rxPowerDbm: FiniteNumber | None
    linkMarginDb: FiniteNumber | None
    isAvailable: StrictBool | None
    linkState: Literal["EXCELLENT", "GOOD", "WARNING", "FAULT"] | None


class CandidateSource(InputModel):
    kind: Literal["SOURCE", "IMPORT", "MANUAL"]
    file: Annotated[StrictStr, Field(min_length=1, max_length=255)] | None
    row: Annotated[StrictInt, Field(ge=2)] | None

    @model_validator(mode="after")
    def valid_origin(self) -> CandidateSource:
        if self.kind == "MANUAL":
            if self.file is not None or self.row is not None:
                raise ValueError("手工来源的文件及行号必须为空")
        elif self.file is None or self.row is None:
            raise ValueError("外部来源必须具有文件及行号")
        if self.file is not None and (
            self.file != self.file.strip() or re.search(r"[\x00-\x1f\x7f]", self.file)
        ):
            raise ValueError("来源文件名含首尾空白或控制字符")
        return self


class CandidateReference(InputModel):
    data: CandidateData
    source: CandidateSource

    @model_validator(mode="after")
    def external_assessment(self) -> CandidateReference:
        if self.source.kind == "MANUAL" or not any(
            getattr(self.data, field) is not None for field in ASSESSMENT_FIELDS
        ):
            raise ValueError("参考必须包含外部来源及至少一个评估值")
        return self


class CandidateLink(CandidateData):
    assessmentState: Literal["REFERENCE", "PENDING"]
    source: CandidateSource
    reference: CandidateReference | None
    notices: Annotated[list[StrictStr], Field(strict=True)] = Field(default_factory=list)

    @model_validator(mode="after")
    def consistent_assessment(self) -> CandidateLink:
        present = any(getattr(self, field) is not None for field in ASSESSMENT_FIELDS)
        if self.reference is not None and self.reference.data.id != self.id:
            raise ValueError("参考 ID 必须与候选 ID 一致")
        if self.assessmentState == "PENDING" and present:
            raise ValueError("待评估记录的六个评估字段必须为空")
        if self.assessmentState == "REFERENCE":
            if not present or self.reference is None:
                raise ValueError("参考状态必须具有评估值及冻结参考")
            if self.reference.source != self.source or any(
                getattr(self, field) != getattr(self.reference.data, field)
                for field in (*EVALUATION_INPUTS, *ASSESSMENT_FIELDS)
            ):
                raise ValueError("当前参考的配置、评估及来源必须与冻结参考一致")
        if self.source.kind == "MANUAL" and (
            self.assessmentState != "PENDING" or self.reference is not None
        ):
            raise ValueError("手工记录不能具有评估结果或来源参考")
        return self


class CandidatePatch(InputModel):
    id: Identifier
    nodeAId: Identifier | None = None
    nodeBId: Identifier | None = None
    deviceAId: Identifier | None = None
    deviceBId: Identifier | None = None
    deviceClass: Literal["HF", "VUHF"] | None = None
    freqKhz: PositiveNumber | None = None
    bandwidthKhz: PositiveNumber | None = None
    isBackup: StrictBool | None = None
