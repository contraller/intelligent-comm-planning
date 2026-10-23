"""构造频谱观测契约；未知观测原样保留，不推导实测值。"""
from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

ORIGIN = "SYNTHETIC_INTEGRATION"
MAX_FRAMES = 256
MAX_BINS = 256
Identifier = Annotated[str, Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")]
Revision = Annotated[str, Field(pattern=r"^observation-[0-9a-f]{64}$")]
Text = Annotated[str, Field(min_length=1, max_length=200)]
Percent = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
Finite = Annotated[float, Field(allow_inf_nan=False)]


class ObservationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def utc_time(value: str) -> str:
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])", value):
        raise ValueError("时间须为带时区的 RFC3339 字符串")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    except OverflowError as exc:
        raise ValueError("时间超出 UTC 可表示范围") from exc


class SourceSnapshot(ObservationModel):
    sourceId: Identifier
    name: str = Field(min_length=1, max_length=60)
    configRevision: Identifier
    minKhz: Finite
    maxKhz: Finite
    intervalSeconds: Annotated[int, Field(ge=1, le=3600)] | None

    @model_validator(mode="after")
    def validate_source(self):
        if self.name != self.name.strip() or not 0 < self.minKhz < self.maxKhz:
            raise ValueError("来源名称或频段无效")
        return self


class UnknownObservation(ObservationModel):
    unknownReasons: list[Text] = Field(max_length=16)

    @field_validator("unknownReasons")
    @classmethod
    def unique_reasons(cls, values):
        if len(set(values)) != len(values) or any(not value.strip() for value in values):
            raise ValueError("未知原因不得为空或重复")
        return values


class SpectrumBin(UnknownObservation):
    binId: Identifier
    minKhz: Finite
    maxKhz: Finite
    occupancyPercent: Percent | None
    powerDbm: Finite | None
    abnormal: bool | None
    reason: Annotated[str, Field(min_length=1, max_length=500)] | None

    @model_validator(mode="after")
    def validate_bin(self):
        if not 0 < self.minKhz < self.maxKhz:
            raise ValueError("观测频段无效")
        if any(value is None for value in (self.occupancyPercent, self.powerDbm, self.abnormal)) and not self.unknownReasons:
            raise ValueError("未知观测必须保留原因")
        if self.abnormal is True and (self.reason is None or not self.reason.strip()):
            raise ValueError("异常频段必须保留原因")
        return self


class ImportedFrame(UnknownObservation):
    frameId: Identifier
    index: int = Field(ge=0, lt=MAX_FRAMES)
    observedAt: str | None
    label: str = Field(min_length=1, max_length=120)
    bins: list[SpectrumBin] = Field(min_length=1, max_length=MAX_BINS)
    occupancyPercent: Percent | None
    abnormalBandCount: Annotated[int, Field(ge=0, le=MAX_BINS)] | None

    @field_validator("observedAt")
    @classmethod
    def validate_time(cls, value):
        return utc_time(value) if value is not None else None

    @model_validator(mode="after")
    def validate_frame(self):
        if not self.label.strip() or len({item.binId for item in self.bins}) != len(self.bins):
            raise ValueError("帧标签为空或频段编号重复")
        if any(left.maxKhz > right.minKhz for left, right in zip(self.bins, self.bins[1:])):
            raise ValueError("频段须升序且不重叠")
        if any(item.abnormal is None for item in self.bins):
            if self.abnormalBandCount is not None:
                raise ValueError("未知异常标记不能汇总为已知计数")
        elif self.abnormalBandCount != sum(item.abnormal is True for item in self.bins):
            raise ValueError("异常计数与频段不一致")
        if any(value is None for value in (self.observedAt, self.occupancyPercent, self.abnormalBandCount)) and not self.unknownReasons:
            raise ValueError("未知帧字段必须保留原因")
        return self


class ObservationImportRequest(ObservationModel):
    schemaVersion: Literal[1]
    requestId: Identifier
    datasetId: Identifier
    dataOrigin: Literal["SYNTHETIC_INTEGRATION"]
    provenanceNote: str = Field(min_length=1, max_length=500)
    resourceRevision: Identifier
    deviceStatusSnapshotId: None
    source: SourceSnapshot
    frames: list[ImportedFrame] = Field(min_length=1, max_length=MAX_FRAMES)

    @field_validator("schemaVersion", mode="before")
    @classmethod
    def strict_version(cls, value):
        if type(value) is not int:
            raise ValueError("schemaVersion 须为整数 1")
        return value

    @model_validator(mode="after")
    def validate_dataset(self):
        if not self.provenanceNote.strip() or len({item.frameId for item in self.frames}) != len(self.frames):
            raise ValueError("构造来源为空或帧编号重复")
        previous = None
        for index, frame in enumerate(self.frames):
            if frame.index != index:
                raise ValueError("帧索引须从 0 连续排列")
            if frame.observedAt is not None:
                if previous is not None and frame.observedAt < previous:
                    raise ValueError("已知观测时间须按索引非递减")
                previous = frame.observedAt
            if any(item.minKhz < self.source.minKhz or item.maxKhz > self.source.maxKhz for item in frame.bins):
                raise ValueError("帧频段超出声明来源范围")
        return self


class DatasetSummary(ObservationModel):
    datasetId: Identifier
    datasetRevision: Revision
    schemaVersion: Literal[1]
    dataOrigin: Literal["SYNTHETIC_INTEGRATION"]
    provenanceNote: str = Field(min_length=1, max_length=500)
    resourceRevision: Identifier
    deviceStatusSnapshotId: None
    source: SourceSnapshot
    frameCount: int = Field(ge=1, le=MAX_FRAMES)
    firstObservedAt: str | None
    lastObservedAt: str | None
    importedAt: str
    contentHash: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("firstObservedAt", "lastObservedAt", "importedAt")
    @classmethod
    def validate_times(cls, value):
        return utc_time(value) if value is not None else None


class StoredFrame(ImportedFrame):
    datasetId: Identifier
    datasetRevision: Revision
    dataOrigin: Literal["SYNTHETIC_INTEGRATION"]


class ObservationImportReceipt(ObservationModel):
    requestId: Identifier
    actorId: str = Field(min_length=1, max_length=120)
    datasetId: Identifier
    datasetRevision: Revision
    dataOrigin: Literal["SYNTHETIC_INTEGRATION"]
    resourceRevision: Identifier
    frameCount: int = Field(ge=1, le=MAX_FRAMES)
    changed: bool
    importedAt: str


class ObservationPage(ObservationModel):
    page: int = Field(default=1, ge=1, le=9007199254740991)
    page_size: int = Field(default=20, ge=1, le=100)


class ObservationSelection(ObservationModel):
    dataset_id: Identifier
    dataset_revision: Revision


class ObservationFileDataset(ObservationModel):
    datasetId: Identifier
    provenanceNote: str = Field(min_length=1, max_length=500)
    resourceRevision: Identifier
    deviceStatusSnapshotId: None
    source: SourceSnapshot
    frames: list[ImportedFrame] = Field(min_length=1, max_length=MAX_FRAMES)

    @model_validator(mode="after")
    def complete_dataset(self):
        ObservationImportRequest.model_validate({"schemaVersion": 1, "requestId": "validation-only",
            "dataOrigin": ORIGIN, **self.model_dump(mode="json")})
        return self


class ObservationImportFile(ObservationModel):
    schemaVersion: Literal[1]
    fileKind: Literal["SPECTRUM_OBSERVATION_DATASET"]
    dataOrigin: Literal["SYNTHETIC_INTEGRATION"]
    dataset: ObservationFileDataset

    @field_validator("schemaVersion", mode="before")
    @classmethod
    def strict_version(cls, value):
        if type(value) is not int:
            raise ValueError("schemaVersion须为整数1")
        return value

    def to_request(self, request_id: str):
        return ObservationImportRequest.model_validate({"schemaVersion": 1, "requestId": request_id,
            "dataOrigin": ORIGIN, **self.dataset.model_dump(mode="json")})


class ObservationDeviceStatusRefInput(ObservationModel):
    snapshotId: str = Field(pattern=r"^DSS-[0-9a-f]{32}$")
    snapshotRevision: str = Field(pattern=r"^device-status-[0-9a-f]{64}$")
    resourceRevision: Identifier
    deviceIds: list[Identifier] = Field(min_length=1, max_length=1000)

    @field_validator("deviceIds")
    @classmethod
    def canonical_members(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("状态关联成员不得重复")
        return sorted(values)


class ObservationDeviceStatusRefWire(ObservationDeviceStatusRefInput):
    refRevision: str = Field(pattern=r"^OSR-[0-9a-f]{64}$")
    contentHash: str = Field(pattern=r"^[0-9a-f]{64}$")


class ObservationImportFileV2(ObservationImportFile):
    schemaVersion: Literal[2]
    deviceStatusRef: ObservationDeviceStatusRefInput


ImportFile = ObservationImportFile | ObservationImportFileV2


def parse_import_file(value):
    return TypeAdapter(ImportFile).validate_python(value.model_dump(mode="json") if isinstance(value, ObservationModel) else value)


class ObservationImportPreview(ObservationModel):
    file: ImportFile


class ObservationImportCommand(ObservationImportPreview):
    requestId: Identifier
    previewHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    datasetContentHash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def version_fields(self):
        if self.file.schemaVersion == 2 and self.datasetContentHash is None:
            raise ValueError("V2必须提供独立正文摘要")
        if self.file.schemaVersion == 1 and "datasetContentHash" in self.model_fields_set:
            raise ValueError("V1不接受V2摘要字段")
        return self
